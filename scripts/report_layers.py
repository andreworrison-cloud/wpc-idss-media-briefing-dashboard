"""Recent reviewed local storm reports and original NWS Public Information Statement tables."""

from collections import Counter, defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from http.client import HTTPException
from io import BytesIO
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zipfile import BadZipFile, ZipFile
import csv
import json
import math
import re

UTC = timezone.utc
HOURS = 48
LOCATED_LIMIT, UNLOCATED_LIMIT = 5000, 2500
BULK = "https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py"
BOARD = "https://wpc-impact-briefing.aorrison.chatgpt.site/api/board"
PAGES_BOARD = "https://andreworrison-cloud.github.io/wpc-idss-media-briefing-dashboard/data/board.json"
TEXT = "https://mesonet.agron.iastate.edu/api/1/nwstext/"
LSR = "https://mesonet.agron.iastate.edu/lsr/"
PNS = "https://www.weather.gov/aly/PNS_Reports"
# Specific reviewed bulletins can share one minute-based archive URL. Match the
# original observation and value so a later NWS correction takes precedence.
LSX_SNOW_REVIEW = {
    ("Clarksville", 39.37, -90.91, 1.0): (
        "0c55110e-5369-4d2a-aff7-68458e48dfe5", "2026-11-26T14:56:00Z",
    ),
    ("Cuba", 38.06, -91.4, 53.0): (
        "6dc792a9-b877-4010-911a-9e33c19199f1", "2026-11-26T14:57:00Z",
    ),
}
CUBA_COOP = "https://mesonet.agron.iastate.edu/COOP/cat.phtml?date=2026-11-26&network=MO_COOP&station=CUBM7"
ABBR = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI".split()
NAMES = "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|District of Columbia|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|American Samoa|Guam|Northern Mariana Islands|Puerto Rico|Virgin Islands".lower().split(
    "|"
)
STATES = dict(zip(NAMES, ABBR))
MARINE_AREAS = {"AT": "Atlantic waters"}
OFFSET = {
    "UTC": 0,
    "GMT": 0,
    "AST": -4,
    "EDT": -4,
    "EST": -5,
    "CDT": -5,
    "CST": -6,
    "MDT": -6,
    "MST": -7,
    "PDT": -7,
    "PST": -8,
    "AKDT": -8,
    "AKST": -9,
    "HDT": -9,
    "HST": -10,
    "HAST": -10,
    "HADT": -9,
    "SST": -11,
    "CHST": 10,
}
TYPES = {
    "snowfall": ("snow", "Snowfall", "in"),
    "snowDepth": ("snow", "Snow depth", "in"),
    "sleet": ("snow", "Sleet accumulation", "in"),
    "iceAccretion": ("ice", "Ice accretion", "in"),
    "rainfall": ("rain", "Rainfall", "in"),
    "precipitation": ("rain", "Precipitation total", "in"),
    "windGust": ("wind", "Wind gust", "mph"),
    "sustainedWind": ("wind", "Sustained wind", "mph"),
    "windSpeed": ("wind", "Wind speed", "mph"),
    "hailDiameter": ("hail", "Hail diameter", "in"),
    "windChill": ("cold", "Wind chill", "°F"),
    "heatIndex": ("heat", "Heat index", "°F"),
    "lowTemperature": ("cold", "Low temperature", "°F"),
    "highTemperature": ("heat", "High temperature", "°F"),
}
LEADERS = {
    "snow": "snowfall",
    "ice": "iceAccretion",
    "rain": "rainfall",
    "wind": "windGust",
    "hail": "hailDiameter",
    "cold": "windChill",
    "heat": "heatIndex",
}
LSR_TYPES = {
    "snow": "snowfall",
    "heavy snow": "snowfall",
    "sleet": "sleet",
    "freezing rain": "iceAccretion",
    "rainfall": "rainfall",
    "heavy rainfall": "rainfall",
    "thunderstorm wind gust": "windGust",
    "non-thunderstorm wind gust": "windGust",
    "marine thunderstorm wind": "windSpeed",
    "high winds over water": "windSpeed",
    "high sustained winds": "sustainedWind",
    "hail": "hailDiameter",
    "wind chill": "windChill",
    "heat index": "heatIndex",
}
EFFECTS = {
    "tornado",
    "flash flood",
    "flood",
    "coastal flood",
    "lakeshore flooding",
    "landslide",
    "debris flow",
    "avalanche",
    "storm surge",
    "thunderstorm wind damage",
    "non-thunderstorm wind damage",
    "high surf",
    "rip currents",
    "ice storm",
    "blizzard",
    "snow squall",
    "extreme cold",
    "excessive heat",
    "heat",
    "tropical cyclone",
    "wildfire",
    "downburst",
    "dust storm",
    "blowing dust",
    "dense fog",
    "fog",
    "other local storm report",
    "waterspout",
    "funnel cloud",
    "landspout",
    "marine high winds",
    "high winds over water",
    "tsunami",
    "lightning",
    "seiche",
    "sneaker wave",
}
SAFE_FLAGS = {
    "Road closure reported",
    "Rescue reported",
    "Stranded vehicles reported",
    "Structural damage reported",
    "Marine observation",
    "Burn scar mentioned in report",
}
PNS_CODES = {
    "SNOW": "snowfall",
    "SNOW_D": "snowDepth",
    "SNOW_DEPTH": "snowDepth",
    "SLEET": "sleet",
    "ICE": "iceAccretion",
    "FZRA": "iceAccretion",
    "FREEZING_RAIN": "iceAccretion",
    "RAIN": "rainfall",
    "PCPN": "precipitation",
    "PRECIP": "precipitation",
    "GUST": "windGust",
    "WGUST": "windGust",
    "PKGUST": "windGust",
    "WIND_GUST": "windGust",
    "SUSTAINED_WIND": "sustainedWind",
    "HAIL": "hailDiameter",
    "WIND_CHILL": "windChill",
    "WINDCHILL": "windChill",
    "HEAT_INDEX": "heatIndex",
    "HEATINDEX": "heatIndex",
}
NUM = r"(?:[+-]?(?:\d+(?:\.\d+)?|\.\d+)|T(?:RACE)?)"
UNITS = r'(?:inches|inch|in\.?|"|mm|cm|ft|feet|mph|miles per hour|knots?|kts?|km/h|m/s|°[FC]|deg[FC]|[FC])'
PLAIN_ROW = re.compile(
    r"^\s*(.+?)\s+("
    + NUM
    + r")\s*("
    + UNITS
    + r")?\s+(\d{1,2}:?\d{2}\s*[AP]M)\s+(\d{1,2}/\d{1,2}(?:/\d{4})?)(?:\s+(.*))?$",
    re.I,
)
CSV_START = re.compile(r"^\s*:?\d{1,2}/\d{1,2}/\d{4}\s*,")
TABLE_HEADER = re.compile(r"^Location\s+(?:Amount|Speed|Temp(?:erature)?)\b.*\bTime/Date\b", re.I)
EXCLUDED_HEADING = re.compile(r"FORECAST|OUTLOOK|NORMALS?|HISTORY|SNOW WATER EQUIVALENT", re.I)
PRODUCT = re.compile(re.escape(TEXT) + r"(\d{12})-[A-Z0-9]{4}-[A-Z0-9]{6}-LSR[A-Z0-9]{2,3}(?:-[A-Z0-9]{3})?")
ERR = (ValueError, OSError, HTTPException, BadZipFile, KeyError)


def stamp(t):
    return t.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z") if t else None


def instant(v):
    try:
        t = v if isinstance(v, datetime) else datetime.fromisoformat(v.replace("Z", "+00:00"))
        return t.astimezone(UTC) if t.utcoffset() is not None else None
    except (TypeError, AttributeError, ValueError):
        return None


def number(v):
    try:
        n = float(v)
        return n if math.isfinite(n) and not isinstance(v, bool) else None
    except (ValueError, TypeError):
        return None


def place(v):
    s = " ".join(v.split()) if isinstance(v, str) else ""
    if (
        not s
        or len(s) > 75
        or not re.fullmatch(r"[\w .,'’()/&-]+", s)
        or re.search(
            r"https?|www\.|@|\b(?:phone|mobile number|cell number|private residence|backyard|my house)\b|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b",
            s,
            re.I,
        )
    ):
        return None
    if re.match(r"^\d{1,6}\s+(?![NSEW]{1,3}\s|miles?\s)", s, re.I):
        return None
    return s


def coordinates(lat, lon, state):
    x, y = number(lon), number(lat)
    if x is None or y is None:
        return None, None
    bounds = {
        "AK": (50, 73, -180, -128),
        "HI": (18, 30, -180, -154),
        "PR": (17, 19.5, -68.5, -65),
        "VI": (17, 19.5, -65.5, -64),
        "GU": (12, 15, 143, 146),
        "MP": (13, 22, 143, 147),
        "AS": (-16, -10, -173, -167),
        "AT": (17, 51, -83, -60),
    }
    south, north, west, east = bounds.get(state, (23, 51, -130, -60))
    if south <= y <= north and (west <= x <= east or (state == "AK" and 170 <= x <= 180)):
        return round(y, 5), round(x, 5)
    return None, None


def magnitude(raw, unit, typ):
    unit = str(unit or "").strip().lower().replace("degrees ", "").rstrip(".")
    desired = TYPES[typ][2]
    factors = {
        "in": {"in": 1, "inch": 1, "inches": 1, '"': 1, "mm": 1 / 25.4, "cm": 1 / 2.54, "ft": 12, "feet": 12},
        "mph": {
            "mph": 1,
            "miles per hour": 1,
            "kt": 1.150779448,
            "kts": 1.150779448,
            "knot": 1.150779448,
            "knots": 1.150779448,
            "km/h": 0.621371192,
            "m/s": 2.236936292,
        },
        "°F": {"°f": 1, "f": 1, "degf": 1, "°c": 1, "c": 1, "degc": 1},
    }[desired]
    if str(raw).upper() in {"T", "TRACE"} and desired == "in":
        return None, desired if unit in factors else None, True
    if unit not in factors:
        return None, None, False
    n = number(raw)
    if n is None or n <= -900 or (desired != "°F" and n < 0):
        return None, None, False
    n = n * 1.8 + 32 if desired == "°F" and unit.endswith("c") else n * factors[unit]
    return round(n, 3), desired, False


def row_id(parts):
    return sha256(json.dumps(parts, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()[:20]


def report(
    source,
    office,
    state,
    town,
    county,
    lat,
    lon,
    observed,
    issued,
    url,
    typ,
    name,
    raw=None,
    unit=None,
    qualifier="Reported",
    duration=None,
    period=None,
):
    lat, lon = coordinates(lat, lon, state)
    category, label, _ = TYPES.get(typ, ("effect", name, None))
    value, unit, trace = magnitude(raw, unit, typ) if typ in TYPES else (None, None, False)
    return {
        "id": "",
        "sourceType": source,
        "category": category,
        "phenomenon": name,
        "label": label,
        "measurementType": typ,
        "value": value,
        "unit": unit,
        "trace": trace,
        "qualifier": "Trace" if trace else qualifier,
        "place": town or county or state,
        "state": state,
        "county": county,
        "office": office,
        "observedAt": stamp(observed),
        "issuedAt": stamp(issued),
        "latitude": lat,
        "longitude": lon,
        "url": url,
        "durationHours": duration,
        "periodLabel": period,
        "impactFlags": [],
    }


def fetch(url, max_bytes, accept):
    req = Request(url, headers={"User-Agent": "WPC-IDSS-public-observations/1", "Accept": accept})
    with urlopen(req, timeout=25) as r:
        if number(r.headers.get("Age")) and float(r.headers["Age"]) > 7200:
            raise ValueError("Stale archive response")
        data = r.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise ValueError("Archive response exceeded read limit")
    return data


def source_info(name, url, end):
    return {
        "status": "unavailable",
        "source": name,
        "sourceUrl": url,
        "asOf": None,
        "queryEnd": stamp(end),
        "windowStart": stamp(end - timedelta(hours=HOURS)),
        "periodHours": HOURS,
        "latestIssuedAt": None,
        "count": None,
        "located": None,
        "unlocated": None,
    }


def report_archive(board):
    sources = board.get("sources") if isinstance(board, dict) else None
    reports = sources.get("reports") if isinstance(sources, dict) else None
    return reports if isinstance(reports, dict) else {}


def apply_bulletin_review(row):
    if (row["url"] != TEXT + "202611261456-KLSX-NWUS53-LSRLSX"
            or row["observedAt"] != "2026-11-26T13:00:00Z"
            or row["state"] != "MO" or row["measurementType"] != "snowfall"
            or row["revision"] != "original"):
        return
    edition = LSX_SNOW_REVIEW.get((row["place"], row["latitude"], row["longitude"], row["value"]))
    if not edition:
        return
    uuid, issued = edition
    row.update(url="https://api.weather.gov/products/" + uuid, issuedAt=issued, evidenceStatus="bulletinVerified")
    if row["place"] == "Cuba":
        row.update(
            verificationStatus="conflicting", eligibleForBrief=False, verificationUrl=CUBA_COOP,
            verificationNote="The preliminary NWS storm report gives 53.0 inches. The Cuba cooperative station (CUBM7) reported 5.3 inches at the same 07:00 CST observation.",
        )


def archive_url(pil, fmt, start, end):
    return BULK + "?" + urlencode({
        "pil": pil, "fmt": fmt, "sdate": stamp(start), "edate": stamp(end), "limit": "9999",
    })


LSR_CLOCK = re.compile(r"\d{1,2}:?\d{2}\s*[AP]M", re.I)
LSR_POSITION = re.compile(r"(\d+(?:\.\d+)?)\s*([NS])\s+(\d+(?:\.\d+)?)\s*([EW])", re.I)
LSR_DATE = re.compile(r"^\s*(\d{1,2}/\d{1,2}/\d{4})\s+(.*)")
LSR_AMOUNT = re.compile(r"^[MEU]?(" + NUM + r")\s*(" + UNITS + r")\b", re.I)


def event_words(name):
    words = {"tstm": "thunderstorm", "wnd": "wind", "gst": "gust", "dmg": "damage", "hvy": "heavy"}
    return tuple(words.get(w, w) for w in re.findall("[a-z]+", name.lower()))


def original_lsr_rows(body, issued):
    zone = re.search(r"^\s*\d{1,4}(?::\d{2})?\s*[AP]M\s+([A-Z]{2,5})\s+(?:MON|TUE|WED|THU|FRI|SAT|SUN)", body, re.I | re.M)
    if not zone:
        return []
    result = []
    lines = body.splitlines()
    for line, detail in zip(lines, lines[1:]):
        # The standard LSR uses fixed columns. A full-width event name can
        # leave a single space in front of the city.
        clock, phenomenon, town = line[:12].strip(), line[12:29].strip(), line[29:53].strip()
        coordinates = LSR_POSITION.match(line[53:].strip())
        if not LSR_CLOCK.fullmatch(clock) or not coordinates or not town or not phenomenon:
            continue
        date = LSR_DATE.match(detail)
        if not date:
            continue
        y, ns, x, ew = coordinates.groups()
        observed = from_local(date[1], clock, zone[1].upper(), issued)
        if not observed:
            continue
        amount = LSR_AMOUNT.match(date[2])
        result.append((town.casefold(), event_words(phenomenon), stamp(observed),
                       float(y) * (-1 if ns.upper() == "S" else 1),
                       float(x) * (-1 if ew.upper() == "W" else 1),
                       amount.groups() if amount else None))
    return result


def original_matches(row, entry):
    town, event, observed, y, x, amount = entry
    if (town != row["place"].casefold()
            or (row["phenomenon"] != "Other local storm report" and event != event_words(row["phenomenon"]))
            or observed != row["observedAt"]
            or (row["latitude"] is not None and
                (abs(y-row["latitude"]) > 0.011 or abs(x-row["longitude"]) > 0.011))):
        return False
    if row["value"] is None and not row["trace"]:
        return True
    if not amount:
        return False
    value, unit, trace = magnitude(*amount, row["measurementType"])
    return unit == row["unit"] and trace == row["trace"] and value == row["value"]


def check_shared_lsr_links(rows, info):
    groups = defaultdict(list)
    for row in rows:
        if PRODUCT.fullmatch(row["url"]):
            groups[row["url"]].append(row)
    shared = {}
    for url, members in groups.items():
        if len({(r["place"], r["latitude"], r["longitude"]) for r in members}) < 2:
            continue
        minute, _, _, pil, *_ = url[len(TEXT):].split("-")
        shared.setdefault(pil + "_" + minute, []).extend(members)
    if not shared:
        return
    editions = defaultdict(set)
    times = [instant(member["issuedAt"]) for members in shared.values() for member in members]
    try:
        bulk = archive_url("LSR", "zip", min(times), max(times) + timedelta(minutes=1))
        with ZipFile(BytesIO(fetch(bulk, 22_000_000, "application/zip"))) as archive:
            entries = archive.infolist()
            if len(entries) >= 9999 or sum(f.file_size for f in entries) > 70_000_000:
                raise ValueError("Incomplete LSR archive")
            for f in entries:
                key = f.filename.removesuffix(".txt")
                if key in shared:
                    # Two different products can have the same ZIP name. Reading
                    # the member object preserves each distinct original bulletin.
                    editions[key].add(archive.read(f).decode("utf-8", errors="replace").replace("\r", ""))
    except ERR:
        editions.clear()
    unresolved = 0
    for key, members in shared.items():
        issued = instant(members[0]["issuedAt"])
        bodies = editions[key]
        original = [entry for body in bodies for entry in original_lsr_rows(body, issued)]
        combined_url = archive_url(key.split("_")[0], "text", issued, issued + timedelta(minutes=1))
        for row in members:
            if len(bodies) > 1:
                row["url"] = combined_url
            if any(original_matches(row, entry) for entry in original):
                row["evidenceStatus"] = "archiveVerified" if len(bodies) > 1 else "bulletinVerified"
            else:
                row.update(evidenceStatus="ambiguous", eligibleForBrief=False,
                           verificationNote="This minute-indexed archive link is shared by several locations. The original bulletin for this observation could not be verified.")
                unresolved += 1
    info["ambiguousEvidenceCount"] = unresolved


def lsr_rows(board, end):
    info = source_info("NWS Local Storm Reports via IEM", LSR, end)
    if board is None:
        for url in (BOARD, PAGES_BOARD):
            try:
                board = json.loads(fetch(url, 14_000_000, "application/json"))
                if report_archive(board):
                    break
            except (OSError, HTTPException, ValueError, AttributeError, KeyError):
                continue
    src = report_archive(board)
    if not isinstance(src.get("events"), list):
        return [], info
    cutoff, start = instant(src.get("window_end")), instant(src.get("window_start"))
    if not cutoff or not start or cutoff > end or start > cutoff:
        return [], info
    info["asOf"] = stamp(cutoff)
    info["queryEnd"] = stamp(cutoff)
    if end - cutoff > timedelta(hours=2) or src.get("status") == "stale":
        info["status"] = "stale"
        return [], info
    if src.get("status") not in ("partial", "ok"):
        return [], info
    partial = (
        src.get("status") != "ok"
        or src.get("query_complete") is not True
        or start > end - timedelta(hours=HOURS)
        or ("count" in src and src["count"] != len(src["events"]))
        or cutoff < end
        or (board.get("health") or {}).get("reports", {}).get("retained")
    )
    rows = {}
    for item in src["events"]:
        if not isinstance(item, dict):
            partial = True
            continue
        name = item.get("title")
        if not isinstance(name, str):
            partial = True
            continue
        key = name.lower()
        if key not in LSR_TYPES and key not in EFFECTS:
            continue
        observed, issued = instant(item.get("valid")), instant(item.get("issued"))
        if not observed or not issued:
            partial = True
            continue
        if (
            not end - timedelta(hours=HOURS) <= observed <= cutoff
            or issued > cutoff
            or item.get("revision") == "withdrawal"
        ):
            continue
        link = item.get("source_url")
        match = PRODUCT.fullmatch(link) if isinstance(link, str) else None
        state = item.get("state")
        if (
            not match
            or match[1] != issued.strftime("%Y%m%d%H%M")
            or not isinstance(state, str)
            or (state not in ABBR and state not in MARINE_AREAS)
            or not isinstance(item.get("id"), str)
            or not item["id"]
            or item.get("revision_match") == "unmatched"
            or observed > issued
        ):
            partial = True
            continue
        typ = LSR_TYPES.get(key, "event")
        dur = number(item.get("accumulation_hours"))
        q = item.get("qualifier")
        # IEM encodes a trace of accumulated precipitation as 0.0001 inches.
        # The original bulletin prints T, which must remain distinct from zero.
        trace = item.get("trace") or (
            typ in ("snowfall", "sleet", "rainfall", "iceAccretion")
            and item.get("unit") == "in" and number(item.get("magnitude")) == 0.0001
        )
        row = report(
            "LSR",
            item.get("wfo"),
            state,
            place(item.get("city")),
            place(item.get("county")),
            item.get("lat"),
            item.get("lon"),
            observed,
            issued,
            link,
            typ,
            name,
            "T" if trace else item.get("magnitude"),
            item.get("unit"),
            q if q in ("Measured", "Estimated") else "Reported",
            dur if dur and dur > 0 else None,
        )
        flags = item.get("impact_flags", [])
        if not isinstance(flags, list):
            partial = True
            flags = []
        row["impactFlags"] = [flag for flag in flags if isinstance(flag, str) and flag in SAFE_FLAGS]
        if row["state"] in MARINE_AREAS:
            row["marineArea"] = MARINE_AREAS[row["state"]]
        row["id"] = item["id"]
        row["preliminary"] = item.get("preliminary", True) is True
        row["revision"] = item.get("revision", "original")
        apply_bulletin_review(row)
        if instant(row["issuedAt"]) <= cutoff:
            rows[row["id"]] = row
    info["status"] = "partial" if partial else "ok"
    return list(rows.values()), info


def from_local(date, time, zone, issued):
    if zone not in OFFSET:
        return None
    clock = time.replace(":", "").replace(" ", "").upper()
    dates = (
        [date]
        if date.count("/") == 2
        else [date + "/" + str(y) for y in (issued.year - 1, issued.year, issued.year + 1)]
    )
    values = []
    for d in dates:
        try:
            wall = datetime.strptime(d + " " + clock, "%m/%d/%Y %I%M%p").replace(
                tzinfo=timezone(timedelta(hours=OFFSET[zone]))
            )
            values.append(wall.astimezone(UTC))
        except ValueError:
            continue
    return min(values, key=lambda t: abs(t - issued), default=None)


def heading_kind(v):
    s = v.upper()
    if EXCLUDED_HEADING.search(s) or re.search(r"MAY INCLUDE|AMOUNTS INCLUDE|MIXTURE OF|PLEASE NOTE", s):
        return None
    for pattern, typ in (
        (r"SNOW (?:DEPTH|ON GROUND)|SNOW ON THE GROUND", "snowDepth"),
        (r"SNOWFALL|STORM TOTAL SNOW\b", "snowfall"),
        (r"SLEET", "sleet"),
        (r"ICE (?:ACCUMULATION|ACCRETION)|FREEZING RAIN", "iceAccretion"),
        (r"RAINFALL|RAIN REPORT", "rainfall"),
        (r"PRECIPITATION REPORTS", "precipitation"),
        (r"WIND GUST|PEAK WINDS", "windGust"),
        (r"SUSTAINED WIND", "sustainedWind"),
        (r"\b(?:HIGHEST|STRONGEST) WIND REPORTS?\b", "windSpeed"),
        (r"HAIL", "hailDiameter"),
        (r"WIND CHILL", "windChill"),
        (r"HEAT IND(?:EX|ICES)", "heatIndex"),
        (r"\bLOW TEMPERATURE REPORTS?\b", "lowTemperature"),
        (r"\bHIGH TEMPERATURE REPORTS?\b", "highTemperature"),
    ):
        if re.search(pattern, s):
            return typ
    return None


def hours(text):
    m = re.search(r"\b(\d{1,3})[- ]?(?:HOUR|HR)S?\b", text, re.I)
    return int(m[1]) if m and 0 < int(m[1]) <= 240 else None


def heading_duration(s):
    # "Reports for the last 48 hours" is a selection window, not every station’s accumulation period.
    match = re.search(r"\b(\d{1,3})[- ]?(?:HOUR|HR)S?\s+(?:TOTAL\s+)?(?:SNOW|RAIN|PRECIP|ICE|SLEET)", s, re.I)
    return int(match[1]) if match and 0 < int(match[1]) <= 240 else None


def pns_product(fname, body, end):
    m = re.fullmatch(r"(PNS[A-Z0-9]{2,3})_(\d{12})(?:_[A-Z0-9]+)?\.txt", fname)
    head = re.search(
        r"^([A-Z0-9]{6})[ \t]+([A-Z0-9]{4})[ \t]+\d{6}(?:[ \t]+((?:AA|CC|RR)[A-Z]|COR))?[ \t]*$", body, re.M
    )
    if not m or not head:
        return [], "unsupported", None
    pil, issued_s = m.groups()
    issued = datetime.strptime(issued_s, "%Y%m%d%H%M").replace(tzinfo=UTC)
    if not end - timedelta(hours=HOURS) <= issued <= end:
        return [], "outside", None
    url = TEXT + "-".join([issued_s, head[2], head[1], pil] + ([head[3]] if head[3] else []))
    tz = re.search(
        r"^\s*\d{1,4}(?::\d{2})?\s*[AP]M\s+([A-Z]{2,5})\s+(?:MON|TUE|WED|THU|FRI|SAT|SUN)", body, re.I | re.M
    )
    machine = []
    display = []
    header = body[:tz.start()] if tz else ""
    ugc_areas = set(re.findall(r"(?:^|-)([A-Z]{2})[CZ]\d{3}", header, re.M))
    default_state = next(iter(ugc_areas)) if len(ugc_areas) == 1 and ugc_areas.issubset(ABBR) else None
    state = None
    county = None
    marine_area = None
    reporting_area = None
    table_header = False
    typ = None
    unit = None
    duration = None
    period = None
    seen_table = False
    errors = 0
    table_lines = 0
    mixed_liquid = bool(
        re.search(
            r"amounts? (?:may )?include[^\n]{0,100}(?:snow[ -]?melt|melted snow|snow water|liquid equivalent)",
            body,
            re.I,
        )
    )
    for raw in body.splitlines():
        ln = raw.strip()
        if CSV_START.match(ln):
            seen_table = True
            table_lines += 1
            c = [v.strip() for v in next(csv.reader([ln.lstrip(":")], skipinitialspace=True))]
            found = None
            for i in range(9, len(c) - 2):
                base = re.sub(r"_\d{1,3}$", "", c[i].upper())
                if base in PNS_CODES:
                    found = (i, PNS_CODES[base])
                    break
            if not found:
                errors += 1
                continue
            i, mt = found
            if mixed_liquid and mt == "rainfall":
                mt = "precipitation"
            state_code = c[2].upper()
            if state_code not in ABBR and state_code not in MARINE_AREAS:
                continue
            obs = from_local(c[0], c[1], tz[1].upper() if tz else "", issued)
            if not obs:
                errors += 1
                continue
            if not end - timedelta(hours=HOURS) <= obs <= issued:
                continue
            inside_code = re.search(r"_(\d{1,3})$", c[i])
            description = c[i + 4] if len(c) > i + 4 else ""
            dur = int(inside_code[1]) if inside_code else hours(description)
            per = "Storm total" if "storm total" in description.lower() else None
            co = place(c[3])
            loc = " ".join(x for x in [c[i - 4], c[i - 3], ", ".join(c[4 : i - 4])] if x)
            r = report(
                "PNS",
                pil[3:],
                state_code,
                None,
                co,
                c[i - 2],
                c[i - 1],
                obs,
                issued,
                url,
                mt,
                TYPES[mt][1],
                c[i + 1],
                c[i + 2],
                duration=dur,
                period=per,
            )
            if r["value"] is None and not r["trace"]:
                errors += 1
                continue
            r["_name"] = place(loc)
            if state_code in MARINE_AREAS:
                r["marineArea"] = MARINE_AREAS[state_code]
            machine.append(r)
            continue
        if typ and TABLE_HEADER.match(ln):
            table_header = True
            unit_match = re.search(r"\((in\.?|inches|mph|°F)\)", ln, re.I)
            unit = unit_match[1] if unit_match else None
            continue
        striped = ln.strip(".* ").strip()
        if striped.lower() in STATES:
            state = STATES[striped.lower()]
            county = marine_area = reporting_area = None
            continue
        if ln.startswith("...") or ln.startswith("***"):
            county_heading = re.fullmatch(
                r"(.+?)\s+(?:county|parish|borough|census area|municipality)(?: ([A-Z]{2}))?", striped, re.I
            )
            if county_heading:
                county = place(county_heading[1])
                marine_area = reporting_area = None
                explicit_state = (county_heading[2] or "").upper()
                state = explicit_state if explicit_state in ABBR else state or default_state
                continue
            if re.search(r"MAY INCLUDE|AMOUNTS INCLUDE|PLEASE NOTE", striped, re.I):
                continue
            new = heading_kind(striped)
            if new:
                typ = new
                seen_table = True
                duration = heading_duration(striped)
                period = "Storm total" if "STORM TOTAL" in striped.upper() else None
                if "SINCE MIDNIGHT" in striped.upper():
                    period = "Since local midnight"
                state = default_state
                county = marine_area = reporting_area = None
                table_header = False
                unit = None
                continue
            if striped.upper() == "MARITIME STATIONS" or "OCEAN" in striped.upper() or striped.upper().startswith(
                ("GULF OF", "LAKE ERIE", "LAKE MICHIGAN", "LAKE SUPERIOR")
            ):
                if not marine_area or striped.upper() != "MARITIME STATIONS":
                    marine_area = place(striped)
                state = None
                county = reporting_area = None
            elif typ and table_header and not EXCLUDED_HEADING.search(striped) and not re.search(
                r"\bREPORTS?\b", striped, re.I
            ):
                # NWS also groups table rows by forecast zone. A zone name alone
                # cannot identify a state in a multi-state bulletin.
                county = marine_area = None
                reporting_area = place(striped)
                state = default_state
            elif typ:
                typ = None
                state = None
                county = marine_area = reporting_area = None
                table_header = False
            continue
        if ln == "&&":
            typ = None
            continue
        if not typ or (not state and not table_header):
            continue
        rawrow = PLAIN_ROW.fullmatch(raw.rstrip())
        if not rawrow:
            if re.search(r"\s{2,}[0-9.T]+\s+(?:inches?|mph|knots?|[AP]M)\b", ln, re.I):
                errors += 1
            continue
        table_lines += 1
        town, amt, u, clock, date, tail = rawrow.groups()
        obs = from_local(date, clock, tz[1].upper() if tz else "", issued)
        if not obs:
            errors += 1
            continue
        if not end - timedelta(hours=HOURS) <= obs <= issued:
            continue
        xy = re.search(r"(\d+(?:\.\d+)?)\s*([NS])\s*/\s*(\d+(?:\.\d+)?)\s*([EW])", tail or "", re.I)
        lat = float(xy[1]) * (1 if xy[2].upper() == "N" else -1) if xy else None
        lon = float(xy[3]) * (1 if xy[4].upper() == "E" else -1) if xy else None
        r = report(
            "PNS",
            pil[3:],
            state,
            place(town),
            county,
            lat,
            lon,
            obs,
            issued,
            url,
            typ,
            TYPES[typ][1],
            amt,
            u or unit,
            duration=duration,
            period=period,
        )
        if not r["place"]:
            errors += 1
            continue
        if marine_area:
            r["marineArea"] = marine_area
        if reporting_area:
            r["reportingArea"] = reporting_area
        if r["value"] is not None or r["trace"]:
            display.append(r)
        else:
            errors += 1
    if not seen_table:
        if re.search(
            r"^Daily Temperature and Precipitation Summary$|^:Temperature and precipitation stations\s*$",
            body, re.I | re.M
        ):
            return [], "climateSummary", issued
        return [], "other", issued
    matched, ambiguous = merge_tables(machine, display)
    if errors or not table_lines:
        return matched, "partial", issued
    return matched, "unresolvedStations" if ambiguous else "measurement", issued


def join_key(row):
    typ = row["measurementType"]
    if row["category"] == "rain":
        typ = "liquid"
    elif typ in ("windGust", "windSpeed"):
        typ = "wind"
    # The public display rounds station observations, e.g. 2.742 to 2.74 inches.
    return (
        typ,
        row["observedAt"],
        None if row["value"] is None else round(row["value"] + 1e-9, 2),
        row["trace"],
    )


def locality(name):
    if not name:
        return ""
    s = name.lower().strip()
    # Both orders occur for the same station. Preserve the direction and distance.
    return re.sub(r"^(.+?)\s+(\d+(?:\.\d+)?)\s*([nsew]{1,3})$", r"\2 \3 \1", s)


def match_strength(source, view):
    if source["state"] and view["state"] and source["state"] != view["state"]:
        return 0
    county = (source["county"] or "").lower()
    area = (view["county"] or view.get("reportingArea") or "").lower()
    if county and view["county"] and county != area:
        return 0
    if source["latitude"] is not None and view["latitude"] is not None:
        # Public NWS tables often round a higher-precision source position to 0.01 degrees.
        return 4 if all(abs(source[k] - view[k]) <= 0.00501 for k in ("latitude", "longitude")) else 0
    if source["_name"] and locality(source["_name"]) == locality(view["place"]):
        return 3
    if county and re.search(r"\b" + re.escape(county) + r"\b", area):
        return 2
    return 1


def county_key(row):
    return row["state"], (row["county"] or "").casefold()


def merge_tables(machine, display):
    if not machine:
        return display, False
    mg = defaultdict(list)
    dg = defaultdict(list)
    for r in machine:
        mg[join_key(r)].append(r)
    for r in display:
        dg[join_key(r)].append(r)
    out = []
    ambiguous = False
    for key, rows in mg.items():
        views = dg.pop(key, [])
        strengths = [[match_strength(r, v) for v in views] for r in rows]
        free_rows = set(range(len(rows)))
        free_views = set(range(len(views)))
        matches = {}
        # Match each printed station only once. Place a numeric report at a named
        # station only when both representations identify one candidate.
        for level in (4, 3, 2):
            for i in sorted(free_rows):
                fits = [j for j in free_views if strengths[i][j] >= level]
                if len(fits) != 1:
                    continue
                j = fits[0]
                if sum(strengths[k][j] >= level for k in free_rows) == 1:
                    matches[i] = views[j]
                    free_views.remove(j)
                    free_rows.remove(i)
        for i, r in enumerate(rows):
            original = r.pop("_name")
            v = matches.get(i)
            if v:
                r["place"] = v["place"]
                if v["value"] is not None:
                    r["value"] = v["value"]
                if r["latitude"] is None and v["latitude"] is not None:
                    r["latitude"], r["longitude"] = v["latitude"], v["longitude"]
            elif original and re.match(r"^\d+(?:\.\d+)?\s+[NSEW]{1,3}\s+", original, re.I):
                r["place"] = original
            else:
                r["place"] = r["county"] + " reporting area" if r["county"] else r["state"]
            out.append(r)
        # A mirrored county table may have tied values at distinct stations.
        # The complete compact inventory provides every position and reading
        # in that county, even when we cannot assign the alternate place names.
        compact_counts = Counter(county_key(rows[i]) for i in free_rows)
        print_counts = Counter(county_key(views[j]) for j in free_views)
        for j in sorted(free_views):
            region = county_key(views[j])
            candidates = [i for i in free_rows if strengths[i][j]]
            if not candidates:
                out.append(views[j])
            elif not (all(region) and print_counts[region] <= compact_counts[region]
                      and all(county_key(rows[i]) == region for i in candidates)):
                # A station already represented in the compact table may have a
                # different display name. A second independent report is unverified.
                ambiguous = True
    for rows in dg.values():
        out.extend(rows)
    return out, ambiguous


def correction_series(fname, body):
    lines = body.splitlines()
    heading = next(
        (
            heading_kind(ln.strip(".* "))
            for ln in lines
            if ln.lstrip().startswith(("...", "***")) and heading_kind(ln.strip(".* "))
        ),
        None,
    )
    # Preserve the UGC service area while removing its changing expiration token.
    ugc = []
    for ln in lines[:16]:
        if re.match(r"^(?:[A-Z]{2}[CZ]|\d{3}[->])", ln):
            ugc.append(re.sub(r"\d{6}-$", "", ln.strip()))
    corrected = bool(
        re.search(
            r"Public Information Statement[^\n]*(?:Corrected|Correction)|^\w{6} \w{4} \d{6} CC[A-Z]\b",
            body,
            re.I | re.M,
        )
    )
    return (fname.split("_")[0], heading, tuple(ugc)), corrected


def pns_rows(end):
    info = source_info("NWS Public Information Statements via IEM", PNS, end)
    start = end - timedelta(hours=HOURS)
    url = (
        BULK
        + "?"
        + urlencode(
            {
                "pil": "PNS",
                "fmt": "zip",
                "limit": "9999",
                "sdate": stamp(start),
                "edate": stamp(end + timedelta(minutes=1)),
            }
        )
    )
    records = {}
    products = Counter()
    last = None
    read = 0
    editions = []
    superseded = 0
    try:
        buf = fetch(url, 18_000_000, "application/zip")
        with ZipFile(BytesIO(buf)) as z:
            entries = z.infolist()
            if len(entries) >= 9999 or sum(f.file_size for f in entries) > 65_000_000:
                raise ValueError("Incomplete or oversized archive.")
            for f in entries:
                if f.is_dir():
                    continue
                read += 1
                try:
                    body = z.read(f).decode("utf-8", errors="replace").replace("\r", "")
                    rows, kind, issued = pns_product(f.filename, body, end)
                    if kind in ("partial", "measurement", "unresolvedStations"):
                        series, corrected = correction_series(f.filename, body)
                        editions.append((issued, series, corrected, rows, kind))
                except (ValueError, csv.Error, BadZipFile, KeyError):
                    products["unsupported"] += 1
                    continue
                products[kind] += 1
                if issued:
                    last = max(last, issued) if last else issued
    except ERR:
        return [], info
    active = []
    for issued, series, corrected, rows, kind in sorted(editions, key=lambda e: e[0]):
        if corrected and series[1]:
            keep = [e for e in active if not (e[1] == series and issued - e[0] <= timedelta(hours=6))]
            superseded += len(active) - len(keep)
            active = keep
        active.append((issued, series, rows, kind))
    for _, _, rows, _ in active:
        for r in rows:
            point = (r["latitude"], r["longitude"]) if r["latitude"] is not None else r["place"].lower()
            key = (
                r["office"],
                r["state"],
                point,
                r["observedAt"],
                r["measurementType"],
                r["durationHours"],
                r["periodLabel"],
            )
            old = records.get(key)
            if old and old["issuedAt"] == r["issuedAt"] and old["value"] != r["value"]:
                key = key + (r["value"],)
            r["id"] = "pns-" + row_id(key)
            records[key] = r
    active_kinds = Counter(kind for _, _, _, kind in active)
    incomplete = products["unsupported"] + active_kinds["partial"] + active_kinds["unresolvedStations"]
    note = "Individual time-stamped PNS measurements use station coordinates when published. Daily multi-element climate-summary tables are outside this index."
    if active_kinds["unresolvedStations"]:
        note += " Some alternate station names could not be reconciled between bulletin tables. The verified compact observations are retained."
    info.update(
        asOf=stamp(end),
        status="partial" if incomplete else "ok",
        bulletinsExamined=read,
        tableProducts=products["measurement"] + products["partial"] + products["unresolvedStations"],
        otherProducts=products["other"],
        climateSummaryProducts=products["climateSummary"],
        incompleteProducts=incomplete,
        unresolvedStationProducts=active_kinds["unresolvedStations"],
        supersededBulletins=superseded,
        latestIssuedAt=stamp(last),
        note=note,
    )
    return list(records.values()), info


def bounded(rows, limit, leaders):
    priority = {r["id"] for group in leaders.values() for r in group}
    pinned = [r for r in rows if r["id"] in priority]
    groups = defaultdict(deque)
    for r in rows:
        if r["id"] not in priority:
            groups[(r["sourceType"], r["category"])].append(r)
    kept = list(pinned[:limit])
    while groups and len(kept) < limit:
        for k in list(groups):
            kept.append(groups[k].popleft())
            if not groups[k]:
                del groups[k]
            if len(kept) == limit:
                break
    return sorted(kept, key=lambda r: r["observedAt"], reverse=True)


def collect(now, board=None):
    current = instant(now)
    if not current:
        raise ValueError("Timezone-aware collection time required")
    end = current.replace(second=0, microsecond=0)
    # The public edition can precede the page build by a few minutes. Compare
    # both archives over the same 48 hours, retaining the actual review time.
    report_source = report_archive(board)
    cutoff = instant(report_source.get("window_end"))
    if (cutoff and report_source.get("query_complete") is True and report_source.get("status") == "ok"
            and end - timedelta(minutes=10) <= cutoff <= end):
        end = cutoff
    with ThreadPoolExecutor(max_workers=2) as ex:
        lsr = ex.submit(lsr_rows, board, end)
        pns = ex.submit(pns_rows, end)
        lrows, li = lsr.result()
        prows, pi = pns.result()
    check_shared_lsr_links(lrows, li)
    for rows, info in ((lrows, li), (prows, pi)):
        if info["status"] in {"ok", "partial"}:
            info["located"] = sum(r["latitude"] is not None for r in rows)
            info["unlocated"] = len(rows) - info["located"]
            info["count"] = len(rows) if info["status"] == "ok" else None
            if not info["latestIssuedAt"]:
                info["latestIssuedAt"] = max((r["issuedAt"] for r in rows), default=None)
    rows = sorted(lrows + prows, key=lambda r: (r["observedAt"], r["issuedAt"]), reverse=True)
    leaders = {}
    for cat, typ in LEADERS.items():
        candidates = [
            r
            for r in rows
            if r["measurementType"] == typ
            and r.get("eligibleForBrief") is not False
            and r["value"] is not None
            and (r["value"] > 0 or cat in ("cold", "heat"))
        ]
        candidates.sort(key=lambda r: r["value"], reverse=cat != "cold")
        group = []
        places = set()
        points = set()
        for r in candidates:
            where = (r["state"], r["place"].lower())
            pt = (round(r["latitude"], 2), round(r["longitude"], 2)) if r["latitude"] is not None else None
            if where in places or pt is not None and pt in points:
                continue
            group.append(r)
            places.add(where)
            points.add(pt)
            if len(group) == 5:
                break
        leaders[cat] = group
    located = [r for r in rows if r["latitude"] is not None]
    unlocated = [r for r in rows if r["latitude"] is None]
    statuses = {li["status"], pi["status"]}
    exact = statuses == {"ok"}
    leader_status = {
        k: (
            "available"
            if group and exact
            else "partial"
            if group
            else "noQualifyingReport"
            if exact
            else "unknown"
        )
        for k, group in leaders.items()
    }
    return {
        "status": statuses.pop() if len(statuses) == 1 else "partial",
        "checkedAt": stamp(current),
        "asOf": stamp(end),
        "windowStart": stamp(end - timedelta(hours=HOURS)),
        "periodHours": HOURS,
        "sources": {"lsr": li, "pns": pi},
        "features": bounded(located, LOCATED_LIMIT, leaders),
        "unlocated": bounded(unlocated, UNLOCATED_LIMIT, leaders),
        "counts": {
            "located": len(located) if exact else None,
            "unlocated": len(unlocated) if exact else None,
            "availableLocated": len(located),
            "availableUnlocated": len(unlocated),
            "locatedLimit": LOCATED_LIMIT,
            "unlocatedLimit": UNLOCATED_LIMIT,
            "truncated": len(located) > LOCATED_LIMIT or len(unlocated) > UNLOCATED_LIMIT,
        },
        "leaders": leaders,
        "leaderStatus": leader_status,
        "notes": [
            "Measurements are preliminary. The same observation can appear in an LSR and a PNS. Accumulation periods can differ.",
            "Rankings show the highest available report at distinct locations for each measurement, or the lowest wind chill. Rows without source coordinates are listed separately.",
        ],
    }


if __name__ == "__main__":
    print(json.dumps(collect(datetime.now(UTC)), ensure_ascii=False, allow_nan=False))
