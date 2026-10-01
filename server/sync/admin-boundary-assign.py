import argparse
import json
import os
import pathlib

import duckdb
import numpy
import shapely
from shapely import STRtree

parser = argparse.ArgumentParser()
parser.add_argument("--boundaries", required=True)
parser.add_argument("--input", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--format", required=True, choices=["overture-jsonl", "geofabrik-geojsonseq"])
args = parser.parse_args()

rows = duckdb.connect().execute(
    "SELECT role, priority, name, name_en, code, dataset, wkb, area FROM read_parquet(?)",
    [str(pathlib.Path(args.boundaries).resolve())],
).fetchall()
indexes = {}
for role in sorted({row[0] for row in rows}):
    selected = [row for row in rows if row[0] == role]
    geometries = shapely.from_wkb([bytes(row[6]) for row in selected])
    shapely.prepare(geometries)
    indexes[role] = (STRtree(geometries), geometries, selected)


def point(value):
    if args.format == "overture-jsonl":
        longitude, latitude = value.get("longitude"), value.get("latitude")
    else:
        geometry = value.get("geometry") or {}
        coordinates = []

        def visit(node):
            if (isinstance(node, list) and len(node) >= 2
                    and all(isinstance(item, (int, float)) for item in node[:2])):
                coordinates.append(node[:2])
            elif isinstance(node, list):
                for item in node:
                    visit(item)

        visit(geometry.get("coordinates"))
        if not coordinates:
            return None
        longitude = sum(item[0] for item in coordinates) / len(coordinates)
        latitude = sum(item[1] for item in coordinates) / len(coordinates)
    try:
        longitude, latitude = float(longitude), float(latitude)
    except (TypeError, ValueError):
        return None
    if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
        return None
    return longitude, latitude


def assign(batch):
    located = [(index, coordinates) for index, (_, coordinates) in enumerate(batch) if coordinates]
    results = [{} for _ in batch]
    if not located:
        return results
    points = shapely.points(numpy.array([coordinates for _, coordinates in located]))
    for role, (tree, geometries, selected) in indexes.items():
        point_indexes, polygon_indexes = tree.query(points, predicate="within")
        best = {}
        for point_index, polygon_index in zip(point_indexes.tolist(), polygon_indexes.tolist()):
            row = selected[polygon_index]
            rank = (row[1], row[7])
            if point_index not in best or rank < best[point_index][0]:
                best[point_index] = (rank, row)
        for point_index, (_, row) in best.items():
            results[located[point_index][0]][role] = {
                "name": row[2], "nameEn": row[3] or "", "code": row[4] or "", "dataset": row[5]
            }
    return results


output = pathlib.Path(args.output).resolve()
partial = pathlib.Path(f"{output}.{os.getpid()}.tmp")
assigned = 0
total = 0
with open(args.input, encoding="utf-8") as source, open(partial, "w", encoding="utf-8") as target:
    def flush(batch):
        global assigned
        for (value, _), boundary in zip(batch, assign(batch)):
            if boundary:
                value["admin_boundary"] = boundary
                assigned += 1
            target.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")

    batch = []
    for line in source:
        text = line.lstrip(chr(0x1E)).strip()
        if not text:
            continue
        value = json.loads(text)
        total += 1
        batch.append((value, point(value)))
        if len(batch) >= 20000:
            flush(batch)
            batch = []
    if batch:
        flush(batch)
partial.replace(output)
print(json.dumps({"event": "admin_boundaries_assigned", "records": total, "assigned": assigned}))
