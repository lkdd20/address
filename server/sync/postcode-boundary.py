import argparse
import csv
import pathlib
import shutil
import zipfile

import duckdb


def sql_string(value):
    return "'" + value.replace("'", "''") + "'"


parser = argparse.ArgumentParser()
parser.add_argument("--boundary-zip", required=True)
parser.add_argument("--field", required=True)
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()

if not args.field.replace("_", "").isalnum():
    raise ValueError("field must be a simple column name")
output_path = pathlib.Path(args.output).resolve()
work = output_path.parent / f"{output_path.name}.boundary"
shutil.rmtree(work, ignore_errors=True)
try:
    with zipfile.ZipFile(args.boundary_zip) as archive:
        for member in archive.namelist():
            if work.resolve() not in (work / member).resolve().parents:
                raise ValueError("boundary archive contains an unsafe path")
        archive.extractall(work)
    shapes = sorted(path for path in work.rglob("*.shp"))
    if len(shapes) != 1:
        raise ValueError("boundary archive must contain exactly one shapefile")
    connection = duckdb.connect()
    duckdb_home = output_path.parent / "duckdb-home"
    duckdb_home.mkdir(parents=True, exist_ok=True)
    connection.execute(f"SET home_directory={sql_string(str(duckdb_home))}")
    connection.execute("INSTALL spatial; LOAD spatial; SET threads=2; SET memory_limit='2GB'")
    connection.execute(f"SET temp_directory={sql_string(str(work / 'duckdb-temp'))}")
    connection.execute(f"""CREATE TABLE points AS SELECT id, CAST(longitude AS DOUBLE) AS longitude, CAST(latitude AS DOUBLE) AS latitude
        FROM read_csv({sql_string(args.input)}, header=true, columns={{'id': 'VARCHAR', 'longitude': 'DOUBLE', 'latitude': 'DOUBLE'}})""")
    connection.execute(f"""CREATE TABLE areas AS SELECT CAST({args.field} AS VARCHAR) AS code, geom::GEOMETRY AS geometry
        FROM st_read({sql_string(str(shapes[0]))}) WHERE {args.field} IS NOT NULL""")
    # A postcode is assigned only when exactly one area contains the address point.
    rows = connection.execute("""
        SELECT points.id, min(areas.code) AS code
        FROM points JOIN areas ON ST_Intersects(areas.geometry, ST_Point(points.longitude, points.latitude))
        GROUP BY points.id HAVING count(DISTINCT areas.code) = 1
    """).fetchall()
    with open(output_path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["id", "postcode"])
        writer.writerows(rows)
finally:
    shutil.rmtree(work, ignore_errors=True)
