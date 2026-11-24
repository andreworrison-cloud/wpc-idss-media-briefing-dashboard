"""Public NWPS flood-stage observations and preliminary NWS ground-impact reports."""

from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
from http.client import HTTPException
import math
import re
from urllib.parse import urlencode
from urllib.request import Request, urlopen


UTC = timezone.utc
WATER = "https://water.noaa.gov/"
LAYER = "https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer/0"
LSR = "https://mesonet.agron.iastate.edu/lsr/"
PRODUCT = "https://mesonet.agron.iastate.edu/api/1/nwstext/"
OBS_HOURS, REPORT_HOURS = 6, 24
MAX_SOURCE_AGE = timedelta(hours=2)
SITE_LIMIT, REPORT_LIMIT = 100, 60
JURISDICTIONS = frozenset(
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM "
    "NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI UM".split()
)
FLOOD = ("major", "moderate", "minor")
CLASSIFIED = {*FLOOD, "action", "no_flooding", "low_threshold"}
IMPACTS = {
    "rescue": "Rescue reported",
    "structuralDamage": "Structural damage reported",
    "strandedVehicle": "Stranded vehicles reported",
    "roadClosure": "Road closure reported",
}
LEGACY_IMPACTS = {"rescue", "strandedVehicle", "roadClosure"}
BULLETIN = re.compile(re.escape(PRODUCT) + r"(\d{12})-[A-Z0-9]{4}-[A-Z0-9]{6}-LSR[A-Z0-9]{2,3}(?:-[A-Z0-9]{3})?")
WHERE_US = "state IN (" + ",".join(f"'{ab}'" for ab in sorted(JURISDICTIONS)) + ")"
FIELDS = "gaugelid,status,location,waterbody,state,obstime,observed,units,latitude,longitude,idp_filedate"


def instant(value, *, arcgis=False):
    if isinstance(value, datetime):
        return value.astimezone(UTC) if value.utcoffset() is not None else None
    if not isinstance(value, str):
        return None
    try:
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if value.utcoffset() is not None:
            return value.astimezone(UTC)
        if arcgis:
            return value.replace(tzinfo=UTC)
    except ValueError:
        pass
    return None


def file_time(value):
    if type(value) in (int, float):
        try:
            return datetime.fromtimestamp(value / 1000, UTC)
        except (ValueError, OverflowError, OSError):
            pass
    return None


def stamp(value):
    return value.isoformat(timespec="seconds").replace("+00:00", "Z") if value else None


def text(value):
    return value.strip() if isinstance(value, str) else ""


def number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (ValueError, TypeError):
        return None


def coordinates(lat, lon):
    lat, lon = number(lat), number(lon)
    if lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180 and (lat or lon):
        return lat, lon
    return None, None


def rivers_base():
    return {
        "status": "unavailable", "source": "NOAA National Water Prediction Service",
        "sourceUrl": WATER, "dataUrl": LAYER, "asOf": None, "latestNetworkObservedAt": None,
        "periodHours": OBS_HOURS, "total": None, "counts": dict.fromkeys(FLOOD),
        "availableCount": None, "availableCounts": dict.fromkeys(FLOOD),
        "sites": [], "displayLimit": SITE_LIMIT, "excludedOld": 0,
        "summary": "Observed flood-stage gauge counts are unavailable.",
        "coverage": "U.S. NWPS gauge locations, including rivers, lakes and tidal sites. Each marker represents one gauge observation.",
    }


def query(params):
    url = LAYER + "/query?" + urlencode({"f": "json", "returnGeometry": "false", **params})
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "WPC-IDSS-public-dashboard/2"})
    with urlopen(request, timeout=18) as response:
        data = json.load(response)
    if not isinstance(data, dict) or data.get("error") or not isinstance(data.get("features"), list):
        raise ValueError("Invalid NWPS GIS response.")
    return data


def attributes(response):
    rows = response.get("features") if isinstance(response, dict) and not response.get("error") else None
    if not isinstance(rows, list):
        return None
    return [f.get("attributes") if isinstance(f, dict) else None for f in rows]


def classify_rivers(stats_response, sites_response, now):
    result = rivers_base()
    stats, features = attributes(stats_response), attributes(sites_response)
    if not stats or features is None:
        return result

    source_times, network_times = set(), []
    expected = {}
    partial = bool(stats_response.get("exceededTransferLimit") or sites_response.get("exceededTransferLimit"))
    invalid_snapshot = False
    for group in stats:
        if not isinstance(group, dict):
            invalid_snapshot = True
            continue
        status, count = group.get("status"), group.get("site_count")
        start, end = file_time(group.get("file_min")), file_time(group.get("file_max"))
        if not start or not end or type(count) is not int or count < 1 or not isinstance(status, str) or not status or status in expected:
            invalid_snapshot = True
            continue
        expected[status] = count
        source_times.update((start, end))
        observed = instant(group.get("last_observation"), arcgis=True)
        if status in CLASSIFIED and observed and observed <= now:
            network_times.append(observed)
    if not source_times:
        return result
    as_of = max(source_times)
    result["asOf"] = stamp(as_of)
    latest = max(network_times, default=None)
    result["latestNetworkObservedAt"] = stamp(latest)
    if as_of > now or not latest:
        return result
    if now - as_of > MAX_SOURCE_AGE or now - latest > timedelta(hours=OBS_HOURS):
        result.update(status="stale", summary="Recent observed gauge data are unavailable in the last NWPS snapshot.")
        return result
    partial |= invalid_snapshot or len(source_times) != 1
    observed_groups = Counter()
    sites = {}
    conflicting_ids = set()
    for row in features:
        if not isinstance(row, dict):
            partial = True
            continue
        category, state = row.get("status"), row.get("state")
        if category not in FLOOD or not isinstance(state, str) or state not in JURISDICTIONS:
            partial = True
            continue
        observed_groups[category] += 1
        lid = text(row.get("gaugelid")).upper()
        observed = instant(row.get("obstime"), arcgis=True)
        edition = file_time(row.get("idp_filedate"))
        if not re.fullmatch(r"[A-Z0-9]{3,5}", lid) or not observed or not edition or observed > min(now, edition) or edition != as_of:
            partial = True
            continue
        if now - observed > timedelta(hours=OBS_HOURS):
            result["excludedOld"] += 1
            partial = True
            continue
        lat, lon = coordinates(row.get("latitude"), row.get("longitude"))
        waterbody, place = text(row.get("waterbody")), text(row.get("location"))
        name = f"{waterbody} · {place}" if waterbody and place and waterbody != place else waterbody or place or lid
        value, unit = number(row.get("observed")), text(row.get("units"))
        if value is None or value <= -900 or not re.fullmatch(r"[A-Za-z0-9 /³°.-]{1,8}", unit):
            value, unit = None, None
        site = {
            "id": lid, "name": name, "waterbody": waterbody or None, "location": place or None, "type": "observed",
            "state": state, "latitude": lat, "longitude": lon, "category": category,
            "observedAt": stamp(observed), "value": value, "unit": unit, "url": WATER + "gauges/" + lid.lower(),
        }
        if lid in sites and sites[lid] != site:
            conflicting_ids.add(lid)
        if lid in sites:
            partial = True
        sites[lid] = site
    for lid in conflicting_ids:
        del sites[lid]
    partial |= any(observed_groups[level] != expected.get(level, 0) for level in FLOOD)
    ranked = sorted(sites.values(), key=lambda s: (FLOOD.index(s["category"]), -instant(s["observedAt"]).timestamp(), s["state"], s["id"]))
    counts = {level: sum(s["category"] == level for s in ranked) for level in FLOOD}
    result.update(sites=ranked[:SITE_LIMIT], availableCount=len(ranked), availableCounts=counts)
    if partial:
        result.update(status="partial", summary=f"{len(ranked)} qualifying gauge observations are available. The full flood-stage count could not be verified.")
    else:
        n = len(ranked)
        result.update(status="ok", total=n, counts=counts)
        if n == 0:
            result["summary"] = f"No U.S. gauges in the current NWPS layer reported minor or higher flooding within {OBS_HOURS} hours."
        else:
            result["summary"] = (
                f"{n} {'gauge recorded' if n == 1 else 'gauges recorded'} minor or higher flooding within {OBS_HOURS} hours. "
                f"{counts['major']} major, {counts['moderate']} moderate and {counts['minor']} minor."
            )
    return result


def collect_rivers(now):
    stats = [
        {"statisticType": op, "onStatisticField": field, "outStatisticFieldName": name}
        for op, field, name in (("min", "idp_filedate", "file_min"), ("max", "idp_filedate", "file_max"),
                                ("max", "obstime", "last_observation"), ("count", "objectid", "site_count"))
    ]
    groups_query = {"where": WHERE_US, "groupByFieldsForStatistics": "status", "outStatistics": json.dumps(stats, separators=(",", ":"))}
    flood_query = {"where": WHERE_US + " AND status IN ('major','moderate','minor')", "outFields": FIELDS, "orderByFields": "objectid ASC"}
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            groups, floods = executor.map(query, (groups_query, flood_query))
        return classify_rivers(groups, floods, now)
    except (OSError, ValueError, HTTPException):
        return rivers_base()


def reports_base():
    return {
        "status": "unavailable", "source": "Preliminary NWS Local Storm Reports via Iowa Environmental Mesonet",
        "sourceUrl": LSR, "periodHours": REPORT_HOURS, "asOf": None, "windowStart": None, "latestIssuedAt": None,
        "total": None, "counts": dict.fromkeys(IMPACTS), "availableCount": None,
        "availableCounts": dict.fromkeys(IMPACTS), "supportedCategories": [], "items": [], "displayLimit": REPORT_LIMIT,
        "summary": "Ground-impact report counts are unavailable.",
        "coverage": "Preliminary reports may arrive late or describe the same incident. One report can describe multiple impacts. A reported closure can subsequently reopen.",
    }


def classify_reports(board, now):
    result = reports_base()
    sources = board.get("sources") if isinstance(board, dict) else None
    source = sources.get("reports") if isinstance(sources, dict) else None
    if not isinstance(source, dict) or not isinstance(source.get("events"), list):
        return result
    end, start = instant(source.get("window_end")), instant(source.get("window_start"))
    if not end or not start or end > now or start > end:
        return result
    lower = end - timedelta(hours=REPORT_HOURS)
    result.update(asOf=stamp(end), windowStart=stamp(lower))
    if source.get("status") == "stale" or now - end > MAX_SOURCE_AGE:
        result.update(status="stale", summary="The storm-report archive cutoff is stale. Current ground-impact counts are unavailable.")
        return result
    if source.get("status") not in ("ok", "partial"):
        return result
    health = board.get("health")
    feed_health = health.get("reports", {}) if isinstance(health, dict) else {}
    health_problem = isinstance(feed_health, dict) and (feed_health.get("retained") or feed_health.get("status", "ok") != "ok")
    partial = (source.get("status") != "ok" or source.get("query_complete") is not True or
               start > lower or health_problem or type(source.get("count")) is not int or source["count"] != len(source["events"]))
    declared = source.get("impact_flag_types")
    supported = {key for key, label in IMPACTS.items() if label in declared} if isinstance(declared, list) else LEGACY_IMPACTS
    result["supportedCategories"] = [k for k in IMPACTS if k in supported]
    if "structuralDamage" not in supported:
        result["coverage"] += " Structural damage tagging was unavailable for this archive edition."
    counts = Counter()
    items = {}
    for row in source["events"]:
        if not isinstance(row, dict):
            partial = True
            continue
        observed, issued = instant(row.get("valid")), instant(row.get("issued"))
        flags = row.get("impact_flags")
        if not observed or not issued or not isinstance(flags, list):
            partial = True
            continue
        if not lower <= observed <= end or issued > end or row.get("revision") == "withdrawal":
            continue
        categories = [key for key, label in IMPACTS.items() if label in flags]
        if not categories:
            continue
        url, rid = text(row.get("source_url")), text(row.get("id"))
        match = BULLETIN.fullmatch(url)
        if not match or match[1] != issued.strftime("%Y%m%d%H%M") or not rid or text(row.get("state")) not in JURISDICTIONS or issued < observed:
            partial = True
            continue
        if row.get("revision_match") == "unmatched":
            partial = True
            continue
        if rid in items:
            partial = True
            continue
        lat, lon = coordinates(row.get("lat"), row.get("lon"))
        city, county = text(row.get("city")), text(row.get("county"))
        location = city or county or row["state"]
        title = " · ".join(IMPACTS[k] for k in categories)
        wfo, hazard = text(row.get("wfo")), text(row.get("title")) or "Local storm report"
        items[rid] = {
            "id": rid, "title": title, "location": location, "county": county or None, "state": row["state"],
            "latitude": lat, "longitude": lon, "observedAt": stamp(observed), "reportedAt": stamp(issued),
            "categories": categories, "hazard": hazard, "office": wfo, "preliminary": True,
            "detail": f"{hazard}. Preliminary report from NWS {wfo}." if wfo else f"{hazard}. Preliminary NWS report.",
            "url": url,
        }
        counts.update(categories)
    ranked = sorted(items.values(), key=lambda r: (min(list(IMPACTS).index(k) for k in r["categories"]), -instant(r["observedAt"]).timestamp(), r["id"]))
    available = {k: counts[k] if k in supported or counts[k] else None for k in IMPACTS}
    latest = max((instant(item["reportedAt"]) for item in ranked), default=None)
    result.update(items=ranked[:REPORT_LIMIT], availableCount=len(ranked), availableCounts=available, latestIssuedAt=stamp(latest))
    if partial:
        result.update(status="partial", summary=f"{len(ranked)} qualifying preliminary reports are available. The full archive count could not be verified.")
    else:
        result.update(status="ok", total=len(ranked), counts=available)
        if not ranked:
            result["summary"] = f"No qualifying ground-impact reports appeared in the available NWS archive in this {REPORT_HOURS}-hour window."
        else:
            n = len(ranked)
            result["summary"] = f"{n} preliminary NWS {'report describes' if n == 1 else 'reports describe'} ground impacts in the {REPORT_HOURS} hours through the archive cutoff."
    return result


def collect(board, now_utc):
    now = instant(now_utc)
    if not now:
        raise ValueError("now_utc must be a timezone-aware datetime or ISO 8601 timestamp.")
    rivers, reports = collect_rivers(now), classify_reports(board, now)
    statuses = {rivers["status"], reports["status"]}
    status = statuses.pop() if len(statuses) == 1 else "partial"
    return {
        "status": status, "checkedAt": stamp(now), "rivers": rivers, "reports": reports,
        "notes": ["Gauge flood categories apply to the station. Local storm reports describe preliminary impacts at the time observed."],
    }
