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
sys.path.insert(0, str(ROOT / "server" / "sync"))

from locality_quotas import LocalityWeights, allocate_quotas, fold_name  # noqa: E402


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


    def weighted_export(self, rows, weights, max_records):
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
        for identifier, state, city in rows:
            connection.execute("INSERT INTO fixture_addresses VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
                identifier, "US", [{"value": state}, {"value": city}] if city else [{"value": state}], city, "", "Main Street", "1", "",
                Point(-89.65, 39.78).wkt, {"xmin": -89.65, "xmax": -89.65, "ymin": 39.78, "ymax": 39.78},
                [{"dataset": "Fixture", "record_id": identifier}]
            ])
        connection.execute("ALTER TABLE fixture_addresses ALTER geometry TYPE GEOMETRY USING ST_GeomFromText(geometry)")

        class OfflineConnection:
            def execute(self, sql):
                if sql.startswith("INSTALL ") or (sql.startswith("SET ") and not sql.startswith("SET disabled_optimizers=")):
                    return self
                connection.execute(sql.replace("read_parquet('https://fixture.test/addresses', union_by_name=true)", "fixture_addresses"))
                return self

            def fetchall(self):
                return connection.fetchall()

        (ROOT / ".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT / ".data-cache") as directory:
            root = pathlib.Path(directory)
            assets, buildings, output, weights_file = [root / name for name in ("assets.json", "buildings.json", "output.jsonl", "weights.json")]
            assets.write_text(json.dumps(["https://fixture.test/addresses"]), encoding="utf-8")
            buildings.write_text("[]", encoding="utf-8")
            weights_file.write_text(json.dumps(weights), encoding="utf-8")
            argv = [str(SCRIPT), "--country", "US", "--release", "fixture", "--output", str(output),
                    "--max-records", str(max_records), "--per-locality", "1000", "--assets-file", str(assets),
                    "--building-assets-file", str(buildings), "--bounds", "-90", "39", "-89", "40",
                    "--locality-weights", str(weights_file)]
            with patch.object(sys, "argv", argv), patch.object(duckdb, "connect", return_value=OfflineConnection()):
                runpy.run_path(str(SCRIPT), run_name="__main__")
            return [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]

    def test_folds_names_like_the_catalog(self):
        self.assertEqual(fold_name("São Paulo"), "saopaulo")
        self.assertEqual(fold_name("Île-de-France"), "iledefrance")
        self.assertEqual(fold_name("Thành phố Hồ Chí Minh"), "thanhphohochiminh")
        self.assertEqual(fold_name("서울특별시"), "서울특별시")
        self.assertEqual(fold_name("東京都"), "東京都")

    def test_quotas_fill_baselines_then_popular_cities_then_population(self):
        weights = LocalityWeights({"baseline": 2, "cityLimit": 50, "places": [
            {"admin1": ["ca"], "locality": ["losangeles"], "population": 3_820_000, "popular": True, "dominant": True},
            {"admin1": ["ca"], "locality": ["fresno"], "population": 540_000, "popular": False, "dominant": True}
        ]})
        groups = [("CA", "Los Angeles", 400), ("CA", "Fresno", 100), ("CA", "Tiny", 100), ("CA", "Village", 1)]
        quotas = {entry["locality"]: entry["quota"] for entry in allocate_quotas(groups, 80, weights)}
        self.assertEqual(quotas["Los Angeles"], 50)
        self.assertEqual(quotas["Village"], 1)
        self.assertGreater(quotas["Fresno"], quotas["Tiny"])
        self.assertAlmostEqual(sum(quotas.values()), 80)
        larger = {entry["locality"]: entry["quota"] for entry in allocate_quotas(groups, 140, weights)}
        self.assertTrue(all(larger[name] >= quotas[name] for name in quotas))
        scaled = {entry["locality"]: entry["quota"] for entry in allocate_quotas(groups, 4, weights)}
        self.assertAlmostEqual(sum(scaled.values()), 4)

    def test_addresses_without_a_city_name_are_not_capped_like_one_city(self):
        weights = LocalityWeights({"baseline": 10, "cityLimit": 30_000, "places": []})
        quotas = allocate_quotas([("", "", 9_000_000)], 200_000, weights)
        self.assertAlmostEqual(quotas[0]["quota"], 200_000)
        mixed = {entry["locality"]: entry["quota"] for entry in allocate_quotas(
            [("NH", "", 900_000), ("NH", "Village", 500)], 50_000, weights)}
        self.assertAlmostEqual(mixed["Village"], 500)
        self.assertAlmostEqual(mixed[""], 49_500)

    def test_popular_metro_areas_share_one_city_limit_across_their_suburbs(self):
        weights = LocalityWeights({"baseline": 1, "cityLimit": 60, "places": [
            {"admin1": ["nsw"], "locality": ["sydney"], "population": 5_300_000, "popular": True, "dominant": True,
             "longitude": 151.21, "latitude": -33.87, "radiusKm": 36}]})
        groups = [("NSW", "SYDNEY", 50, 151.21, -33.87), ("NSW", "BONDI", 50, 151.27, -33.89),
                  ("NSW", "PARRAMATTA", 50, 151.00, -33.81), ("NSW", "DUBBO", 50, 148.60, -32.24)]
        entries = {entry["locality"]: entry for entry in allocate_quotas(groups, 120, weights)}
        metro = sum(entries[name]["quota"] for name in ("SYDNEY", "BONDI", "PARRAMATTA"))
        self.assertGreaterEqual(metro, 60)
        self.assertAlmostEqual(sum(entries[name]["popular_limit"] for name in ("SYDNEY", "BONDI", "PARRAMATTA")), 60)
        self.assertEqual(entries["DUBBO"]["popular_limit"], 0)
        self.assertGreater(entries["DUBBO"]["quota"], 1)
        self.assertAlmostEqual(entries["BONDI"]["popular_limit"], entries["PARRAMATTA"]["popular_limit"])

    def test_baselines_leave_room_for_popular_cities_in_countries_of_many_suburbs(self):
        weights = LocalityWeights({"baseline": 10, "cityLimit": 30_000, "places": [
            {"admin1": ["nsw"], "locality": ["sydney"], "population": 5_300_000, "popular": True, "dominant": True,
             "longitude": 151.21, "latitude": -33.87, "radiusKm": 36}]})
        groups = [("NSW", "SYDNEY", 40_000, 151.21, -33.87)]
        groups += [("NSW", f"TOWN {index}", 200, 148.0, -32.0) for index in range(10_000)]
        entries = allocate_quotas(groups, 90_000, weights)
        sydney = next(entry for entry in entries if entry["locality"] == "SYDNEY")
        towns = [entry for entry in entries if entry["locality"] != "SYDNEY"]
        self.assertAlmostEqual(sydney["quota"], 30_000)
        self.assertAlmostEqual(sydney["popular_limit"], 30_000)
        self.assertAlmostEqual(sum(entry["quota"] for entry in towns), 60_000)
        self.assertTrue(all(entry["quota"] > 3 for entry in towns))

    def test_shared_names_need_their_region_unless_one_place_dominates(self):
        weights = LocalityWeights({"places": [
            {"admin1": ["tx", "texas"], "locality": ["houston"], "population": 2_300_000, "popular": True, "dominant": True},
            {"admin1": ["ar", "arkansas"], "locality": ["houston"], "population": 150, "popular": False, "dominant": False},
            {"admin1": ["or"], "locality": ["portland"], "population": 650_000, "popular": True, "dominant": False},
            {"admin1": ["me"], "locality": ["portland"], "population": 68_000, "popular": False, "dominant": False}
        ]})
        self.assertEqual(weights.lookup("AR", "Houston"), (150, False))
        self.assertEqual(weights.lookup("TX", "Houston"), (2_300_000, True))
        self.assertEqual(weights.lookup("", "Houston"), (2_300_000, True))
        self.assertEqual(weights.lookup("", "Portland"), (68_000, False))
        self.assertEqual(weights.lookup("CA", "Unknown"), (0, False))

    def test_weighted_export_does_not_cap_addresses_without_a_city_name(self):
        rows = [(f"bag-{index}", "NH", "") for index in range(40)]
        values = self.weighted_export(rows, {"baseline": 1, "cityLimit": 5, "places": []}, 30)
        self.assertEqual(len(values), 30)
        self.assertTrue(all(value["locality"] == "" for value in values))

    def test_weighted_export_favors_popular_cities_and_keeps_earlier_picks(self):
        rows = [(f"la-{index}", "CA", "Los Angeles") for index in range(40)]
        rows += [(f"town{town}-{index}", "CA", f"Town {town}") for town in range(5) for index in range(6)]
        weights = {"baseline": 1, "cityLimit": 30, "places": [
            {"admin1": ["ca"], "locality": ["losangeles"], "population": 3_820_000, "popular": True, "dominant": True}]}
        small = self.weighted_export(rows, weights, 12)
        large = self.weighted_export(rows, weights, 20)
        self.assertEqual(len(small), 12)
        self.assertEqual(sum(value["locality"] == "Los Angeles" for value in small), 7)
        self.assertEqual({value["locality"] for value in small}, {"Los Angeles", *(f"Town {town}" for town in range(5))})
        self.assertTrue({value["id"] for value in small} <= {value["id"] for value in large})
        self.assertLessEqual(sum(value["locality"] == "Los Angeles" for value in large), 30)

    def test_weighted_export_writes_sampling_tier_and_rank(self):
        rows = [(f"la-{index}", "CA", "Los Angeles") for index in range(40)]
        rows += [(f"town{town}-{index}", "CA", f"Town {town}") for town in range(5) for index in range(6)]
        weights = {"baseline": 1, "cityLimit": 30, "places": [
            {"admin1": ["ca"], "locality": ["losangeles"], "population": 3_820_000, "popular": True, "dominant": True}]}
        values = self.weighted_export(rows, weights, 20)
        self.assertEqual(sorted(value["sampling_rank"] for value in values), list(range(1, 21)))
        ordered = sorted(values, key=lambda value: value["sampling_rank"])
        self.assertEqual([value["sampling_tier"] for value in ordered], sorted(value["sampling_tier"] for value in values))
        self.assertTrue(all(value["locality"] == "Los Angeles" for value in values if value["sampling_tier"] == 1))
        self.assertTrue(any(value["sampling_tier"] == 1 for value in values))

if __name__ == "__main__":
    unittest.main()
