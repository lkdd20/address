"""Postcodes from official address registers: an address takes the postcode of register addresses with the same house
number within the radius, and only when they all carry one postcode. Formats: Statistics Canada NAR (zip), IBGE CNEFE
(per-state zip), French BAN (csv.gz) and its OpenStreetMap counterpart BANO (headerless csv.gz).

Each register file is reduced once to a compact index (number, postcode, coordinates) next to it, so the per-batch
lookups that follow read that index instead of unpacking the register again."""
import argparse
import csv
import gzip
import pathlib
import re
import tempfile
import zipfile

import duckdb

parser = argparse.ArgumentParser()
parser.add_argument("--format", required=True, choices=["nar", "cnefe", "ban", "bano"])
parser.add_argument("--register", required=True, action="append")
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--radius-meters", type=float, default=60.0)
args = parser.parse_args()

INDEX_REVISION = "v1"
NUMBER_KEY = "regexp_replace(upper({}), '[^0-9A-Z]', '', 'g')"
BANO_COLUMNS = ("{'id': 'VARCHAR', 'numero': 'VARCHAR', 'voie': 'VARCHAR', 'cp': 'VARCHAR', 'ville': 'VARCHAR', "
                "'source': 'VARCHAR', 'lat': 'DOUBLE', 'lon': 'DOUBLE'}")


def sql_string(value):
    return "'" + str(value).replace("'", "''") + "'"


def csv_source(path, **options):
    settings = ", ".join(f"{key}={value}" for key, value in {"header": "true", "all_varchar": "true", "quote": "'\"'", **options}.items())
    return f"read_csv({sql_string(path)}, {settings})"


connection = duckdb.connect()
connection.execute("SET preserve_insertion_order=false")


def register_rows(register, directory):
    """SELECT statements yielding number_key, postcode, latitude, longitude for one register file."""
    if args.format == "bano":
        # A few OpenStreetMap rows carry stray carriage returns, which DuckDB always reads as line ends.
        cleaned = pathlib.Path(directory) / "bano.csv"
        with gzip.open(register, "rb") as source, open(cleaned, "wb") as target:
            while chunk := source.read(1 << 24):
                target.write(chunk.replace(b"\r", b""))
        yield f"""SELECT {NUMBER_KEY.format('numero')} AS number_key, trim(cp) AS postcode, lat AS latitude, lon AS longitude
            FROM read_csv({sql_string(cleaned)}, header=false, columns={BANO_COLUMNS}, delim=',', quote='"', escape='"')"""
        return
    if args.format == "ban":
        yield f"""SELECT {NUMBER_KEY.format("concat(numero, coalesce(rep, ''))")} AS number_key, trim(code_postal) AS postcode,
            CAST(lat AS DOUBLE) AS latitude, CAST(lon AS DOUBLE) AS longitude FROM {csv_source(register, delim="';'")}"""
        return
    with zipfile.ZipFile(register) as archive:
        names = [name for name in archive.namelist() if name.lower().endswith(".csv")]
        if args.format == "cnefe":
            for name in names:
                path = archive.extract(name, directory)
                # Level 1 coordinates locate the address itself; coarser levels fall back to block or tract centres.
                yield f"""SELECT {NUMBER_KEY.format("concat(NUM_ENDERECO, coalesce(DSC_MODIFICADOR, ''))")} AS number_key,
                    regexp_replace(CEP, '^([0-9]{{5}})([0-9]{{3}})$', '\\1-\\2') AS postcode,
                    CAST(LATITUDE AS DOUBLE) AS latitude, CAST(LONGITUDE AS DOUBLE) AS longitude
                  FROM {csv_source(path, delim="';'")} WHERE NV_GEO_COORD = '1' AND NUM_ENDERECO NOT IN ('', '0')"""
                pathlib.Path(path).unlink()
            return
        # NAR: every province's address parts join its location file on LOC_GUID.
        member = re.compile(r"(?:^|/)(Address|Location)_([0-9]+)(?:_part_[0-9]+)?\.csv$", re.IGNORECASE)
        kinds = {name: member.search(name) for name in names}
        for province in sorted({match.group(2) for match in kinds.values() if match}):
            def extract(kind):
                return [archive.extract(name, directory) for name, match in kinds.items()
                        if match and match.group(1).lower() == kind and match.group(2) == province]
            addresses, locations = extract("address"), extract("location")
            if addresses and locations:
                address_list = "[" + ",".join(sql_string(path) for path in addresses) + "]"
                location_list = "[" + ",".join(sql_string(path) for path in locations) + "]"
                yield f"""SELECT {NUMBER_KEY.format("concat(address.CIVIC_NO, coalesce(address.CIVIC_NO_SUFFIX, ''))")} AS number_key,
                    regexp_replace(upper(replace(address.MAIL_POSTAL_CODE, ' ', '')), '^([A-Z][0-9][A-Z])([0-9][A-Z][0-9])$', '\\1 \\2')
                      AS postcode,
                    CAST(location.BG_LATITUDE AS DOUBLE) AS latitude, CAST(location.BG_LONGITUDE AS DOUBLE) AS longitude
                  FROM read_csv({address_list}, header=true, all_varchar=true, union_by_name=true, delim=',', quote='"') address
                  JOIN read_csv({location_list}, header=true, all_varchar=true, union_by_name=true, delim=',', quote='"') location
                    ON location.LOC_GUID = address.LOC_GUID
                  WHERE coalesce(address.MAIL_POSTAL_CODE, '') <> ''"""
            for path in addresses + locations:
                pathlib.Path(path).unlink(missing_ok=True)


def index_for(register):
    index = pathlib.Path(f"{register}.postcodes-{INDEX_REVISION}.parquet")
    if index.exists():
        return index
    partial = pathlib.Path(f"{index}.partial")
    with tempfile.TemporaryDirectory(dir=index.parent) as directory:
        connection.execute("CREATE OR REPLACE TABLE staging (number_key VARCHAR, postcode VARCHAR, latitude DOUBLE, longitude DOUBLE)")
        for select_sql in register_rows(register, directory):
            connection.execute(f"""INSERT INTO staging SELECT * FROM ({select_sql})
                WHERE number_key <> '' AND postcode <> '' AND latitude IS NOT NULL AND longitude IS NOT NULL""")
        # Sorted by latitude so a batch's bounding box reads only the row groups around it.
        connection.execute(f"COPY (SELECT * FROM staging ORDER BY latitude, longitude) TO {sql_string(partial)} (FORMAT PARQUET)")
        connection.execute("DROP TABLE staging")
    partial.replace(index)
    return index


connection.execute(f"""CREATE TABLE points AS SELECT id, CAST(latitude AS DOUBLE) AS latitude, CAST(longitude AS DOUBLE) AS longitude,
    {NUMBER_KEY.format('CAST(number AS VARCHAR)')} AS number_key
  FROM read_csv({sql_string(args.input)}, header=true, all_varchar=true)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND trim(number) <> ''""")
bounds = connection.execute("SELECT min(latitude)-0.01, max(latitude)+0.01, min(longitude)-0.01, max(longitude)+0.01 FROM points").fetchone()
rows = []
if bounds[0] is not None:
    indexes = "[" + ",".join(sql_string(index_for(register)) for register in args.register) + "]"
    connection.execute(f"""CREATE TABLE register AS SELECT * FROM read_parquet({indexes})
        WHERE latitude BETWEEN {bounds[0]} AND {bounds[1]} AND longitude BETWEEN {bounds[2]} AND {bounds[3]}
          AND number_key IN (SELECT DISTINCT number_key FROM points)""")
    degrees = args.radius_meters / 111_320
    rows = connection.execute(f"""
      WITH near AS (
        SELECT points.id, register.postcode
        FROM points JOIN register ON register.number_key = points.number_key
          AND register.latitude BETWEEN points.latitude - {degrees} AND points.latitude + {degrees}
          AND register.longitude BETWEEN points.longitude - {degrees} / greatest(cos(radians(points.latitude)), 0.01)
            AND points.longitude + {degrees} / greatest(cos(radians(points.latitude)), 0.01)
        WHERE 2 * 6371000 * asin(sqrt(power(sin(radians(register.latitude - points.latitude) / 2), 2)
          + cos(radians(points.latitude)) * cos(radians(register.latitude))
            * power(sin(radians(register.longitude - points.longitude) / 2), 2))) <= {args.radius_meters}
      )
      SELECT id, min(postcode) FROM near GROUP BY id HAVING count(DISTINCT postcode) = 1
    """).fetchall()
with open(args.output, "w", newline="", encoding="utf-8") as target:
    writer = csv.writer(target)
    writer.writerow(["id", "postcode"])
    writer.writerows(rows)
