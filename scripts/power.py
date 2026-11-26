"""Public, all-cause electricity interruption snapshots. Python standard library only."""

import csv
import io
import json
import math
import zipfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.client import HTTPException
from pathlib import Path
from urllib.request import Request, urlopen


SOURCE = "Power Out Map"
SOURCE_URL = "https://poweroutmap.com/"
API = SOURCE_URL + "api/v1"
MAX_AGE = timedelta(minutes=30)
MAX_CLOCK_SKEW = timedelta(minutes=2)
PAGE_SIZE = 500
# The public service has around 3,200 U.S. counties and county equivalents.
MAX_COUNTY_ROWS = 4_000
POINTS_FILE = Path(__file__).with_name("power_points.csv")

COVERAGE_NOTE = (
    "Independent aggregation of all-cause utility, state and ODIN reports. Weather attribution is unverified. "
    "Counts are electric customer accounts. Coverage varies by state. Some reports have "
    "no county assignment. Counties absent from the map have no mapped count. "
    "The provider can carry a utility's last reading for up to one hour."
)


def _iso(instant):
    return instant.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _instant(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if not isinstance(value, datetime) or value.utcoffset() is None:
        raise ValueError("A timestamp with a UTC offset is required.")
    return value.astimezone(timezone.utc)


def _get(path):
    request = Request(API + path, headers={
        "Accept": "application/json", "User-Agent": "WPC-IDSS-Media-Briefing-Dashboard/1.0",
    })
    with urlopen(request, timeout=12) as reply:
        payload = reply.read(1_000_001)
    if len(payload) > 1_000_000:
        raise ValueError("Oversized response.")
    return json.loads(payload)


def _request(path, now):
    try:
        raw = _get(path)
        stamp = _instant(raw["meta"]["updated"])
        if stamp > now + MAX_CLOCK_SKEW:
            return "unavailable", None, None
        if now - stamp > MAX_AGE:
            return "stale", _iso(stamp), None
        if "data" not in raw:
            return "unavailable", _iso(stamp), None
        return "current", _iso(stamp), raw
    except (ValueError, OSError, HTTPException, KeyError, TypeError, OverflowError):
        return "unavailable", None, None


def _count(value):
    if type(value) is int and value >= 0:
        return value
    return None


def _percentage(value):
    if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1:
        return round(value * 100, 2)
    return None


def _gazetteer_points(year, level):
    filename = f"{year}_Gaz_{level}_national"
    url = f"https://www2.census.gov/geo/docs/maps-data/data/gazetteer/{year}_Gazetteer/{filename}.zip"
    try:
        with urlopen(url, timeout=9) as reply:
            payload = reply.read(1_000_001)
        if len(payload) > 1_000_000:
            return {}
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            info = archive.getinfo(filename + ".txt")
            if info.file_size > 3_000_000:
                return {}
            lines = archive.read(info).decode("utf-8-sig").splitlines()
        records = csv.DictReader((line.strip() for line in lines), delimiter="|" if year == 2025 else "\t")
        return {r["GEOID"]: (r["USPS"], round(float(r["INTPTLAT"]), 3), round(float(r["INTPTLONG"]), 3))
                for r in records}
    except (OSError, HTTPException, ValueError, KeyError, zipfile.BadZipFile):
        return {}


def _load_points():
    lookup = {}
    try:
        with POINTS_FILE.open(encoding="utf-8", newline="") as file:
            for record in csv.DictReader(file):
                lookup[record["fips"]] = (record["state"], float(record["lat"]), float(record["lon"]))
    except (OSError, ValueError, KeyError):
        # A single-file installation can obtain the same coordinates from Census.
        with ThreadPoolExecutor(max_workers=3) as pool:
            jobs = [pool.submit(_gazetteer_points, year, level)
                    for year, level in [(2020, "counties"), (2025, "counties"), (2025, "state")]]
            for job in jobs:
                lookup.update(job.result())
    return lookup


def _empty(now):
    return {
        "status": "unavailable", "checked_at": _iso(now), "as_of": None, "stale_after": None,
        "source": SOURCE, "source_url": SOURCE_URL, "attribution": "Data from Power Out Map",
        "label": "Customers without power", "unit": "electric customer accounts",
        "coverage_note": COVERAGE_NOTE, "customers_out": None, "customers_tracked": None,
        "coverage_percent": None, "percent_out": None, "coverage_reference_customers": None,
        "reporting_utilities": None, "previous_reading_utilities": None,
        "affected_counties": None, "affected_states": None,
        "reporting_counties": None, "reporting_states": None,
        "history": {"status": "unavailable", "counts": []},
        "covered_states": None, "states_status": "unavailable", "states_as_of": None,
        "counties_status": "unavailable", "counties_as_of": None, "states": [], "counties": [],
        "links": [
            {"label": SOURCE, "url": SOURCE_URL},
            {"label": "Power Out Map reporting coverage", "url": SOURCE_URL + "live/sources/"},
            {"label": "DOE / ORNL ODIN", "url": "https://odin.ornl.gov/"},
            {"label": "PowerOutage.us national map", "url": "https://poweroutage.us/"},
        ],
    }


def _county_rows(now, points):
    path = "/outages/counties?limit=" + str(PAGE_SIZE)
    status, stamp, raw = _request(path + "&offset=0", now)
    if raw is None:
        return status, stamp, []
    count = _count(raw["meta"].get("count"))
    if count is None or count > MAX_COUNTY_ROWS:
        return "inconsistent", stamp, []
    rows, seen = [], set()
    for offset in range(0, max(1, count), PAGE_SIZE):
        if offset:
            status, page_stamp, raw = _request(path + "&offset=" + str(offset), now)
            if raw is None:
                return status, page_stamp, []
            if page_stamp != stamp:
                return "inconsistent", None, []
        meta, data = raw["meta"], raw["data"]
        if (meta.get("offset") != offset or meta.get("count") != count or not isinstance(data, list)
                or len(data) != min(PAGE_SIZE, count - offset)):
            return "inconsistent", stamp, []
        for item in data:
            if not isinstance(item, dict):
                return "inconsistent", stamp, []
            fips, name, state = item.get("fips"), item.get("name"), item.get("state")
            out = _count(item.get("customers_out"))
            if (not isinstance(fips, str) or len(fips) != 5 or not fips.isascii() or not fips.isdigit()
                    or fips in seen or not isinstance(name, str) or not name.strip()
                    or not isinstance(state, str) or len(state) != 2 or not state.isalpha()
                    or not state.isupper() or out is None or out == 0):
                return "inconsistent", stamp, []
            point = points.get(fips)
            if point is not None and point[0] != state:
                return "inconsistent", stamp, []
            seen.add(fips)
            rows.append({
                "fips": fips, "name": name, "state": state, "customers_out": out,
                # The source's county 'customers' field is modelled, not tracked.
                "customers_tracked": None, "percent_out": None,
                "lat": point[1] if point else None, "lon": point[2] if point else None,
            })
    rows.sort(key=lambda r: (-r["customers_out"], r["fips"]))
    return "current", stamp, rows


def _state_rows(raw, points, coverage):
    data = raw["data"]
    if (not isinstance(data, list) or not data or len(data) != raw["meta"].get("count")
            or len(data) > 60):
        return None
    state_points = {point[0]: (fips, *point[1:]) for fips, point in points.items() if len(fips) == 2}
    rows, seen = [], set()
    for item in data:
        if not isinstance(item, dict):
            return None
        state, name = item.get("state"), item.get("name")
        out = _count(item.get("customers_out"))
        if (not isinstance(state, str) or len(state) != 2 or not state.isalpha() or not state.isupper()
                or state in seen or not isinstance(name, str) or not name.strip() or out is None):
            return None
        seen.add(state)
        share = _percentage(item.get("coverage"))
        tracked = _count(coverage.get(state, {}).get("customers_tracked"))
        if out == 0 and not ((share is not None and share > 0) or (tracked is not None and tracked > 0)):
            out = None
        fips, lat, lon = state_points.get(state, (None, None, None))
        rows.append({
            "fips": fips, "name": name, "state": state, "customers_out": out,
            "customers_tracked": tracked, "coverage_percent": share, "percent_out": None,
            "affected_counties": None, "reporting_counties": None, "lat": lat, "lon": lon,
        })
    rows.sort(key=lambda r: (r["customers_out"] is None, -(r["customers_out"] or 0), r["state"]))
    return rows


def _history(status, stamp, raw):
    result = {"status": status, "as_of": stamp, "counts": []}
    if raw is None:
        return result
    result["status"] = "unavailable"
    data = raw.get("data")
    if not isinstance(data, dict) or data.get("step_minutes") != 15:
        return result
    counts = data.get("customers_out")
    if not isinstance(counts, list) or not (2 <= len(counts) <= 97):
        return result
    start = data.get("start")
    try:
        if type(start) in (int, float):
            start = datetime.fromtimestamp(start / 1000 if start > 10**11 else start, timezone.utc)
        first = _instant(start)
        last = first + timedelta(minutes=15 * (len(counts) - 1))
        end = _instant(stamp)
        if first > end or last > end + timedelta(minutes=15) or last < end - MAX_AGE:
            return result
    except (TypeError, ValueError, OSError, OverflowError):
        return result
    values = [_count(value) for value in counts]
    if sum(value is not None for value in values) < 2:
        return result
    result.update(status="current", start=_iso(first), step_minutes=15, counts=values)
    return result


def collect(now_utc):
    """Return a JSON-safe snapshot at an aware datetime or ISO time with UTC offset.

    The provider's reading time drives freshness for every layer. Missing data remain
    null, and a failed county page invalidates the complete county layer.
    """
    now = _instant(now_utc)
    result = _empty(now)
    status, stamp, raw = _request("/outages", now)
    result.update(status=status, as_of=stamp)
    if stamp:
        result["stale_after"] = _iso(_instant(stamp) + MAX_AGE)
    if raw is None:
        return result
    national = raw["data"]
    if not isinstance(national, dict):
        result["status"] = "unavailable"
        return result
    coverage = national.get("coverage")
    coverage = coverage if isinstance(coverage, dict) else {}
    tracked = _count(coverage.get("customers_tracked"))
    utilities = _count(national.get("utilities_reporting"))
    out = _count(national.get("customers_out"))
    if out is None or (out == 0 and not (tracked and utilities)):
        result["status"] = "unavailable"
        return result
    county_count = _count(national.get("counties_affected"))
    state_count = _count(national.get("states_affected"))
    result.update(
        customers_out=out, customers_tracked=tracked, coverage_percent=_percentage(coverage.get("share")),
        coverage_reference_customers=_count(coverage.get("customers")), reporting_utilities=utilities,
        affected_counties=county_count, affected_states=state_count,
        reporting_counties=county_count, reporting_states=state_count,
    )
    points = _load_points()
    with ThreadPoolExecutor(max_workers=4) as pool:
        history_job = pool.submit(_request, "/outages/history", now)
        state_job = pool.submit(_request, "/outages/states", now)
        coverage_job = pool.submit(_request, "/status", now)
        county_job = pool.submit(_county_rows, now, points)
        states_status, states_stamp, states_raw = state_job.result()
        _, coverage_stamp, coverage_raw = coverage_job.result()
        counties_status, counties_stamp, counties = county_job.result()
        result["history"] = _history(*history_job.result())

    status_data = coverage_raw["data"] if coverage_raw else {}
    if not isinstance(status_data, dict):
        status_data = {}
    if coverage_stamp == stamp:
        result["previous_reading_utilities"] = _count(status_data.get("utilities_on_previous_reading"))

    states = []
    if states_raw:
        state_coverage = {}
        if coverage_stamp == states_stamp and isinstance(status_data.get("states"), list):
            state_coverage = {row["state"]: row for row in status_data["states"]
                              if isinstance(row, dict) and isinstance(row.get("state"), str)}
        states = _state_rows(states_raw, points, state_coverage)
        if states is None:
            states_status, states = "inconsistent", []
    if counties_status == "current" and counties_stamp == stamp and county_count is not None:
        if len(counties) != county_count:
            counties_status, counties = "inconsistent", []
    if counties_status == "current" and states_status == "current" and states_stamp == counties_stamp:
        counts = Counter(row["state"] for row in counties)
        for state in states:
            if state["customers_out"] is not None:
                state["affected_counties"] = state["reporting_counties"] = counts[state["state"]]
    result.update(
        states_status=states_status, states_as_of=states_stamp, states=states,
        counties_status=counties_status, counties_as_of=counties_stamp, counties=counties,
        covered_states=(sum(bool((row["coverage_percent"] or 0) > 0 or row["customers_tracked"]) for row in states)
                        if any(row["coverage_percent"] is not None or row["customers_tracked"] is not None
                               for row in states) else None),
    )
    return result
