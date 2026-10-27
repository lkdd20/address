import csv
import gzip
import pathlib
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "server" / "sync" / "postcode-registers.py"


def run(register_format, registers, points, directory):
    source = directory / "points.csv"
    with open(source, "w", newline="", encoding="utf-8") as target:
        writer = csv.writer(target)
        writer.writerow(["id", "latitude", "longitude", "number"])
        writer.writerows(points)
    output = directory / "out.csv"
    command = [sys.executable, str(SCRIPT), "--format", register_format, "--input", str(source), "--output", str(output)]
    for register in registers:
        command += ["--register", str(register)]
    subprocess.run(command, check=True)
    with open(output, encoding="utf-8") as result:
        return {row["id"]: row["postcode"] for row in csv.DictReader(result)}


class PostcodeRegisterTests(unittest.TestCase):
    def test_ban_matches_the_same_number_nearby_and_skips_ambiguous_or_distant_points(self):
        with tempfile.TemporaryDirectory() as name:
            directory = pathlib.Path(name)
            register = directory / "adresses.csv.gz"
            with gzip.open(register, "wt", encoding="utf-8") as target:
                target.write("id;numero;rep;nom_voie;code_postal;nom_commune;lon;lat\n")
                target.write("a;12;bis;Rue Haute;75001;Paris;2.3400;48.8600\n")
                target.write("b;14;;Rue Haute;75001;Paris;2.3402;48.8601\n")
                target.write("c;14;;Rue Basse;75002;Paris;2.3403;48.8601\n")
                target.write("d;16;;Rue Haute;75001;Paris;2.3600;48.8700\n")
            found = run("ban", [register], [
                ("exact", 48.86001, 2.34001, "12 bis"),
                ("ambiguous", 48.8601, 2.3402, "14"),
                ("distant", 48.8600, 2.3400, "16"),
                ("other-number", 48.8600, 2.3400, "99")
            ], directory)
            self.assertEqual(found, {"exact": "75001"})

    def test_bano_reads_the_headerless_openstreetmap_file(self):
        with tempfile.TemporaryDirectory() as name:
            directory = pathlib.Path(name)
            register = directory / "full.csv.gz"
            with gzip.open(register, "wt", encoding="utf-8") as target:
                target.write("010010005-103,103,Impasse des Acacias,01400,L'Abergement-Clémenciat,OSM,46.147615,4.924047\n")
                target.write("592560615-13\r,13\r,Chemin de la Tour,59273,Fretin,OSM,50.555337,3.13897\n")
                target.write('111950045-14,14,"Rue de la ""M""",11400,Laurabuc,OSM,43.247571,1.980337\n')
            found = run("bano", [register], [("acacias", 46.14762, 4.92405, "103"), ("fretin", 50.55534, 3.13897, "13"),
                                             ("laurabuc", 43.24757, 1.98034, "14")], directory)
            self.assertEqual(found, {"acacias": "01400", "fretin": "59273", "laurabuc": "11400"})

    def test_cnefe_uses_address_level_coordinates_and_formats_the_cep(self):
        with tempfile.TemporaryDirectory() as name:
            directory = pathlib.Path(name)
            register = directory / "12_AC.zip"
            rows = "COD_UF;CEP;NUM_ENDERECO;DSC_MODIFICADOR;LATITUDE;LONGITUDE;NV_GEO_COORD\n" \
                   "12;69900126;444;;-9.972736;-67.819202;1\n" \
                   "12;69900999;500;;-9.972736;-67.819202;4\n"
            with zipfile.ZipFile(register, "w") as archive:
                archive.writestr("12_AC.csv", rows)
            found = run("cnefe", [register], [("store", -9.97274, -67.81920, "444"), ("tract", -9.97274, -67.81920, "500")], directory)
            self.assertEqual(found, {"store": "69900-126"})

    def test_nar_joins_locations_and_formats_canadian_postal_codes(self):
        with tempfile.TemporaryDirectory() as name:
            directory = pathlib.Path(name)
            register = directory / "nar.zip"
            with zipfile.ZipFile(register, "w") as archive:
                archive.writestr("Addresses/Address_35_part_1.csv",
                                 "LOC_GUID,CIVIC_NO,CIVIC_NO_SUFFIX,MAIL_MUN_NAME,MAIL_POSTAL_CODE\n"
                                 "L1,123,A,Ottawa,K1P1J1\nL2,7,,\"GLENCOE, RESTIGOUCHE COUNTY\",\n")
                archive.writestr("Locations/Location_35.csv", "LOC_GUID,BG_LATITUDE,BG_LONGITUDE\nL1,45.4215,-75.6972\nL2,45.4215,-75.6972\n")
            found = run("nar", [register], [("ottawa", 45.42151, -75.69721, "123A"), ("no-code", 45.4215, -75.6972, "7")], directory)
            self.assertEqual(found, {"ottawa": "K1P 1J1"})


if __name__ == "__main__":
    unittest.main()
