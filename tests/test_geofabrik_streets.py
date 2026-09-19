import json
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest


PATH = pathlib.Path(__file__).parents[1] / "server" / "sync" / "geofabrik-export.py"
MODULE = types.ModuleType("geofabrik_export")
sys.path.insert(0, str(PATH.parent))
try:
    exec(compile(PATH.read_text(encoding="utf-8").split("\nparser = argparse.ArgumentParser()", 1)[0], str(PATH), "exec"), MODULE.__dict__)
finally:
    sys.path.pop(0)


def road(identifier, tags):
    return types.SimpleNamespace(id=identifier, tags=[], nodes=[
        types.SimpleNamespace(location=types.SimpleNamespace(lon=x, lat=y, valid=lambda: True))
        for x, y in [(-89.651, 39.78), (-89.65, 39.78), (-89.65, 39.781)]
    ]), tags


def records(sampler):
    return [json.loads(value) for group in sampler.groups.values() for _, _, value in group["records"]]


class GeofabrikStreetTest(unittest.TestCase):
    def test_real_osmium_cli_reads_named_highways_and_preserves_precise_addresses(self):
        root = PATH.parents[2]
        (root / ".data-cache").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root / ".data-cache") as directory:
            source, output = pathlib.Path(directory) / "fixture.osm", pathlib.Path(directory) / "output.jsonl"
            source.write_text('''<osm version="0.6">
              <node id="1" lat="39.78" lon="-89.651" version="1"/>
              <node id="2" lat="39.78" lon="-89.65" version="1"/>
              <node id="3" lat="39.781" lon="-89.65" version="1"/>
              <node id="4" lat="39.78" lon="-89.65" version="1">
                <tag k="addr:housenumber" v="12"/><tag k="addr:street" v="Main Street"/>
                <tag k="addr:city" v="Springfield"/><tag k="shop" v="books"/><tag k="building" v="house"/>
              </node>
              <way id="1" version="1"><nd ref="1"/><nd ref="2"/><nd ref="3"/>
                <tag k="highway" v="residential"/><tag k="name" v="Main Street"/>
                <tag k="addr:city" v="Springfield"/><tag k="addr:state" v="Illinois"/>
              </way></osm>''', encoding="utf-8")
            subprocess.run([sys.executable, "-X", "utf8", str(PATH), "--input", str(source), "--output", str(output),
                            "--country", "US", "--max-records", "10", "--per-locality", "10"],
                           check=True, capture_output=True, text=True, timeout=30)
            values = [json.loads(line)["properties"] for line in output.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(len(values), 2)
            self.assertEqual(sum(value.get("match_level") == "street" for value in values), 1)
            self.assertEqual(sum(value.get("addr:housenumber") == "12" for value in values), 1)
            self.assertTrue(all("building" not in value and "residential_building_id" not in value for value in values))

    def test_named_roads_are_deduplicated_and_keep_a_point_on_the_geometry(self):
        sampler = MODULE.AddressSampler(10, 10, None, country="US")
        tags = {"highway": "residential", "name": "Main Street", "addr:state": "Illinois", "addr:city": "Springfield"}
        sampler.way(*road(1, tags))
        sampler.way(*road(2, tags))
        values = records(sampler)
        self.assertEqual(len(values), 1)
        self.assertEqual(values[0]["properties"]["match_level"], "street")
        self.assertEqual(values[0]["properties"]["addr:street"], "Main Street")
        self.assertNotIn("name", values[0]["properties"])
        self.assertNotIn("building", values[0]["properties"])
        longitude, latitude = values[0]["geometry"]["coordinates"]
        self.assertTrue(abs(longitude + 89.65) < 1e-10 or abs(latitude - 39.78) < 1e-10)

    def test_streets_do_not_weaken_china_or_accept_unsourced_localities(self):
        for country, tags in [("CN", {"addr:city": "Example City"}), ("US", {})]:
            sampler = MODULE.AddressSampler(10, 10, None, country=country)
            sampler.way(*road(1, {"highway": "residential", "name": "Main Street", **tags}))
            self.assertEqual(records(sampler), [])

    def test_preserves_non_residential_premises_without_claiming_residential_use(self):
        sampler = MODULE.AddressSampler(10, 10, None, country="US")
        sampler.capture("node", 1, {"addr:housenumber": "12", "addr:street": "Main Street",
                                   "addr:city": "Springfield", "building": "house", "shop": "books"}, -89.65, 39.78)
        values = records(sampler)
        self.assertEqual(len(values), 1)
        self.assertEqual(values[0]["properties"]["addr:housenumber"], "12")
        self.assertEqual(sampler.residential, [])
        self.assertNotIn("residential_building_id", values[0]["properties"])


if __name__ == "__main__":
    unittest.main()
