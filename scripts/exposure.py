"""Resident exposure for public CAP/WPC geometries, with source validity and UTC windows."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
import gzip
import hashlib
import json
import lzma
import os
from pathlib import Path
import re
import struct
import tempfile
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import zipfile

import numpy as np

from exposure_reference import (
    CENSUS,
    DEFAULT_DIR,
    FIPS_BY_CODE,
    ZONE_CATALOG,
    load_reference,
    read_zone_memberships,
    unpack,
)

UTC = timezone.utc
SOURCE_AGE = {
    "alerts": 30,
    "ero": 90,
    "winter": 180,
    "outlook": 240,
}  # Mirrors the board's public source health windows, in minutes.
ERO = {1: "Marginal", 2: "Slight", 3: "Moderate", 4: "High"}
WSSI = {3: "Moderate", 4: "Major", 5: "Extreme"}
SUPPORTED_REGIONS = {
    "contiguous u.s.",
    "contiguous us",
    "conus",
    "alaska",
    "hawaii",
    "puerto rico",
    "district of columbia",
}
# These long-duration products warn entire identified public forecast zones. Storm-based
# warnings lacking a published polygon must never expand to all overlapping zones/counties.
ZONAL = {
    "blizzard warning",
    "coastal flood warning",
    "extreme cold warning",
    "extreme heat warning",
    "excessive heat warning",
    "freeze warning",
    "hard freeze warning",
    "high surf warning",
    "high wind warning",
    "ice storm warning",
    "lake effect snow warning",
    "lakeshore flood warning",
    "wind chill warning",
    "winter storm warning",
}
ZONE_URL = re.compile(r"https://api\.weather\.gov/zones/forecast/([A-Z]{2}Z\d{3})\Z")
LAND_WARNING = re.compile(r"\b(?:warning|emergency)\b", re.I)
MARINE_ONLY = {
    "heavy freezing spray warning",
    "hazardous seas warning",
    "special marine warning",
    "gale warning",
    "storm warning",
    "hurricane force wind warning",
}
WSSI_LAYER = "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/wpc_wssi/MapServer/4"
AVAILABLE = {"current", "partial"}
METHOD = (
    "Each populated 2020 Census block group contributes its resident count when its mean population center lies inside or on a mapped footprint. "
    "Counts estimate residents in the issuance area. Narrow boundaries and changes since 2020 can affect estimates. "
    "Each hazard and validity period is counted separately. People may appear in multiple rows."
)


def _dt(value):
    try:
        parsed = (
            value
            if isinstance(value, datetime)
            else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        )
        return parsed.astimezone(UTC) if parsed.tzinfo else None
    except (TypeError, ValueError, OverflowError):
        return None


def _iso(value):
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z") if value else None


def _day(value):
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def _ends(*values):
    times = [v for x in values if (v := _dt(x)) is not None]
    return _iso(min(times)) if times else None


def _slug(text):
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")


def source_state(board, key, now):
    src = board.get("sources", {}).get(key) or {}
    health = (board.get("health") or {}).get(key) or {}
    tried = (board.get("attempts") or {}).get(key) or {}
    stamp = health.get("retrieved_at") or src.get("retrieved_at")
    if not stamp and key == "ero" and src.get("days"):
        stamp = src["days"][0].get("retrieved_at")
    fetched = _dt(stamp)
    status = (
        health.get("status")
        or src.get("status")
        or ("ok" if key == "ero" and src.get("days") else "unavailable")
    )
    if (
        not fetched
        or not src
        or status not in ("ok", "current", "partial", "stale")
        or fetched > now + timedelta(minutes=5)
    ):
        return "unavailable", stamp, None
    expires = fetched + timedelta(minutes=SOURCE_AGE[key])
    if now >= expires or tried.get("retained") or health.get("retained") or status == "stale":
        return "stale", stamp, _iso(expires)
    return (
        ("partial" if status == "partial" or src.get("status") == "partial" else "current"),
        stamp,
        _iso(expires),
    )


def catalog_edition(html, now):
    versions = []
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", html, re.I | re.S):
        name = re.search(
            r'\bhref=["\'](?:https://www\.weather\.gov)?/source/gis/Shapefiles/WSOM/(z_[0-9]{2}[a-z]{2}[0-9]{2}\.zip)["\']',
            row,
            re.I,
        )
        checksum = re.search(r"\b([0-9a-f]{32})\b", row, re.I)
        effective = re.search(r"\b(\d{1,2} [A-Z][a-z]+ 20\d{2})\b", row)
        if not name:
            continue
        if not effective or not checksum:
            return None
        try:
            start = datetime.strptime(effective.group(1), "%d %B %Y").date()
        except ValueError:
            return None
        # The catalogue supplies dates. A change-day switchover hour can vary by office.
        if start == now.date():
            return None
        if start <= now.date():
            versions.append((start, name.group(1).lower(), checksum.group(1).lower()))
    if not versions:
        return None
    latest = max(versions)
    if any(v[0] == latest[0] and v != latest for v in versions):
        return None
    return {"effective": latest[0].isoformat(), "filename": latest[1], "md5": latest[2]}


def _get_catalog():
    request = Request(
        ZONE_CATALOG,
        headers={
            "User-Agent": "WPC-IDSS public weather briefing (github.com/andreworrison-cloud/wpc-idss-media-briefing-dashboard)"
        },
    )
    try:
        with urlopen(request, timeout=8) as response:
            raw = response.read(500001)
        return raw.decode("utf-8") if len(raw) <= 500000 else ""
    except (OSError, URLError, ValueError, UnicodeError):
        return ""


def _current_zone_ids(centers, edition, wanted, cache_dir):
    """Read only the selected zones from a new official edition. Caches contain reviewed public ZIP bytes."""
    stamp = edition["md5"]
    path = Path(cache_dir) / f"{edition['filename'][:-4]}-{stamp}.zip" if cache_dir else None
    raw = None
    if path and path.is_file() and path.stat().st_size <= 70_000_000:
        candidate = path.read_bytes()
        if hashlib.md5(candidate, usedforsecurity=False).hexdigest() == stamp:
            raw = candidate
    if raw is None:
        request = Request(
            "https://www.weather.gov/source/gis/Shapefiles/WSOM/" + edition["filename"],
            headers={"User-Agent": "WPC-IDSS-Dashboard/1.0"},
        )
        with urlopen(request, timeout=30) as response:
            raw = response.read(70_000_001)
        if len(raw) > 70_000_000 or hashlib.md5(raw, usedforsecurity=False).hexdigest() != stamp:
            raise ValueError("NWS forecast zone archive differs from the published release")
        if path:
            temp_path = None
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
                    temp_path = Path(tmp.name)
                    tmp.write(raw)
                os.replace(temp_path, path)
            except OSError:
                pass
            finally:
                if temp_path is not None:
                    temp_path.unlink(missing_ok=True)
    from shapefile import ShapefileException

    try:
        zones, _, _ = read_zone_memberships(centers, raw, edition["filename"], wanted)
    except (ShapefileException, struct.error, IndexError) as exc:
        raise ValueError("Unsupported NWS forecast zone archive") from exc
    return zones


@dataclass
class Coverage:
    ranks: dict = field(default_factory=lambda: defaultdict(set))
    valid: int = 0
    missing: int = 0
    repairs: int = 0

    def polygon(self, centers, geometry, rank=1):
        ids, good, bad, repairs = centers.intersect(geometry)
        self.ranks[rank].update(ids)
        self.valid += good
        self.missing += bad
        self.repairs += repairs

    def include(self, other):
        for rank, ids in other.ranks.items():
            self.ranks[rank].update(ids)
        self.valid += other.valid
        self.missing += other.missing
        self.repairs += other.repairs


def _stats(centers, ids):
    a = np.fromiter(ids, dtype="int64", count=len(ids))
    return int(centers.population[a].sum()), centers.state_rows(a)


def _record(centers, meta, coverage, state, note, levels=None):
    if state in AVAILABLE and coverage.missing:
        state = "partial" if coverage.valid else "unavailable"
    result = {
        **meta,
        "status": state,
        "population": None,
        "mapped_population": None,
        "states": [],
        "bands": [],
        "coverage": note,
    }
    if coverage.missing:
        result["coverage"] += f" Coverage is incomplete for {coverage.missing} source component(s)."
    if coverage.repairs:
        result["repaired_components"] = coverage.repairs
    if state not in AVAILABLE:
        return result
    higher = set()
    bands = []
    for rank in sorted(levels or coverage.ranks, reverse=True):
        ids = coverage.ranks.get(rank, set())
        exclusive = ids - higher
        higher.update(ids)
        if levels:
            n, states = _stats(centers, exclusive)
            cumulative, cumul_states = _stats(centers, higher)
            band = {
                "id": _slug(levels[rank]),
                "label": levels[rank],
                "rank": rank,
                "population": None,
                "at_or_above": None,
                "states": states,
                "at_or_above_states": cumul_states,
            }
            if state == "current":
                band.update(population=n, at_or_above=cumulative)
                if n == 0:
                    band["zero_basis"] = (
                        "no_center_in_exclusive_band" if rank in coverage.ranks else "no_band_footprint"
                    )
            else:
                band.update(mapped_population=n or None, mapped_at_or_above=cumulative or None)
            bands.append(band)
    count, states = _stats(centers, higher)
    result.update(states=states, bands=bands[::-1])
    if state == "current":
        result["population"] = count
        if count == 0:
            if coverage.valid:
                result["zero_basis"] = "no_populated_center_in_footprint"
                result["coverage"] += (
                    " No populated block-group center matched. Small communities, individual residents and travelers can still be present."
                )
            else:
                result["zero_basis"] = "no_qualifying_footprint"
    else:
        result["mapped_population"] = count or None
    return result


def _features(centers, features, levels, prop):
    c = Coverage()
    if not isinstance(features, list):
        c.missing += 1
        return c
    ranks = {label.lower(): r for r, label in levels.items()}
    for f in features:
        if not isinstance(f, dict):
            c.missing += 1
            continue
        props = f.get("properties") or {}
        rank = ranks.get(str(props.get(prop, "")).lower())
        if not rank or (prop == "risk" and props.get("rank") != rank):
            c.missing += 1
            continue
        c.polygon(centers, f.get("geometry"), rank)
    return c


def _ero(board, now, centers, health):
    module_state, observed, expires = health
    days = {
        d.get("day"): d
        for d in board.get("sources", {}).get("ero", {}).get("days", [])
        if isinstance(d, dict)
    }
    result = []
    for n in range(1, 6):
        d = days.get(n, {})
        state = module_state
        end, fresh_until = _dt(d.get("valid_end")), _dt(d.get("fresh_until"))
        if d.get("status") != "current" or not _dt(d.get("valid_start")) or not end or not fresh_until:
            state = "stale" if d.get("status") == "stale" else "unavailable"
        elif min(end, fresh_until) <= now:
            state = "stale"
        elif module_state == "partial":
            # Each ERO day has independently verified issue, validity, categories and geometry.
            state = "current"
        feat = d.get("features")
        c = Coverage()
        if state in AVAILABLE:
            c = _features(centers, feat, ERO, "risk")
            if not feat and d.get("no_risk_area") is not True:
                c.missing += 1
            if feat and d.get("no_risk_area") is True:
                c.missing += 1
        meta = {
            "id": f"ero-d{n}",
            "label": f"Day {n} excessive rainfall",
            "day": n,
            "family": "Flood",
            "issued": d.get("issued"),
            "as_of": d.get("retrieved_at") or observed,
            "valid_start": d.get("valid_start"),
            "valid_end": d.get("valid_end"),
            "fresh_until": _ends(expires, d.get("fresh_until"), d.get("valid_end")),
            "source_url": d.get("source_url"),
            "feature_indices": list(range(len(feat or []))),
        }
        note = "Contiguous U.S. WPC outlook. Each center is assigned to its highest mapped risk in this forecast day."
        if feat == [] and d.get("no_risk_area") is True and state == "current":
            note = "WPC explicitly maps no risk area for this forecast day."
        result.append(_record(centers, meta, c, state, note, ERO))
    return result


def _download_wssi_native():
    query = urlencode(
        {
            "where": "impact IN ('MODERATE','MAJOR','EXTREME')",
            "outFields": "objectid,product,component,impact,issue_time,start_time,end_time",
            "outSR": "4326",
            "returnGeometry": "true",
            "f": "geojson",
        }
    )
    request = Request(
        WSSI_LAYER + "/query?" + query,
        headers={"Accept": "application/json", "User-Agent": "WPC-IDSS-Dashboard/1.0"},
    )
    with urlopen(request, timeout=20) as response:
        raw = response.read(64_000_001)
    if len(raw) > 64_000_000:
        raise ValueError("WSSI download exceeded the collector size limit")
    return json.loads(raw)


def _wssi_fingerprint(w):
    cycle = {key: w.get(key) for key in ("issued", "valid_start", "valid_end", "features")}
    return hashlib.sha256(json.dumps(cycle, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _wssi_native(w, native):
    """Use full-resolution polygons for the exact issuance, valid window, feature IDs and displayed boundaries."""
    expected = {}
    for feature in w["features"]:
        stamp, object_id = feature["id"].rsplit("/", 1)
        if _dt(stamp) != _dt(w["issued"]) or int(object_id) in expected:
            raise ValueError("Unexpected WSSI feature ID")
        expected[int(object_id)] = feature["properties"]["impact"]
    if native is not None:
        return _validate_wssi_native(w, native, expected)
    cache_dir = os.environ.get("IDSS_WSSI_CACHE_DIR")
    path = Path(cache_dir) / "native.json.gz" if cache_dir else None
    key = _wssi_fingerprint(w)
    if path and path.is_file():
        try:
            with gzip.open(path, "rb") as cached:
                blob = cached.read(64_000_001)
            if len(blob) <= 64_000_000:
                previous = json.loads(blob)
                if previous.get("key") == key:
                    result = _validate_wssi_native(w, previous["source"], expected)
                    (path.parent / "confirmed-key").write_text(key)
                    return result
        except (OSError, EOFError, ValueError, KeyError, TypeError):
            pass
    for attempt in range(2):
        try:
            source = _download_wssi_native()
            result = _validate_wssi_native(w, source, expected)
            break
        except (OSError, ValueError, KeyError, TypeError):
            if attempt:
                raise
    if path:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = json.dumps({"key": key, "source": source}, separators=(",", ":")).encode()
            if len(payload) <= 64_000_000:
                with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
                    stream.write(gzip.compress(payload, compresslevel=3, mtime=0))
                os.replace(stream.name, path)
                (path.parent / "confirmed-key").write_text(key)
        except OSError:
            pass  # The validated live data can still be used without a persistent cache.
    return result


def _validate_wssi_native(w, native, expected):
    if (
        not isinstance(native, dict)
        or native.get("type") != "FeatureCollection"
        or not isinstance(native.get("features"), list)
        or not isinstance(native.get("properties", {}), dict)
        or native.get("error")
        or native.get("exceededTransferLimit")
        or (native.get("properties") or {}).get("exceededTransferLimit")
    ):
        raise ValueError("Incomplete WSSI layer")
    result = []
    for f in native["features"]:
        p = f["properties"]
        ident = p["objectid"]
        if not isinstance(ident, int) or ident not in expected or expected[ident].upper() != p["impact"]:
            raise ValueError("WSSI layer feature mismatch")
        if p["component"] != "WSSI_OVERALL" or p["product"] != "WINTER STORM SEVERITY INDEX":
            raise ValueError("Unexpected WSSI component")
        issued = datetime.strptime(p["issue_time"], "%Y-%m-%d %H%MZ").replace(tzinfo=UTC)

        def valid_time(value):
            for fmt in ("%HZ %m/%d/%y", "%HZ %m/%d/%Y"):
                try:
                    return datetime.strptime(value, fmt).replace(tzinfo=UTC)
                except ValueError:
                    continue
            raise ValueError("Invalid WSSI validity")

        if (issued, valid_time(p["start_time"]), valid_time(p["end_time"])) != tuple(
            _dt(w[k]) for k in ("issued", "valid_start", "valid_end")
        ):
            raise ValueError("WSSI source cycles differ")
        result.append({"properties": {"impact": expected.pop(ident)}, "geometry": f["geometry"]})
    if expected:
        raise ValueError("Missing WSSI feature")
    return result


def _winter(board, now, centers, health, native):
    state, observed, expires = health
    w = board.get("sources", {}).get("winter") or {}
    end, issued = _dt(w.get("valid_end")), _dt(w.get("issued"))
    edition_end = _iso(issued + timedelta(hours=6)) if issued else None
    if not end or not issued or issued > now or not _dt(w.get("valid_start")):
        state = "unavailable"
    elif min(end, _dt(edition_end)) <= now:
        state = "stale"
    feat = w.get("features")
    c = Coverage()
    note = "Contiguous U.S. Day 1–3 overall WSSI. Counts cover Moderate, Major and Extreme impact areas over the published window."
    if state in AVAILABLE:
        if isinstance(feat, list) and feat:
            try:
                c = _features(centers, _wssi_native(w, native), WSSI, "impact")
                note += " Analysis uses full-resolution GIS polygons matched to this WPC issue."
            except (OSError, URLError, TypeError, ValueError, KeyError):
                c.missing += 1
                note += " Full-resolution GIS polygons could not be matched to the WPC issue."
        elif feat != [] or str(w.get("highest_impact", "")).lower() not in (
            "none",
            "minor",
            "winter weather area",
            "no moderate or greater area",
        ):
            c.missing += 1
    meta = {
        "id": "wssi-d1-3",
        "label": "Winter Storm Severity Index",
        "family": "Winter",
        "issued": w.get("issued"),
        "as_of": observed,
        "valid_start": w.get("valid_start"),
        "valid_end": w.get("valid_end"),
        "fresh_until": _ends(expires, w.get("valid_end"), edition_end),
        "source_url": w.get("source_url"),
        "analysis_source_url": WSSI_LAYER,
        "feature_ids": [f.get("id") for f in feat or [] if isinstance(f, dict) and f.get("id")],
    }
    return [_record(centers, meta, c, state, note, WSSI)]


def _outlook(board, now, centers, health):
    module_state, observed, expires = health
    w = board.get("sources", {}).get("outlook") or {}
    groups = {g.get("id"): g for g in w.get("groups", []) if isinstance(g, dict)}
    sets = defaultdict(list)
    for f in w.get("features") or []:
        if not isinstance(f, dict):
            continue
        p = f.get("properties") or {}
        sets[
            (
                p.get("group") or "unknown",
                p.get("hazard") or "Unclassified area",
                p.get("valid_start_date") or "",
                p.get("valid_end_date") or "",
            )
        ].append(f)
    result = []
    for (group, title, start, end), feat in sorted(sets.items()):
        status = module_state
        group_status = groups.get(group, {}).get("status")
        if status in AVAILABLE and group_status:
            status = {"ok": "current", "current": "current", "partial": "partial"}.get(
                group_status, "unavailable"
            )
        first, last = _day(start), _day(end)
        if not first or not last or first > last:
            status = "unavailable"
        elif last < now.date():
            status = "stale"
        c = Coverage()
        regions = sorted({str((f.get("properties") or {}).get("region") or "Unspecified") for f in feat})
        if status in AVAILABLE:
            for f in feat:
                p = f.get("properties") or {}
                region_parts = set(str(p.get("region") or "").lower().split(" and "))
                if region_parts.difference(SUPPORTED_REGIONS):
                    c.missing += 1
                if region_parts.isdisjoint(SUPPORTED_REGIONS):
                    continue
                c.polygon(centers, f.get("geometry"))
        p = feat[0].get("properties") or {}
        end_utc = _iso(datetime.combine(last + timedelta(days=1), time.min, UTC)) if last else None
        meta = {
            "id": f"outlook-{_slug(title)}-{start}-{end}",
            "label": title,
            "family": p.get("family"),
            "issued": w.get("issued_date"),
            "as_of": observed,
            "valid_start": start or None,
            "valid_end": end or None,
            "fresh_until": _ends(expires, end_utc),
            "regions": regions,
            "source_url": p.get("source_url") or w.get("source_url"),
            "feature_ids": [f.get("id") or (f.get("properties") or {}).get("id") for f in feat],
        }
        result.append(
            _record(
                centers,
                meta,
                c,
                status,
                "WPC Days 3–7 hazard areas with this hazard and these inclusive valid dates.",
            )
        )
    return result


def _active(e, now):
    start, end = _dt(e.get("effective")), _dt(e.get("expires"))
    if not start or not end or not start <= now < end:
        return False
    ends = e.get("ends")
    return not ends or bool(_dt(ends) and now < _dt(ends))


def _zone_coverage(c, event, zones):
    wanted = set(event.get("ugc") or [])
    if not wanted or not zones:
        c.missing += 1
        return
    linked = {
        match.group(1)
        for u in event.get("zone_urls") or []
        if isinstance(u, str) and (match := ZONE_URL.fullmatch(u))
    }
    verified = wanted.intersection(linked, zones)
    c.missing += len(wanted - verified)
    for code in verified:
        c.ranks[1].update(zones[code])
        c.valid += 1


def _event_coverage(centers, event, zones, now):
    c = Coverage()
    segments = event.get("segments")
    basis = "NWS warning polygon"
    if segments:
        live = [s for s in segments if _active(s, now)]
        if not live:
            return None, None
        # The aggregate event geometry may include expired warning segments. Only use
        # published, per-segment geometries if some source segments are no longer live.
        if len(live) < len(segments):
            for segment in live:
                geometries = segment.get("geometry") or []
                if isinstance(geometries, dict):
                    geometries = [geometries]
                if not geometries:
                    c.missing += 1
                for g in geometries:
                    c.polygon(centers, g)
            return c, basis
    geometries = event.get("geometry") or []
    if isinstance(geometries, dict):
        geometries = [geometries]
    if geometries:
        for g in geometries:
            c.polygon(centers, g)
        status = str(event.get("geometry_status", "")).lower()
        if "partial" in status or "incomplete" in status:
            c.missing += 1
    elif str(event.get("title") or "").lower() in ZONAL:
        basis = "NWS public forecast zones"
        _zone_coverage(c, event, zones)
    else:
        c.missing += 1
    return c, basis


def _alerts(board, now, centers, health, zones):
    status, observed, expires = health
    a = board.get("sources", {}).get("alerts") or {}
    by_type = defaultdict(list)
    selected = {}
    grouped = []
    for e in a.get("events") or []:
        if (
            not isinstance(e, dict)
            or not e.get("id")
            or not LAND_WARNING.search(str(e.get("title", "")))
            or str(e.get("family", "")).lower() == "marine"
            or str(e.get("title") or "").lower() in MARINE_ONLY
        ):
            continue
        if not _active(e, now):
            continue
        c, basis = (
            _event_coverage(centers, e, zones, now)
            if status in AVAILABLE
            else (Coverage(), "NWS warning footprint")
        )
        if c is None:
            continue
        states = set(e.get("states") or [])
        if not states or states.difference(FIPS_BY_CODE):
            c.missing += 1
        end = _ends(e.get("expires"), e.get("ends"))
        # An aggregate with any remaining reconciled segments may change before final event expiration.
        segment_ends = [
            _ends(s.get("ends"), s.get("expires")) for s in e.get("segments", []) if _active(s, now)
        ]
        fresh = _ends(expires, end, *segment_ends)
        meta = {
            "id": e["id"],
            "label": e["title"],
            "family": e.get("family"),
            "area": e.get("area"),
            "as_of": observed,
            "valid_start": e.get("effective"),
            "valid_end": end,
            "fresh_until": fresh,
            "source_url": e.get("source_url"),
            "basis": basis,
            "states_listed": sorted(states),
        }
        note = (
            "Residents in the NWS issuance zone. Coastal and other broad warning zones may extend well beyond the hazard itself."
            if basis == "NWS public forecast zones"
            else "Residents inside the available NWS warning polygon."
        )
        if basis == "NWS public forecast zones" and not zones:
            note += " The current zone boundary edition could not be verified."
        if e.get("ffe") is True:
            live_segments = [segment for segment in e.get("segments") or [] if _active(segment, now)]
            entire = bool(live_segments) and all(segment.get("ffe") is True for segment in live_segments)
            meta["emergency_scope"] = "all_active_segments" if entire else "full_warning_only"
            if not entire:
                note += " The estimate covers the full warning. The emergency designation can apply to a smaller area."
        selected[e["id"]] = _record(centers, meta, c, status, note)
        by_type[e["title"]].append((meta, c))
    for title, events in sorted(by_type.items()):
        c = Coverage()
        for _, item in events:
            c.include(item)
        basis = sorted({meta["basis"] for meta, _ in events})
        earliest = _ends(*(meta["fresh_until"] for meta, _ in events))
        meta = {
            "id": "alert-" + _slug(title),
            "label": title,
            "family": events[0][0]["family"],
            "as_of": observed,
            "valid_start": _iso(now),
            "valid_end": _ends(*(meta["valid_end"] for meta, _ in events)),
            "fresh_until": earliest,
            "source_url": a.get("source_url"),
            "alert_ids": [meta["id"] for meta, _ in events],
            "basis": " / ".join(basis),
        }
        note = f"{len(events)} active NWS warning record(s). Overlapping issuance areas are counted once for this warning type."
        if "NWS public forecast zones" in basis:
            note += " Population in the full warning zones can include residents outside the location of expected effects."
        grouped.append(_record(centers, meta, c, status, note))
    return grouped, selected


@lru_cache(maxsize=3)
def _load(folder):
    return load_reference(folder)


def collect(
    board,
    now_utc=None,
    *,
    reference_dir=DEFAULT_DIR,
    zone_catalog_html=None,
    wssi_native=None,
    zone_cache_dir=None,
):
    """Return public, JSON-safe data. Optional official zone HTML and native WSSI JSON support deterministic replays."""
    now = _dt(now_utc) if now_utc is not None else datetime.now(UTC)
    if now is None:
        raise ValueError("now_utc requires a timezone-aware date/time")
    ages = {k: source_state(board, k, now) for k in SOURCE_AGE}
    out = {
        "schema": 1,
        "status": "unavailable",
        "calculated_at": _iso(now),
        "source": {"label": "2020 U.S. Census", "url": CENSUS, "vintage": "2020-04-01"},
        "method": METHOD,
        "coverage": {
            "geography": "50 states, District of Columbia and Puerto Rico. Other U.S. territories are outside this Census reference.",
            "groups": {k: {"status": v[0], "as_of": v[1], "fresh_until": v[2]} for k, v in ages.items()},
        },
        "groups": {"ero": [], "winter": [], "outlook": [], "alerts": []},
        "alert_events": {},
    }
    try:
        centers, manifest = _load(Path(reference_dir))
    except (OSError, ValueError, EOFError, KeyError, lzma.LZMAError):
        out["coverage"]["reason"] = "The Census reference could not be verified."
        return out
    out["coverage"].update(
        populated_block_groups=manifest["populated_centers"], jurisdictions=len(manifest["jurisdictions"])
    )
    zones = {}
    zone_info = manifest.get("zones") or {}
    zonal_events = [
        e
        for e in ((board.get("sources") or {}).get("alerts") or {}).get("events", [])
        if isinstance(e, dict)
        and str(e.get("title") or "").lower() in ZONAL
        and not e.get("geometry")
        and _active(e, now)
    ]
    edition = None
    zone_status = "not_needed"
    if ages["alerts"][0] in AVAILABLE and zonal_events:
        zone_status = "unverified"
        edition = catalog_edition(zone_catalog_html if zone_catalog_html is not None else _get_catalog(), now)
        if edition:
            try:
                if all(edition[k] == zone_info.get(k) for k in ("effective", "filename", "md5")):
                    zones = json.loads(unpack(reference_dir, zone_info))
                else:
                    wanted = {code for event in zonal_events for code in event.get("ugc") or []}
                    zones = _current_zone_ids(
                        centers, edition, wanted, zone_cache_dir or os.environ.get("IDSS_ZONE_CACHE_DIR")
                    )
                zone_status = "verified"
            except (
                OSError,
                ValueError,
                EOFError,
                KeyError,
                TypeError,
                ImportError,
                lzma.LZMAError,
                zipfile.BadZipFile,
            ):
                pass
    out["coverage"]["forecast_zones"] = {
        "status": zone_status,
        "effective": edition["effective"] if edition else None,
        "source_url": ZONE_CATALOG,
    }
    if edition and edition["md5"] == zone_info.get("md5"):
        for key in ("centers_outside_all_zones", "residents_represented_outside_all_zones"):
            if key in zone_info:
                out["coverage"]["forecast_zones"][key] = zone_info[key]
    out["groups"]["ero"] = _ero(board, now, centers, ages["ero"])
    out["groups"]["winter"] = _winter(board, now, centers, ages["winter"], wssi_native)
    out["groups"]["outlook"] = _outlook(board, now, centers, ages["outlook"])
    out["groups"]["alerts"], out["alert_events"] = _alerts(board, now, centers, ages["alerts"], zones)
    if ages["alerts"][0] in AVAILABLE:
        out["coverage"]["groups"]["alerts"].update(
            land_warning_records=len(out["alert_events"]),
            complete_estimates=sum(r["status"] == "current" for r in out["alert_events"].values()),
        )
    records = [r for group in out["groups"].values() for r in group]
    ready = any(r["status"] in AVAILABLE for r in records)
    all_ready = all(s[0] == "current" for s in ages.values()) and all(
        r["status"] == "current" for r in records
    )
    out["status"] = "current" if all_ready else "partial" if ready else "unavailable"
    return out


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("board", type=Path)
    parser.add_argument("--as-of", help="UTC timestamp for a source replay")
    parser.add_argument(
        "--zone-catalog", type=Path, help="Reviewed public zone catalog captured for the replay"
    )
    parser.add_argument(
        "--wssi-native",
        type=Path,
        help="Original-resolution WSSI MapServer/4 GeoJSON captured for the replay",
    )
    args = parser.parse_args()
    result = collect(
        json.loads(args.board.read_text()),
        args.as_of,
        zone_catalog_html=args.zone_catalog.read_text() if args.zone_catalog else None,
        wssi_native=json.loads(args.wssi_native.read_text()) if args.wssi_native else None,
    )
    print(json.dumps(result, separators=(",", ":"), allow_nan=False))
