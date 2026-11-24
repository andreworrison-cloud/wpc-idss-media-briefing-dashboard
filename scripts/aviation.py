"""Public briefing view of the FAA NAS Active Airport Events display (stdlib only)."""

from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from http.client import HTTPException
from html.parser import HTMLParser
import json
import math
import re
from time import monotonic
from urllib.error import URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen
from xml.etree import ElementTree

FAA_SITE = "https://nasstatus.faa.gov/"
EVENTS_URL = FAA_SITE + "api/airport-events"
XML_URL = FAA_SITE + "api/airport-status-information"
FLIGHTAWARE_AIRPORT = "https://www.flightaware.com/live/cancelled/today/"
FLIGHTAWARE_US = FLIGHTAWARE_AIRPORT + "US"
FACILITIES_URL = (
    "https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/"
    "NTAD_Aviation_Facilities/FeatureServer/0"
)
JURISDICTIONS = set(
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO "
    "MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY "
    "AS GU MP PR VI UM".split()
)
MAX_AGE = timedelta(minutes=30)
MAX_BYTES = 4 * 1024 * 1024
UTC = timezone.utc

KINDS = {
    "airportClosure": ("airport_closure", "Airport closure notice", "Issued notice"),
    "freeForm": ("airport_closure", "Airport closure notice", "Issued notice"),
    "groundStop": ("ground_stop", "Ground stop", "Issued program"),
    "groundDelay": ("ground_delay", "Ground delay program", "Program estimate"),
    "arrivalDelay": ("arrival_delay", "Arrival delay", "Reported delay"),
    "departureDelay": ("departure_delay", "Departure delay", "Reported delay"),
    "deicing": ("deicing", "Deicing", "Reported operation"),
}
PRIORITY = (
    "ground_stop", "airport_closure", "ground_delay", "arrival_delay",
    "departure_delay", "deicing", "airport_restriction",
)
TREND = {"increasing": "increasing", "decreasing": "decreasing", "steady": "steady",
         "unchanged": "unchanged"}
# Allow standard FAA condition fields to reach the display. Withhold any field
# containing contact details instead of republishing operational contacts.
CONTACT = re.compile(
    r"@|https?://|\b(?:CTC|TEL|CALL|CONTACT|PHONE|FAX|EMAIL)\b|\d(?:[().\s+\-]*\d){6}",
    re.IGNORECASE,
)
NETWORK_ERRORS = (OSError, URLError, HTTPException, ValueError, ElementTree.ParseError)


def iso(stamp):
    return stamp.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z") if stamp else None


def utc_time(value):
    if not value:
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    if not isinstance(value, datetime) or value.tzinfo is None:
        return None
    return value.astimezone(UTC)


def source_time(value):
    if not value:
        return None
    try:
        return utc_time(parsedate_to_datetime(value))
    except (TypeError, ValueError, OverflowError):
        return None


def fetch(url, accept):
    req = Request(url, headers={"Accept": accept, "User-Agent": "WPC-IDSS-briefing/1.0"})
    with urlopen(req, timeout=12) as response:
        body = response.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise ValueError("FAA response exceeds the expected size")
        return body, source_time(response.headers.get("Date"))


def public_text(value, limit=125):
    if not isinstance(value, str):
        return None
    value = " ".join(value.split())
    if not value or len(value) > limit or CONTACT.search(value) or any(c in value for c in "<>{}"):
        return None
    return value


def condition(value):
    value = public_text(value)
    if not value:
        return None
    standard = {"TM INITIATIVES:MIT:VOL": "Traffic volume requires extra spacing between flights",
                "TM INITIATIVES:MIT:WX": "Weather requires extra spacing between flights",
                "VOL": "Traffic volume", "WX": "Weather"}
    if value.upper() in standard:
        return standard[value.upper()]
    # Common ATCSCC reports encode weather as WX:Wind or WEATHER / THUNDERSTORMS.
    value = re.sub(r"^(?:WX|WEATHER)\s*[:/]\s*", "", value, flags=re.I)
    value = re.sub(r"\s*:\s*", " / ", value)
    if value.isupper():
        value = value.lower()
    return value[:1].upper() + value[1:]


def number(value, minimum, maximum):
    if isinstance(value, bool):
        return None
    try:
        value = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if math.isfinite(value) and minimum <= value <= maximum:
        return int(value) if value.is_integer() else value
    return None


def minute_count(value):
    if isinstance(value, str):
        match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(?:min(?:ute)?s?)?", value.strip(), re.I)
        if not match:
            return None
        value = match[1]
    return number(value, 0, 10080)


def advisory_url(value):
    if not isinstance(value, str) or len(value) > 1500:
        return None
    parts = urlsplit(value)
    if parts.scheme not in {"http", "https"} or parts.netloc.lower() not in {
        "www.fly.faa.gov", "fly.faa.gov", "nasstatus.faa.gov", "www.faa.gov",
    }:
        return None
    return urlunsplit(("https", parts.netloc, parts.path, urlencode(parse_qsl(parts.query)), ""))


def closure_scope(record):
    # Only publish known notice categories. NOTAM remarks may include phone
    # numbers, named staff, schedules and operating permissions or exceptions.
    text = " ".join(str(record.get(k) or "").upper() for k in ("text", "simpleText"))
    if re.search(r"\b(?:NON[- ]?SKED|UNSCHEDULED)\s+TRANSIENT\s+(?:GA|GENERAL AVIATION)\b", text):
        scope = "Applies to unscheduled transient general aviation."
        if re.search(r"\b(?:PPR|PRIOR PERMISSION)\b", text):
            scope += " The FAA lists a prior-permission exception."
        return "airport_restriction", "General aviation restriction", scope
    if re.search(r"\bRWY\s+[\dLRC/ -]+\s+CLSD\b", text):
        return "airport_restriction", "Runway restriction", "The notice concerns runway access. See FAA for the scope and hours."
    if (str(record.get("text") or "").strip().upper().startswith("TO ") or
            re.search(r"\b(?:EXC|EXCEPT|PPR|DLY|DAILY|MON|TUE|WED|THU|FRI|SAT|SUN)\b|\bCLSD TO\b", text)):
        return "airport_restriction", "Airport operating restriction", "The FAA notice specifies exceptions, operating limits or hours."
    return "airport_closure", "Airport closure notice", "Consult the FAA notice for the closure's scope and hours."


def program_scope(kind, airport, record):
    scope = (f"Participating flights to {airport} are held at their departure airport."
             if kind == "ground_stop" else f"Participating flights to {airport} receive assigned departure times.")
    included = str(record.get("includedFlights") or "").strip(": ").upper()
    if included == "ALL CONTIGUOUS US DEP":
        scope += " The FAA includes all contiguous U.S. departures."
    return scope


def display_delay(kind, record):
    if kind == "ground_delay":
        avg, high = minute_count(record.get("avgDelay")), minute_count(record.get("maxDelay"))
        parts = []
        if avg is not None:
            parts.append(f"Avg {avg:g} min")
        if high is not None:
            parts.append(f"max {high:g} min")
        return ", ".join(parts) or None
    if kind in ("arrival_delay", "departure_delay"):
        bounds = record.get("arrivalDeparture") or {}
        if not isinstance(bounds, dict):
            raise ValueError("Malformed FAA delay range")
        low, high = minute_count(bounds.get("min")), minute_count(bounds.get("max"))
        trend = TREND.get(str(bounds.get("trend") or record.get("trend")).lower())
        if low is not None and high is not None and low <= high:
            duration = f"{low:g}–{high:g} min" if low != high else f"{low:g} min"
        else:
            average = minute_count(record.get("averageDelay"))
            duration = f"Avg {average:g} min" if average is not None else None
        return ", ".join(v for v in (duration, trend) if v) or None
    return None


def event(airport, source, key, record, snapshot_at, now):
    kind, label, basis = KINDS[key]
    start = utc_time(record.get("startTime") or record.get("eventTime"))
    end = utc_time(record.get("endTime") or record.get("expTime"))
    updated = utc_time(record.get("updateTime") or record.get("updatedAt") or
                       record.get("sourceTimeStamp") or record.get("issuedDate"))
    for field in ("startTime", "endTime", "eventTime", "expTime"):
        if record.get(field) and utc_time(record[field]) is None:
            raise ValueError("Malformed FAA event time")
    if record.get("airportId") and record["airportId"] != airport:
        raise ValueError("Inconsistent FAA airport identifier")
    # A ground stop's end is the expected next FAA update. A passed update
    # time alone does not release participating flights from an FAA-listed stop.
    if kind != "ground_stop" and end and end <= now:
        return None
    if kind == "airport_closure":
        kind, label, scope = closure_scope(record)
    elif kind in ("ground_delay", "ground_stop"):
        scope = program_scope(kind, airport, record)
    else:
        scope = {
            "arrival_delay": f"Arrivals at {airport}.",
            "departure_delay": f"Departures from {airport}.",
            "deicing": f"The FAA lists deicing operations at {airport}.",
        }[kind]
    latitude = number(source.get("latitude"), -90, 90)
    longitude = number(source.get("longitude"), -180, 180)
    if latitude is None or longitude is None or (latitude, longitude) == (0, 0):
        latitude = longitude = None
    return {
        "airport": airport, "airport_name": public_text(source.get("airportLongName")),
        "city": None, "state": None, "icao": None, "flight_counts_url": None,
        "lat": latitude, "lon": longitude, "kind": kind, "label": label, "scope": scope,
        "reason": condition(record.get("impactingCondition") or record.get("reason")),
        "delay": display_delay(kind, record), "phase": "scheduled" if start and start > snapshot_at else "active",
        "time_basis": basis, "start_utc": iso(start), "end_utc": iso(end), "updated_utc": iso(updated),
        "end_label": "Next FAA update expected" if kind == "ground_stop" else "Scheduled end",
        "source_url": advisory_url(record.get("advisoryUrl")) or FAA_SITE,
    }


def base(now):
    return {
        "status": "unavailable", "as_of": None, "as_of_basis": None, "retrieved_at": iso(now),
        "source_label": "FAA National Airspace System Status", "source_url": FAA_SITE,
        "data_url": EVENTS_URL, "location_source_url": FACILITIES_URL,
        "coverage": "FAA-listed airport programs, reported delays, closure and deicing notices.",
        "event_count": None, "affected_airports": None, "airports": [], "events": [], "scheduled_events": [],
        "detail": "FAA airport status could not be verified.",
        "flight_counts": {
            "delayed": None, "cancelled": None, "status": "external_only",
            "detail": "Live flight totals require a feed licensed for public display. FlightAware provides its U.S. counts at the linked source.",
            "coverage": "Flights within, into or out of the United States, for FlightAware’s reporting day.",
            "url": FLIGHTAWARE_US,
        },
    }


def parse(records, snapshot_at, now):
    if not isinstance(records, list):
        raise ValueError("Unexpected FAA airport list")
    active, scheduled = [], []
    seen = set()
    for row in records:
        if not isinstance(row, dict) or not isinstance(row.get("airportId"), str):
            raise ValueError("Missing FAA airport")
        airport = row["airportId"].strip().upper()
        if not re.fullmatch(r"[A-Z0-9]{2,5}", airport) or not any(k in row for k in (*KINDS, "airportConfig")):
            raise ValueError("Unexpected FAA airport fields")
        for key in KINDS:
            rec = row.get(key)
            if rec is None:
                continue
            if not isinstance(rec, dict) or not rec:
                raise ValueError("Malformed FAA airport event")
            entry = event(airport, row, key, rec, snapshot_at, now)
            if entry is None:
                continue
            # The same notice occasionally appears in both closure fields.
            identity = (airport, entry["kind"], rec.get("notamNumber") or rec.get("simpleText") or rec.get("id"),
                        entry["start_utc"], entry["end_utc"])
            if identity in seen:
                continue
            seen.add(identity)
            (scheduled if entry["phase"] == "scheduled" else active).append(entry)
    active.sort(key=lambda e: (PRIORITY.index(e["kind"]), e["airport"]))
    scheduled.sort(key=lambda e: (e["start_utc"], e["airport"], e["kind"]))
    return active, scheduled



def airport_locations(airports):
    """Join only unambiguous FAA identifiers against USDOT's official facility layer."""
    airports = sorted(set(airports))
    locations = {}
    for start in range(0, len(airports), 60):
        batch = set(airports[start:start + 60])
        # All identifiers have passed the airport-ID validation in parse().
        codes = ",".join(f"'{a}'" for a in sorted(batch))
        params = {"where": f"ARPT_ID IN ({codes}) OR ICAO_ID IN ({codes})",
                  "outFields": "ARPT_ID,ICAO_ID,CITY,STATE_CODE,ARPT_NAME,LAT_DECIMAL,LONG_DECIMAL",
                  "returnGeometry": "false", "f": "json"}
        try:
            body, _ = fetch(FACILITIES_URL + "/query?" + urlencode(params), "application/json")
            data = json.loads(body)
            if not isinstance(data, dict) or not isinstance(data.get("features"), list) or data.get("exceededTransferLimit"):
                continue
            matches = {}
            for feature in data["features"]:
                attrs = feature.get("attributes", {}) if isinstance(feature, dict) else {}
                if not isinstance(attrs, dict):
                    continue
                keys = {attrs.get("ARPT_ID"), attrs.get("ICAO_ID")} & batch
                for key in keys:
                    matches.setdefault(key, []).append(attrs)
            for key, options in matches.items():
                if len(options) == 1:
                    locations[key] = options[0]
        except (TypeError, *NETWORK_ERRORS):
            continue
    return locations


def add_locations(events):
    locations = airport_locations(e["airport"] for e in events)
    for entry in events:
        attrs = locations.get(entry["airport"], {})
        state = attrs.get("STATE_CODE")
        if isinstance(state, str) and state in JURISDICTIONS:
            entry["state"] = state
        city = public_text(attrs.get("CITY"))
        entry["city"] = city.title() if city and city.isupper() else city
        icao = attrs.get("ICAO_ID") or ""
        if isinstance(icao, str) and re.fullmatch(r"[A-Z]{4}", icao):
            entry["icao"] = icao
            entry["flight_counts_url"] = FLIGHTAWARE_AIRPORT + icao
        if not entry["airport_name"]:
            entry["airport_name"] = public_text(attrs.get("ARPT_NAME"))
        if entry["lat"] is None:
            lat, lon = number(attrs.get("LAT_DECIMAL"), -90, 90), number(attrs.get("LONG_DECIMAL"), -180, 180)
            if lat is not None and lon is not None and (lat, lon) != (0, 0):
                entry.update(lat=lat, lon=lon)


MONTHS = "January February March April May June July August September October November December".split()
BTS_URL = "https://www.transtats.bts.gov/HomeDrillChart_Month.asp"
BTS_HEADER = [
    "Month", "Ontime Arrivals", "Ontime (%)", "Arrival Delays", "Delayed (%)",
    "Flights Cancelled", "Cancelled (%)", "Diverted", "Flight Operations",
]


class ReportingTable(HTMLParser):
    """Read the published BTS table and the scope selected on the same page."""
    def __init__(self):
        super().__init__()
        self.rows = []
        self.row = []
        self.cell = None
        self.selection = None
        self.option = False
        self.filters = {}
        self.reporting_title = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "tr":
            self.row = []
        elif tag in ("th", "td"):
            self.cell = []
        elif tag == "select":
            self.selection = (attrs.get("name") or "").lower()
        elif tag == "option":
            self.option = "selected" in attrs

    def handle_data(self, text):
        if "Reporting Operating Carrier Flight Delays at a Glance" in text:
            self.reporting_title = True
        if self.option and self.selection and text.strip():
            self.filters[self.selection] = text.strip()
        if self.cell is not None:
            self.cell.append(text)

    def handle_endtag(self, tag):
        if tag in ("th", "td") and self.cell is not None:
            self.row.append(" ".join("".join(self.cell).split()))
            self.cell = None
        elif tag == "tr" and self.row:
            self.rows.append(self.row)
            self.row = []
        elif tag == "option":
            self.option = False
        elif tag == "select":
            self.selection = None


def parse_monthly(html, now):
    report = ReportingTable()
    report.feed(html)
    if (not report.reporting_title or report.filters.get("airport") != "All Airports" or
            report.filters.get("carrier") != "All Carriers"):
        raise ValueError("BTS reporting scope changed")
    year = int(report.filters.get("xyear", ""))
    if not 1987 <= year <= now.year:
        raise ValueError("Invalid BTS report year")
    header_index = report.rows.index(BTS_HEADER)
    latest = None
    for cells in report.rows[header_index + 1:]:
        if len(cells) != len(BTS_HEADER) or cells[0] not in MONTHS:
            break
        month = MONTHS.index(cells[0]) + 1
        counts = [v.replace(",", "") for v in (cells[1], cells[3], cells[5], cells[7], cells[8])]
        if not all(re.fullmatch(r"[0-9]+", v) for v in counts):
            raise ValueError("Invalid BTS flight count")
        on_time, delayed, cancelled, diverted, total = map(int, counts)
        if on_time + delayed + cancelled + diverted != total or total <= 0:
            raise ValueError("BTS flight counts do not reconcile")
        if (year, month) >= (now.year, now.month):
            raise ValueError("Incomplete BTS reporting month")
        monthly_period = f"{year}-{month:02d}"
        if latest and monthly_period <= latest["period"]:
            raise ValueError("Unexpected BTS month order")
        latest = {"period": monthly_period, "period_label": f"{cells[0]} {year}",
                  "delayed_arrivals": delayed, "cancelled": cancelled, "flight_operations": total}
    if latest is None:
        raise ValueError("Missing BTS reporting month")
    return latest


def monthly_context(now, previous=None):
    result = {
        "status": "unavailable", "period": None, "period_label": None, "delayed_arrivals": None,
        "cancelled": None, "flight_operations": None, "checked_at": None, "source_url": BTS_URL,
        "source_label": "U.S. DOT Bureau of Transportation Statistics",
        "coverage": "Domestic flights reported by U.S. reporting operating carriers at all airports.",
        "delay_definition": "Arrival at the gate at least 15 minutes after the scheduled time.",
        "detail": "Monthly carrier data could not be verified.",
    }
    previous = previous if isinstance(previous, dict) else {}
    checked = utc_time(previous.get("checked_at"))
    previous_period = previous.get("period")
    if (previous.get("status") == "historical" and previous.get("source_url") == BTS_URL and checked and
            checked <= now + timedelta(minutes=5) and isinstance(previous_period, str) and
            re.fullmatch(r"\d{4}-(?:0[1-9]|1[0-2])", previous_period) and
            previous_period < now.strftime("%Y-%m") and
            all(type(previous.get(k)) is int and previous[k] >= 0
                for k in ("delayed_arrivals", "cancelled", "flight_operations")) and
            0 < previous["flight_operations"] and previous["delayed_arrivals"] + previous["cancelled"] <= previous["flight_operations"]):
        result.update({k: previous[k] for k in ("period", "delayed_arrivals", "cancelled", "flight_operations")})
        year, month = previous_period.split("-")
        result.update(status="historical", period_label=f"{MONTHS[int(month) - 1]} {year}", checked_at=iso(checked),
                      detail="Historical monthly totals are published after carrier reporting.")
        if now - checked < timedelta(days=1):
            return result
    try:
        html, _ = fetch(BTS_URL, "text/html")
        latest = parse_monthly(html.decode("utf-8", errors="replace"), now)
        if result["period"] and latest["period"] < result["period"]:
            raise ValueError("BTS default table moved to an earlier period")
    except NETWORK_ERRORS:
        if result["status"] == "historical":
            result["detail"] = "Showing the last verified reporting month. The latest BTS table could not be checked."
        return result
    result.update(latest, status="historical", checked_at=iso(now),
                  detail="Historical monthly totals are published after carrier reporting.")
    return result


def collect(now_utc, previous_monthly=None):
    """Fetch FAA events plus independently dated BTS context. A prior month avoids repeat BTS reads."""
    started = monotonic()
    now = utc_time(now_utc)
    if now is None:
        raise ValueError("A timezone-aware collection time is required")
    result = base(now)
    result["monthly_context"] = monthly_context(now, previous_monthly)
    try:
        data, response_at = fetch(EVENTS_URL, "application/json")
        records = json.loads(data)
    except NETWORK_ERRORS:
        result["retrieved_at"] = iso(now + timedelta(seconds=monotonic() - started))
        return result
    try:
        xml, _ = fetch(XML_URL, "application/xml")
        feed = ElementTree.fromstring(xml)
        feed_at = source_time(feed.findtext("Update_Time")) if feed.tag == "AIRPORT_STATUS_INFORMATION" else None
    except NETWORK_ERRORS:
        feed_at = None
    now += timedelta(seconds=monotonic() - started)
    result["retrieved_at"] = iso(now)
    # The XML clock is the feed issue time. A cache can serve the JSON and
    # XML independently, so an older JSON response still limits freshness.
    source_clocks = [t for t in (response_at, feed_at) if t]
    as_of = min(source_clocks, default=None)
    if not as_of:
        result["detail"] = "FAA source time could not be verified."
        return result
    result.update(as_of=iso(as_of), as_of_basis=("FAA feed update" if as_of == feed_at else "FAA airport-events response"))
    if now - as_of > MAX_AGE or max(source_clocks) - now > timedelta(minutes=5):
        result.update(status="stale", detail="FAA source time is outside the current briefing window.")
        return result
    try:
        active, scheduled = parse(records, min(as_of, now), now)
    except (TypeError, ValueError):
        result["detail"] = "The FAA airport event format could not be verified."
        return result
    add_locations(active + scheduled)
    airports = sorted({entry["airport"] for entry in active})
    result.update(status="ok", event_count=len(active), affected_airports=len(airports), airports=airports,
                  events=active, scheduled_events=scheduled,
                  detail="Counts cover airport notices in effect. Delay minutes describe the specific report or program.")
    return result
