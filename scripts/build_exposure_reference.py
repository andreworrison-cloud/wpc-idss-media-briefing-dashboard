"""Rebuild the reviewed Census 2020 and NWS public forecast zone resident-center index."""

from __future__ import annotations

import argparse
import csv
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import tempfile
from urllib.request import urlopen

import numpy as np

from exposure_reference import (
    CENSUS,
    DEFAULT_DIR,
    DTYPE,
    STATE_FIPS,
    ZONE_CATALOG,
    Centers,
    pack,
    read_zone_memberships,
)

FILES = {
    "cenpop-national.txt": (
        "https://www2.census.gov/geo/docs/reference/cenpop2020/blkgrp/CenPop2020_Mean_BG.txt",
        "e4a7ebbf07a8a8d846cea9d2daeb600dea50b1ec2d7703909e40d45c013cd63a",
    ),
    "cenpop-states.txt": (
        "https://www2.census.gov/geo/docs/reference/cenpop2020/CenPop2020_Mean_ST.txt",
        "af37e0d68c617f417ef805a94c07cbb0f788863e3cc4db21a3b35f28766f2f06",
    ),
    "z_16ap26.zip": (
        "https://www.weather.gov/source/gis/Shapefiles/WSOM/z_16ap26.zip",
        "010dc5eab64b6e326c969e252bd016f56a037b0444df8303658707bca4cc7fd8",
    ),
}


def get_raw(cache, name):
    path = cache / name
    if not path.exists():
        with urlopen(FILES[name][0], timeout=75) as response:
            path.write_bytes(response.read())
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != FILES[name][1]:
        raise ValueError(f"Review source revision before changing the SHA-256 for {name}")
    return raw


def save_part(out, name, raw):
    (out / name).write_text(pack(raw), encoding="ascii")
    return {"name": name, "sha256": hashlib.sha256(raw).hexdigest()}


def read_rows(raw):
    return csv.DictReader(io.StringIO(raw.decode("utf-8-sig")))


def build(cache, out):
    out.mkdir(parents=True, exist_ok=True)
    st = {r["STATEFP"]: int(r["POPULATION"]) for r in read_rows(get_raw(cache, "cenpop-states.txt"))}
    places = {}
    pop = Counter()
    all_groups = Counter()
    occupied = Counter()
    for r in read_rows(get_raw(cache, "cenpop-national.txt")):
        state = r["STATEFP"]
        components = [r[f] for f in ("STATEFP", "COUNTYFP", "TRACTCE", "BLKGRPCE")]
        if [len(i) for i in components] != [2, 3, 6, 1] or not all(i.isdecimal() for i in components):
            raise ValueError("Unexpected Census GEOID")
        key = int("".join(components))
        n = int(r["POPULATION"])
        if n < 0 or key in places:
            raise ValueError("Invalid population or repeated GEOID")
        # The published six decimal places are exact integers in microdegrees.
        lon = int(r["LONGITUDE"].replace(".", ""))
        lat = int(r["LATITUDE"].replace(".", ""))
        if (
            len(r["LONGITUDE"].split(".")[-1]) != 6
            or len(r["LATITUDE"].split(".")[-1]) != 6
            or abs(lat) > 90e6
            or abs(lon) > 180e6
        ):
            raise ValueError("Unexpected Census coordinate")
        places[key] = (key, lon, lat, n)
        all_groups[state] += 1
        pop[state] += n
        occupied[state] += int(n > 0)
    if set(st) != set(STATE_FIPS) or dict(pop) != st or sum(st.values()) != 334735155 or st["72"] != 3285874:
        raise ValueError("Jurisdiction population benchmarks failed")
    records = np.array([places[k] for k in sorted(places) if places[k][3]], dtype=DTYPE)
    centers = Centers(records)
    result = {
        "census_url": CENSUS,
        "source_files": {n: {"url": u, "sha256": h} for n, (u, h) in FILES.items()},
        "populated_centers": len(records),
        "all_block_groups": len(places),
        "resident_population": sum(st.values()),
        "jurisdictions": {
            STATE_FIPS[k]: {
                "population": st[k],
                "populated_centers": occupied[k],
                "block_groups": all_groups[k],
            }
            for k in st
        },
        "parts": [],
    }
    for i, sub in enumerate(range(0, len(records), 40000)):
        result["parts"].append(
            save_part(out, f"census-{i + 1:02d}.xz.b64", records[sub : sub + 40000].tobytes())
        )
    zone_file = "z_16ap26.zip"
    zone_ids, feature_count, repairs = read_zone_memberships(centers, get_raw(cache, zone_file), zone_file)
    covered = set().union(*zone_ids.values())
    absent = np.array(sorted(set(range(len(records))) - covered), dtype="int64")
    # Indices refer to the national ordered Census record array, preserving deduplication across zones.
    raw = json.dumps({k: sorted(v) for k, v in sorted(zone_ids.items())}, separators=(",", ":")).encode(
        "ascii"
    )
    result["zones"] = {
        **save_part(out, "forecast-zones.xz.b64", raw),
        "catalog_url": ZONE_CATALOG,
        "filename": zone_file,
        "effective": "2026-04-16",
        "md5": "004dc6501dc3d50e7b36652cb9d02bd3",
        "features": feature_count,
        "covered_codes": len(zone_ids),
        "topology_repairs": repairs,
        "centers_outside_all_zones": len(absent),
        "residents_represented_outside_all_zones": int(centers.population[absent].sum()),
    }
    (out / "manifest.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, help="Cache for source downloads")
    parser.add_argument("--output", type=Path, default=DEFAULT_DIR)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        cache = args.source_dir or Path(tmp)
        cache.mkdir(parents=True, exist_ok=True)
        data = build(cache, args.output)
        print(
            f"{data['populated_centers']:,} populated block groups and {data['zones']['covered_codes']:,} NWS public zones"
        )
