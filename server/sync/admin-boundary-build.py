import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import urllib.request
import zipfile

import duckdb

parser = argparse.ArgumentParser()
parser.add_argument("--country", required=True)
parser.add_argument("--config-file", required=True)
parser.add_argument("--cache-dir", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--overture-release")
args = parser.parse_args()

country = args.country.upper()
if not country.isalpha() or len(country) != 2:
    raise ValueError("country must be an ISO alpha-2 code")
config = json.loads(pathlib.Path(args.config_file).read_text(encoding="utf-8"))
cache = pathlib.Path(args.cache_dir).resolve()
downloads = cache / "downloads"
downloads.mkdir(parents=True, exist_ok=True)
output = pathlib.Path(args.output).resolve()
work = output.parent / f"{output.stem}.{os.getpid()}.tmp"
shutil.rmtree(work, ignore_errors=True)
work.mkdir(parents=True)


def sql_string(value):
    return "'" + str(value).replace("'", "''") + "'"


def download(url, suffix):
    target = downloads / (hashlib.sha256(url.encode("utf-8")).hexdigest()[:24] + suffix)
    if target.is_file() and pathlib.Path(f"{target}.complete").is_file():
        return target
    partial = pathlib.Path(f"{target}.{os.getpid()}.tmp")
    subprocess.run(["curl", "-4", "-fsSL", "--retry", "3", "--retry-delay", "10", "--connect-timeout", "30",
                    "--max-time", "3600", "-o", str(partial), url], check=True)
    partial.replace(target)
    pathlib.Path(f"{target}.complete").write_text(hashlib.sha256(target.read_bytes()).hexdigest(), encoding="utf-8")
    return target


duckdb_home = cache / "duckdb-home"
duckdb_home.mkdir(parents=True, exist_ok=True)
connection = duckdb.connect(str(work / "build.duckdb"))
connection.execute(f"SET home_directory={sql_string(duckdb_home.as_posix())}")
connection.execute("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
connection.execute("SET memory_limit='2GB'")
connection.execute(f"SET temp_directory={sql_string((work / 'duckdb-temp').as_posix())}")
connection.execute("SET http_retries=10")
connection.execute("""
CREATE TABLE boundaries (
  role VARCHAR, priority INTEGER, name VARCHAR, name_en VARCHAR, code VARCHAR, dataset VARCHAR, geom GEOMETRY
)""")


def insert(dataset, layer, priority, relation, crs=None):
    name = layer["name"]
    name_en = layer.get("nameEn") or ""
    code = layer.get("code") or ""
    geometry = "geom" if not crs else f"ST_Transform(geom, {sql_string(crs)}, 'EPSG:4326', always_xy := true)"
    connection.execute(f"""
INSERT INTO boundaries
SELECT {sql_string(layer['role'])}, {priority},
  trim(CAST("{name}" AS VARCHAR)),
  {f'trim(CAST("{name_en}" AS VARCHAR))' if name_en else "''"},
  {f'CAST("{code}" AS VARCHAR)' if code else "''"},
  {sql_string(dataset['id'])},
  ST_MakeValid({geometry})
FROM {relation}
WHERE nullif(trim(CAST("{name}" AS VARCHAR)), '') IS NOT NULL AND geom IS NOT NULL
""")


for dataset_index, dataset in enumerate(config["datasets"]):
    kind = dataset["kind"]
    for layer in dataset["layers"]:
        priority = dataset_index * 10 + int(layer.get("priority", 0))
        if kind == "zip-shapefile":
            archive = download(dataset["url"], ".zip")
            member = layer["member"]
            extracted = work / member
            extracted.mkdir(exist_ok=True)
            with zipfile.ZipFile(archive) as bundle:
                for entry in bundle.namelist():
                    stem = pathlib.PurePosixPath(entry)
                    if stem.stem == member and stem.suffix.lower() in {".shp", ".shx", ".dbf", ".prj", ".cpg"}:
                        (extracted / stem.name).write_bytes(bundle.read(entry))
            shapefile = extracted / f"{member}.shp"
            if not shapefile.is_file():
                raise ValueError(f"{dataset['id']} is missing shapefile layer {member}")
            insert(dataset, layer, priority, f"ST_Read({sql_string(shapefile.as_posix())})")
        elif kind == "geojson":
            source = download(dataset["url"], ".geojson")
            insert(dataset, layer, priority, f"ST_Read({sql_string(source.as_posix())})")
        elif kind == "parquet":
            source = download(dataset["url"], ".parquet")
            geometry_column = dataset.get("geometry", "geometry")
            relation = f"(SELECT * EXCLUDE ({geometry_column}), {geometry_column}::GEOMETRY AS geom FROM read_parquet({sql_string(source.as_posix())}))"
            insert(dataset, layer, priority, relation, dataset.get("crs"))
        elif kind == "overture-divisions":
            if not args.overture_release:
                raise ValueError("overture-divisions requires --overture-release")
            language = layer.get("language")
            name = f"coalesce(nullif(trim(names.common[{sql_string(language)}]), ''), names.primary)" if language else "names.primary"
            subtypes = ",".join(sql_string(value) for value in layer["subtypes"])
            ordering = " ".join(f"WHEN {sql_string(value)} THEN {index}" for index, value in enumerate(layer["subtypes"]))
            connection.execute(f"""
INSERT INTO boundaries
SELECT {sql_string(layer['role'])}, {priority} + CASE subtype {ordering} ELSE 9 END,
  trim({name}), coalesce(trim(names.common['en']), ''), CAST(division_id AS VARCHAR),
  {sql_string(dataset['id'])}, ST_MakeValid(geometry)
FROM read_parquet({sql_string(f's3://overturemaps-us-west-2/release/{args.overture_release}/theme=divisions/type=division_area/*')},
  hive_partitioning=1)
WHERE country = {sql_string(country)} AND subtype IN ({subtypes}) AND is_land
  AND nullif(trim({name}), '') IS NOT NULL AND geometry IS NOT NULL
""")
        else:
            raise ValueError(f"unsupported boundary dataset kind: {kind}")

connection.execute("DELETE FROM boundaries WHERE geom IS NULL OR ST_IsEmpty(geom) OR ST_Dimension(geom) <> 2")
counts = dict(connection.execute("SELECT role, count(*) FROM boundaries GROUP BY role").fetchall())
if not counts:
    raise ValueError(f"no administrative boundaries were built for {country}")
partial = pathlib.Path(f"{output}.{os.getpid()}.tmp")
connection.execute(f"""
COPY (SELECT role, priority, name, name_en, code, dataset, ST_AsWKB(geom) AS wkb, ST_Area(geom) AS area FROM boundaries)
TO {sql_string(partial.as_posix())} (FORMAT PARQUET)
""")
connection.close()
partial.replace(output)
pathlib.Path(f"{output}.json").write_text(json.dumps({"country": country, "counts": counts}), encoding="utf-8")
shutil.rmtree(work, ignore_errors=True)
print(json.dumps({"event": "admin_boundaries_built", "country": country, "counts": counts}))
