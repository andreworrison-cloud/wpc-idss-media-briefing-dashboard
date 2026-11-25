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
LOCATED_LIMIT, UNLOCATED_LIMIT = 1000, 250
BULK = "https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py"
BOARD = "https://wpc-impact-briefing.aorrison.chatgpt.site/api/board"
PAGES_BOARD = "https://andreworrison-cloud.github.io/wpc-idss-media-briefing-dashboard/data/board.json"
TEXT = "https://mesonet.agron.iastate.edu/api/1/nwstext/"
LSR = "https://mesonet.agron.iastate.edu/lsr/"
PNS = "https://www.weather.gov/aly/PNS_Reports"
ABBR = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI".split()
NAMES = "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|District of Columbia|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|American Samoa|Guam|Northern Mariana Islands|Puerto Rico|Virgin Islands".lower().split(
    "|"
)
STATES = dict(zip(NAMES, ABBR))
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


def lsr_rows(board, end):
    info = source_info("NWS Local Storm Reports via IEM", LSR, end)
    if board is None:
        for url in (BOARD, PAGES_BOARD):
            try:
                board = json.loads(fetch(url, 14_000_000, "application/json"))
                if isinstance(board.get("sources", {}).get("reports"), dict):
                    break
            except (OSError, HTTPException, ValueError, AttributeError, KeyError):
                continue
    src = (board or {}).get("sources", {}).get("reports") if isinstance(board, dict) else None
    if not isinstance(src, dict) or not isinstance(src.get("events"), list):
        return [], info
    cutoff, start = instant(src.get("window_end")), instant(src.get("window_start"))
    if not cutoff or not start or cutoff > end or start > cutoff:
        return [], info
    info["asOf"] = stamp(cutoff)
    if end - cutoff > timedelta(hours=2) or src.get("status") == "stale":
        info["status"] = "stale"
        return [], info
    if src.get("status") not in ("partial", "ok"):
        return [], info
    partial = (
        src.get("status") != "ok"
        or src.get("query_complete") is not True
        or start > end - timedelta(hours=HOURS)
        or (board.get("health") or {}).get("reports", {}).get("retained")
    )
    rows = {}
    for item in src["events"]:
        if not isinstance(item, dict):
            partial = True
            continue
        name = item.get("title", "")
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
        link = item.get("source_url", "")
        match = PRODUCT.fullmatch(link)
        if (
            not match
            or match[1] != issued.strftime("%Y%m%d%H%M")
            or item.get("state") not in ABBR
            or not item.get("id")
            or item.get("revision_match") == "unmatched"
            or observed > issued
        ):
            partial = True
            continue
        typ = LSR_TYPES.get(key, "event")
        dur = number(item.get("accumulation_hours"))
        q = item.get("qualifier")
        row = report(
            "LSR",
            item.get("wfo"),
            item["state"],
            place(item.get("city")),
            place(item.get("county")),
            item.get("lat"),
            item.get("lon"),
            observed,
            issued,
            link,
            typ,
            name,
            "T" if item.get("trace") else item.get("magnitude"),
            item.get("unit"),
            q if q in ("Measured", "Estimated") else "Reported",
            dur if dur and dur > 0 else None,
        )
        row["impactFlags"] = [flag for flag in item.get("impact_flags", []) if flag in SAFE_FLAGS]
        row["id"] = item["id"]
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
    if re.search(
        r"FORECAST|NORMALS?|HISTORY|SNOW WATER EQUIVALENT|MAY INCLUDE|AMOUNTS INCLUDE|MIXTURE OF|PLEASE NOTE",
        s,
    ):
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
        (r"HAIL", "hailDiameter"),
        (r"WIND CHILL", "windChill"),
        (r"HEAT IND(?:EX|ICES)", "heatIndex"),
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
    state = None
    county = None
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
            if state_code not in ABBR:
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
            machine.append(r)
            continue
        striped = ln.strip(".* ").strip()
        if striped.lower() in STATES:
            state = STATES[striped.lower()]
            county = None
            continue
        if ln.startswith("...") or ln.startswith("***"):
            if re.search(
                r"\b(?:county|parish|borough|census area|municipality)(?: [A-Z]{2})?$", striped, re.I
            ):
                county = place(
                    re.sub(
                        r"\s+(?:county|parish|borough|census area|municipality)(?: [A-Z]{2})?$",
                        "",
                        striped,
                        flags=re.I,
                    )
                )
                continue
            if re.search(r"MAY INCLUDE|AMOUNTS INCLUDE|PLEASE NOTE", striped, re.I):
                continue
            new = heading_kind(striped)
            if new:
                typ = new
                seen_table = True
                duration = heading_duration(striped)
                period = "Storm total" if "STORM TOTAL" in striped.upper() else None
                state = None
                county = None
                unit = None
                continue
            if "OCEAN" in striped.upper() or striped.upper().startswith(
                ("GULF OF", "LAKE ERIE", "LAKE MICHIGAN", "LAKE SUPERIOR")
            ):
                state = None
                county = None
            elif typ:
                typ = None
                state = None
                county = None
            continue
        if ln == "&&":
            typ = None
            continue
        if not typ or not state:
            if typ and re.search(r"\(in\.?\)|\(mph\)|\(inches\)", ln, re.I):
                unit = "mph" if "mph" in ln.lower() else "in"
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
        if r["value"] is not None or r["trace"]:
            display.append(r)
        else:
            errors += 1
    if not seen_table:
        return [], "other", issued
    matched = merge_tables(machine, display)
    return matched, ("partial" if errors or not table_lines else "measurement"), issued


def join_key(row):
    typ = "liquid" if row["category"] == "rain" else row["measurementType"]
    # The public display rounds station observations, e.g. 2.742 to 2.74 inches.
    return (
        row["state"],
        str(row["county"] or "").lower(),
        typ,
        row["observedAt"],
        None if row["value"] is None else round(row["value"] + 1e-9, 2),
        row["trace"],
    )


def locality(name):
    if not name:
        return ""
    s = name.lower().strip()
    s = re.sub(r"^\d+(?:\.\d+)?\s+[nsew]{1,3}\s+", "", s)
    s = re.sub(r"\s+\d+(?:\.\d+)?\s*[nsew]{1,3}$", "", s)
    return s.strip()


def merge_tables(machine, display):
    if not machine:
        return display
    mg = defaultdict(list)
    dg = defaultdict(list)
    for r in machine:
        mg[join_key(r)].append(r)
    for r in display:
        dg[join_key(r)].append(r)
    out = []
    for key, rows in mg.items():
        views = dg.pop(key, [])
        for r in rows:
            original = r.pop("_name")
            direct = [v for v in views if original and v["place"].lower() == original.lower()]
            if not direct and original:
                direct = [v for v in views if locality(original) == locality(v["place"])]
            v = direct[0] if len(direct) == 1 else views[0] if len(rows) == len(views) == 1 else None
            if v:
                r["place"] = v["place"]
                if v["value"] is not None:
                    r["value"] = v["value"]
                if r["latitude"] is None and v["latitude"] is not None:
                    r["latitude"], r["longitude"] = v["latitude"], v["longitude"]
            elif original and (
                re.match(r"^\d+(?:\.\d+)?\s+[NSEW]{1,3}\s+", original, re.I)
                or any(original.lower() == v["place"].lower() for v in views)
            ):
                r["place"] = original
            else:
                r["place"] = r["county"] + " reporting area" if r["county"] else r["state"]
            out.append(r)
    for rows in dg.values():
        out.extend(rows)
    return out


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
                body = z.read(f).decode("utf-8", errors="replace").replace("\r", "")
                rows, kind, issued = pns_product(f.filename, body, end)
                products[kind] += 1
                read += 1
                if issued:
                    last = max(last, issued) if last else issued
                if kind in ("partial", "measurement"):
                    series, corrected = correction_series(f.filename, body)
                    editions.append((issued, series, corrected, rows))
    except ERR:
        return [], info
    active = []
    for issued, series, corrected, rows in sorted(editions, key=lambda e: e[0]):
        if corrected and series[1]:
            keep = [e for e in active if not (e[1] == series and issued - e[0] <= timedelta(hours=6))]
            superseded += len(active) - len(keep)
            active = keep
        active.append((issued, series, rows))
    for _, _, rows in active:
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
    info.update(
        asOf=stamp(end),
        status="partial" if products["unsupported"] or products["partial"] else "ok",
        bulletinsExamined=read,
        tableProducts=products["measurement"] + products["partial"],
        otherProducts=products["other"],
        supersededBulletins=superseded,
        latestIssuedAt=stamp(last),
        note="Published measurement tables. Administrative statements and free-form narratives are excluded.",
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
    with ThreadPoolExecutor(max_workers=2) as ex:
        lsr = ex.submit(lsr_rows, board, end)
        pns = ex.submit(pns_rows, end)
        lrows, li = lsr.result()
        prows, pi = pns.result()
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
