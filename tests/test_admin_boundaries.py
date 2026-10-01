import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

import duckdb
import shapely
from shapely.geometry import box


ROOT = pathlib.Path(__file__).parents[1]
ASSIGN = ROOT / "server" / "sync" / "admin-boundary-assign.py"
BUILD = ROOT / "server" / "sync" / "admin-boundary-build.py"


def write_boundaries(path, rows):
    connection = duckdb.connect()
    connection.execute("""CREATE TABLE b (role VARCHAR, priority INTEGER, name VARCHAR, name_en VARCHAR,
      code VARCHAR, dataset VARCHAR, wkb BLOB, area DOUBLE)""")
    for role, priority, name, geometry in rows:
        connection.execute("INSERT INTO b VALUES (?,?,?,?,?,?,?,?)",
                           [role, priority, name, f"{name} EN", f"{name}-code", "fixture", shapely.to_wkb(geometry), geometry.area])
    connection.execute(f"COPY b TO '{path.as_posix()}' (FORMAT PARQUET)")
    connection.close()


class AdminBoundaryTest(unittest.TestCase):
    def run_script(self, *args):
        return subprocess.run([sys.executable, "-X", "utf8", *map(str, args)],
                              check=True, capture_output=True, text=True, timeout=120)

    def test_assigns_highest_priority_smallest_polygon_and_leaves_outside_points(self):
        (ROOT / ".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT / ".data-cache") as directory:
            root = pathlib.Path(directory)
            boundaries = root / "b.parquet"
            write_boundaries(boundaries, [
                ("district", 0, "Barangay Small", box(120.0, 14.0, 120.1, 14.1)),
                ("district", 0, "Barangay Large", box(119.9, 13.9, 120.5, 14.5)),
                ("district", 10, "Fallback Hood", box(120.0, 14.0, 120.05, 14.05)),
                ("locality", 0, "Quezon City", box(119.0, 13.0, 121.0, 15.0)),
            ])
            points = root / "points.jsonl"
            points.write_text("\n".join(json.dumps(value) for value in [
                {"id": "inside", "longitude": 120.02, "latitude": 14.02},
                {"id": "large-only", "longitude": 120.3, "latitude": 14.3},
                {"id": "outside", "longitude": 0, "latitude": 0},
                {"id": "invalid", "longitude": "x", "latitude": 14.0},
            ]) + "\n", encoding="utf-8")
            output = root / "out.jsonl"
            self.run_script(ASSIGN, "--boundaries", boundaries, "--input", points, "--output", output,
                            "--format", "overture-jsonl")
            values = {value["id"]: value for value in map(json.loads, output.read_text(encoding="utf-8").splitlines())}
        self.assertEqual(values["inside"]["admin_boundary"]["district"]["name"], "Barangay Small")
        self.assertEqual(values["inside"]["admin_boundary"]["locality"],
                         {"name": "Quezon City", "nameEn": "Quezon City EN", "code": "Quezon City-code", "dataset": "fixture"})
        self.assertEqual(values["large-only"]["admin_boundary"]["district"]["name"], "Barangay Large")
        self.assertNotIn("admin_boundary", values["outside"])
        self.assertNotIn("admin_boundary", values["invalid"])

    def test_reads_geojson_sequence_centroids(self):
        (ROOT / ".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT / ".data-cache") as directory:
            root = pathlib.Path(directory)
            boundaries = root / "b.parquet"
            write_boundaries(boundaries, [("district", 0, "Odunpazarı", box(30.0, 39.0, 31.0, 40.0))])
            feature = {"type": "Feature", "properties": {"addr:street": "X"},
                       "geometry": {"type": "Polygon", "coordinates": [[[30.5, 39.5], [30.6, 39.5], [30.6, 39.6], [30.5, 39.5]]]}}
            points = root / "points.geojsonseq"
            points.write_text("\x1e" + json.dumps(feature) + "\n", encoding="utf-8")
            output = root / "out.jsonl"
            self.run_script(ASSIGN, "--boundaries", boundaries, "--input", points, "--output", output,
                            "--format", "geofabrik-geojsonseq")
            value = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(value["admin_boundary"]["district"]["name"], "Odunpazarı")
        self.assertEqual(value["properties"], {"addr:street": "X"})

    def test_builds_normalized_boundaries_from_geojson(self):
        (ROOT / ".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT / ".data-cache") as directory:
            root = pathlib.Path(directory)
            source = root / "districts.geojson"
            source.write_text(json.dumps({"type": "FeatureCollection", "features": [
                {"type": "Feature", "properties": {"name_ar": "حي العمل", "name_en": "Al Amal", "district_id": 10100003001},
                 "geometry": shapely.geometry.mapping(box(46.7, 24.6, 46.8, 24.7))},
                {"type": "Feature", "properties": {"name_ar": " ", "name_en": "Blank", "district_id": 2},
                 "geometry": shapely.geometry.mapping(box(46.8, 24.6, 46.9, 24.7))},
            ]}), encoding="utf-8")
            config = root / "config.json"
            config.write_text(json.dumps({"revision": 1, "datasets": [{
                "id": "fixture", "kind": "geojson", "url": source.resolve().as_uri(),
                "layers": [{"role": "district", "name": "name_ar", "nameEn": "name_en", "code": "district_id"}]
            }]}), encoding="utf-8")
            output = root / "SA.parquet"
            self.run_script(BUILD, "--country", "SA", "--config-file", config, "--cache-dir", root / "cache",
                            "--output", output)
            rows = duckdb.connect().execute(
                "SELECT role, name, name_en, code, dataset FROM read_parquet(?)", [str(output)]).fetchall()
        self.assertEqual(rows, [("district", "حي العمل", "Al Amal", "10100003001", "fixture")])


if __name__ == "__main__":
    unittest.main()
