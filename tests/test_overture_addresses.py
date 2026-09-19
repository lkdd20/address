import json
import csv
import io
import pathlib
import runpy
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

import duckdb
from shapely.geometry import Point


ROOT = pathlib.Path(__file__).parents[1]
SCRIPT = ROOT / "server" / "sync" / "overture-export.py"


class OvertureAddressTest(unittest.TestCase):
    def test_openaddresses_archive_keeps_real_streets_and_numbers_without_postcodes(self):
        fields = ["id", "number", "street", "district", "locality", "admin1", "postcode", "longitude", "latitude"]
        content = io.StringIO()
        writer = csv.DictWriter(content, fieldnames=fields)
        writer.writeheader()
        for identifier, number, longitude in [("street", "", -89.65), ("street-copy", "", -89.66), ("premise", "12", -89.65)]:
            writer.writerow({"id": identifier, "number": number, "street": "Main Street", "locality": "Springfield",
                             "admin1": "Illinois", "district": "Central", "postcode": "", "longitude": longitude, "latitude": 39.78})
        (ROOT / ".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT / ".data-cache") as directory:
            root = pathlib.Path(directory)
            archive, mapping, output = [root / name for name in ("fixture.zip", "mapping.json", "output.jsonl")]
            with zipfile.ZipFile(archive, "w") as destination:
                destination.writestr("fixture.csv", content.getvalue())
            mapping.write_text(json.dumps({field: field for field in fields}), encoding="utf-8")
            subprocess.run([sys.executable, "-X", "utf8", str(ROOT / "server/sync/openaddresses-export.py"),
                            "--input", str(archive), "--member", "fixture.csv", "--mapping-file", str(mapping),
                            "--country", "US", "--output", str(output), "--max-records", "10", "--per-locality", "10"],
                           check=True, capture_output=True, text=True, timeout=30)
            values = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(values), 2)
        self.assertEqual(sorted(value["number"] for value in values), ["", "12"])
        self.assertTrue(all(value["postcode"] == "" for value in values))

    def export(self, classified, candidate_input=False):
        connection = duckdb.connect()
        self.addCleanup(connection.close)
        extension_root = (ROOT / ".data-cache" / "duckdb-extensions").as_posix().replace("'", "''")
        connection.execute(f"SET extension_directory='{extension_root}'")
        try:
            connection.execute("LOAD spatial")
        except duckdb.Error:
            self.skipTest("Install the pinned DuckDB spatial extension into .data-cache/duckdb-extensions")
        connection.execute("""CREATE TABLE fixture_addresses(id VARCHAR,country VARCHAR,
            address_levels STRUCT(value VARCHAR)[],postal_city VARCHAR,postcode VARCHAR,street VARCHAR,
            number VARCHAR,unit VARCHAR,geometry VARCHAR,bbox STRUCT(xmin DOUBLE,xmax DOUBLE,ymin DOUBLE,ymax DOUBLE),
            sources STRUCT(dataset VARCHAR,record_id VARCHAR)[])""")
        values = []
        for identifier, number, x, y in [("home", "12", -89.65, 39.78), ("unknown", "14", -89.66, 39.79),
                                          ("street", "", -89.65, 39.78), ("street-copy", "", -89.655, 39.785)]:
            connection.execute("INSERT INTO fixture_addresses VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
                identifier, "US", [{"value": "Illinois"}, {"value": "Springfield"}], "Springfield", "",
                "Main Street", number, "", Point(x, y).wkt,
                {"xmin": x, "xmax": x, "ymin": y, "ymax": y}, [{"dataset": "Fixture", "record_id": identifier}]
            ])
            values.append({"id": identifier, "country": "US", "admin1": "Illinois", "locality": "Springfield",
                           "postal_city": "Springfield", "district": "", "address_levels": ["Illinois", "Springfield"],
                           "postcode": "", "street": "Main Street", "number": number, "unit": "",
                           "longitude": x, "latitude": y, "source_dataset": "Fixture", "source_record_id": identifier})
        connection.execute("""CREATE TABLE fixture_buildings AS SELECT 'building' AS id,'apartments' AS class,
            'POLYGON ((-89.651 39.779,-89.649 39.779,-89.649 39.781,-89.651 39.781,-89.651 39.779))' AS geometry,
            {'xmin':-89.651,'xmax':-89.649,'ymin':39.779,'ymax':39.781} AS bbox""")
        for table in ("fixture_addresses", "fixture_buildings"):
            connection.execute(f"ALTER TABLE {table} ALTER geometry TYPE GEOMETRY USING ST_GeomFromText(geometry)")

        class OfflineConnection:
            def execute(self, sql):
                if sql.startswith("INSTALL ") or (sql.startswith("SET ") and not sql.startswith("SET disabled_optimizers=")):
                    return self
                sql = sql.replace("read_parquet('https://fixture.test/addresses', union_by_name=true)", "fixture_addresses")
                sql = sql.replace("read_parquet('https://fixture.test/buildings', union_by_name=true)", "fixture_buildings")
                connection.execute(sql)
                return self

            def fetchall(self):
                return connection.fetchall()

        (ROOT / ".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT / ".data-cache") as directory:
            root = pathlib.Path(directory)
            assets, buildings, output, candidates = [root / name for name in ("assets.json", "buildings.json", "output.jsonl", "candidates.jsonl")]
            assets.write_text(json.dumps(["https://fixture.test/addresses"]), encoding="utf-8")
            buildings.write_text(json.dumps(["https://fixture.test/buildings"] if classified else []), encoding="utf-8")
            candidates.write_text("".join(json.dumps(value) + "\n" for value in values), encoding="utf-8")
            argv = [str(SCRIPT), "--country", "US", "--release", "fixture", "--output", str(output),
                    "--max-records", "10", "--per-locality", "10", "--assets-file", str(assets),
                    "--building-assets-file", str(buildings), "--bounds", "-90", "39", "-89", "40"]
            if candidate_input:
                argv += ["--candidate-jsonl", str(candidates)]
            with patch.object(sys, "argv", argv), patch.object(duckdb, "connect", return_value=OfflineConnection()):
                runpy.run_path(str(SCRIPT), run_name="__main__")
            self.assertEqual(connection.execute("SELECT current_setting('disabled_optimizers')").fetchone()[0], "")
            return [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]

    def test_classification_retains_unmatched_premises_and_deduplicated_streets(self):
        values = self.export(True)
        self.assertEqual(len(values), 3)
        by_id = {value["id"]: value for value in values}
        self.assertEqual(by_id["home"]["property_type"], "apartment")
        self.assertEqual(by_id["unknown"]["property_type"], "unknown")
        street = next(value for value in values if value["match_level"] == "street")
        self.assertEqual(street["property_type"], "unknown")
        self.assertEqual(street["residential_building_id"], "")
        self.assertEqual(street["number"], "")

    def test_candidate_and_fallback_paths_keep_actual_precision_without_residential_claims(self):
        for candidate_input in (False, True):
            with self.subTest(candidate_input=candidate_input):
                values = self.export(False, candidate_input)
                self.assertEqual(len(values), 3)
                self.assertEqual(sum(value["match_level"] == "street" for value in values), 1)
                self.assertTrue(all(value["property_type"] == "unknown" for value in values))


if __name__ == "__main__":
    unittest.main()
