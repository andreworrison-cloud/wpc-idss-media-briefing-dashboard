"""Read the public Hydro radar package and WPC MetWatch bulletins. No private inputs."""
import concurrent.futures as cf
import hashlib
import json
import math
import re
import struct
import zlib
from datetime import datetime, timedelta, timezone
from io import BytesIO
from html import unescape
from xml.etree import ElementTree
from zipfile import ZipFile
from html.parser import HTMLParser
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

UTC = timezone.utc
HYDRO = "https://andreworrison-cloud.github.io/wpc-hydro-dashboard/"
REPOSITORY = "andreworrison-cloud/wpc-hydro-dashboard"
RADAR_ROOT = "https://raw.githubusercontent.com/" + REPOSITORY + "/"
BRANCH = "mrms-rala-data"
MANIFEST = "mrms_rala_loop_manifest.json"
RADAR_REF = "https://api.github.com/repos/" + REPOSITORY + "/git/ref/heads/" + BRANCH
WPC = "https://www.wpc.ncep.noaa.gov"
ORIGIN = "https://origin-east-www-wpc.woc.noaa.gov"
CURRENT_PATH = "/metwatch/metwatch_mpd.php"
DETAIL_PATH = "/metwatch/metwatch_mpd_multi.php"
NWS_PRODUCTS = "https://api.weather.gov/products/types/FFG/locations/MPD"
MINUTE = timedelta(minutes=1)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def iso(value):
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def from_iso(value):
    require(isinstance(value, str), "Missing UTC timestamp")
    t = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(t.tzinfo is not None, "Timestamp has no UTC offset")
    return t.astimezone(UTC)


def read_public(url, maximum):
    req = Request(url, headers={"User-Agent": "WPC-IDSS-Public-Research/0.3", "Cache-Control": "no-cache"})
    with urlopen(req, timeout=12) as response:
        require(response.status == 200, "Public data request returned an unexpected status")
        contents = response.read(maximum + 1)
    require(len(contents) <= maximum, "Public response exceeded its size limit")
    return contents


def json_read(fetch, url, maximum=2_500_000):
    return json.loads(fetch(url, maximum))


def check_now(value):
    if value is None:
        return datetime.now(UTC)
    if isinstance(value, str):
        return from_iso(value)
    require(isinstance(value, datetime) and value.tzinfo is not None, "Use an aware UTC checked time")
    return value.astimezone(UTC)


def check_radar(manifest, rev, now):
    require(re.fullmatch(r"[a-f0-9]{40}", rev), "Unknown radar package revision")
    require(manifest.get("metadata_mode") == "mrms_rala_loop_manifest_v2"
            and manifest.get("product") == "ReflectivityAtLowestAltitude"
            and manifest.get("region") == "CONUS" and manifest.get("units") == "dBZ",
            "Unexpected Hydro radar product")
    display = manifest["display"]
    require(display["projection"] == "EPSG:3857" and display["resampling"] == "nearest-neighbor"
            and display["smoothing"] is False and display["visible_minimum_dbz"] == 5,
            "Radar display projection or rendering contract changed")
    bounds = display["leaflet_bounds"]
    require(isinstance(bounds, list) and len(bounds) == 2 and all(len(p) == 2 for p in bounds)
            and all(math.isfinite(x) for p in bounds for x in p)
            and -85 <= bounds[0][0] < bounds[1][0] <= 85
            and -180 <= bounds[0][1] < bounds[1][1] <= 180,
            "Invalid geographic radar bounds")
    dimensions = [display["image_width_px"], display["image_height_px"]]
    require(all(type(x) is int and x > 0 for x in dimensions), "Invalid radar image dimensions")
    palette = display["color_table"]
    require(isinstance(palette, list) and len(palette) >= 2 and
            all(isinstance(row["threshold_dbz"], (int, float)) and math.isfinite(row["threshold_dbz"])
                and re.fullmatch(r"#[0-9a-fA-F]{6}", row["color"]) for row in palette)
            and all(a["threshold_dbz"] < b["threshold_dbz"] for a,b in zip(palette,palette[1:])),
            "Invalid radar legend")
    source = RADAR_ROOT + rev + "/"
    frames = []
    for row in manifest["frames"]:
        valid = from_iso(row["valid_time_utc"])
        name = "frames/mrms_rala_" + valid.strftime("%Y%m%dT%H%M%SZ.png")
        require(row["png"] == name and (not frames or frames[-1]["valid_time"] < iso(valid)),
                "Radar frame time, order or path disagrees")
        frames.append({"valid_time": iso(valid), "image_url": source + name})
    require(frames and frames[-1]["valid_time"] == iso(from_iso(manifest["latest_valid_time_utc"])),
            "Manifest time disagrees with the newest radar frame")
    require(manifest.get("frame_count") == len(frames) and manifest.get("target_frame_cadence_minutes") == 10,
            "Incomplete Hydro radar frame inventory")
    valid = from_iso(frames[-1]["valid_time"])
    generated = from_iso(manifest["generated_utc"])
    last = manifest["frames"][-1]
    source_url = urlsplit(last["source_url"])
    key = "MRMS_ReflectivityAtLowestAltitude_00.50_" + valid.strftime("%Y%m%d-%H%M%S.grib2.gz")
    require(last["source_key"] == key and source_url.path.endswith("/"+key)
            and source_url.scheme == "https" and source_url.hostname in {
                "mrms.ncep.noaa.gov", "noaa-mrms-pds.s3.amazonaws.com",
                "noaa-mrms-pds.s3.us-east-1.amazonaws.com", "s3.amazonaws.com"},
            "Radar source URL or timestamp disagrees")
    require(valid <= generated <= now + timedelta(minutes=2) and valid <= now,
            "Radar observation or generation time is in the future")
    limit = manifest["freshness_limit_minutes"]
    require(isinstance(limit,(int,float)) and 0 < limit <= 20, "Unexpected Hydro radar freshness limit")
    until = valid + timedelta(minutes=limit)
    receipt = manifest.get("publication_validation")
    if receipt:
        require(from_iso(receipt["latest_valid_time_utc"]) == valid and
                valid <= from_iso(receipt["checked_at_utc"]) <= until,
                "Hydro radar publication receipt disagrees")
    is_fresh = now < until
    return {
        "status": "current" if is_fresh else "stale",
        "reason": "Latest Hydro frame" if is_fresh else "Hydro radar observation exceeds its publication freshness limit.",
        "label": "MRMS lowest-altitude reflectivity", "provider": "NOAA MRMS via Hydro", "units": "dBZ", "domain": "CONUS",
        "checked_at": iso(now), "valid_time": iso(valid), "fresh_until": iso(until), "generated_at": iso(generated),
        "source_url": source + MANIFEST, "source_data_url": last["source_url"], "dashboard_url": HYDRO,
        "revision": rev, "projection": "EPSG:3857", "bounds": bounds, "image_dimensions": dimensions,
        "color_table": [{"threshold_dbz":r["threshold_dbz"],"color":r["color"]} for r in palette],
        "visible_minimum_dbz": 5, "cadence_minutes": 10, "freshness_minutes": limit,
        "frames": frames if is_fresh else [], "image_url": frames[-1]["image_url"] if is_fresh else None,
    }


def verified_image(radar, image, radar_images):
    digest = hashlib.sha256(image).hexdigest()
    radar["image_sha256"] = digest
    if radar_images is not None:
        radar_images[(radar["valid_time"], radar["image_url"], digest)] = image
    return radar


def collect_mrms(now, fetch, radar_images=None):
    # Read the branch head once. Both the manifest and every PNG then identify
    # the same Git snapshot even if Hydro publishes during this collection.
    source_url = RADAR_ROOT + BRANCH + "/" + MANIFEST
    try:
        ref = json_read(fetch, RADAR_REF + "?t=" + str(int(now.timestamp()) // 300), 40000)
        require(ref["ref"] == "refs/heads/" + BRANCH and ref["object"]["type"] == "commit",
                "Unexpected Hydro branch reference")
        rev = ref["object"]["sha"]
        require(re.fullmatch(r"[a-f0-9]{40}", rev), "Unexpected radar revision")
        source_url = RADAR_ROOT + rev + "/" + MANIFEST
        radar = check_radar(json_read(fetch, source_url), rev, now)
        if radar["status"] == "current":
            image = fetch(radar["image_url"], 12_000_000)
            require(len(image) >= 57 and image[:16] == bytes.fromhex("89504e470d0a1a0a0000000d49484452")
                    and list(struct.unpack(">II", image[16:24])) == radar["image_dimensions"]
                    and image[-12:] == bytes.fromhex("0000000049454e44ae426082"), "Invalid or incomplete radar PNG")
            verified_image(radar, image, radar_images)
        return radar
    except Exception as exc:
        return {"status":"unavailable","reason":str(exc)[:180],"label":"MRMS lowest-altitude reflectivity",
                "domain":"CONUS","units":"dBZ","valid_time":None,"fresh_until":None,"checked_at":iso(now),
                "source_url":source_url,"dashboard_url":HYDRO,"source_data_url":None,"image_url":None,
                "bounds":None,"projection":"EPSG:3857","color_table":[],"frames":[]}


IEM = "https://mesonet.agron.iastate.edu"
IEM_WMS = IEM + "/cgi-bin/wms/nexrad/n0q-t.cgi"
IEM_DOC = IEM + "/GIS/rasters.php?rid=2"
# The native 12200 x 5400 N0Q mosaic is sampled every 0.005 degrees with
# its first pixel centered at 126W 50N. GetMap uses a slightly inset rectangle.
IEM_BOUNDS = [[23.0, -126.0], [50.0, -65.0]]


def iem_image_url(valid):
    def mercator(lat, lon):
        r=6378137
        return r*math.radians(lon),r*math.log(math.tan(math.pi/4+math.radians(lat)/2))
    west,south=mercator(*IEM_BOUNDS[0])
    east,north=mercator(*IEM_BOUNDS[1])
    width=2100
    height=round(width*(north-south)/(east-west))
    params={"service":"WMS", "version":"1.1.1", "request":"GetMap", "layers":"nexrad-n0q-wmst",
            "styles":"", "format":"image/png", "transparent":"TRUE", "srs":"EPSG:3857",
            "bbox":",".join(f"{n:.3f}" for n in (west,south,east,north)), "width":width,"height":height,
            "time":iso(valid)}
    return IEM_WMS+"?"+urlencode(params),[width,height]


def nonblank_wms_png(raw, dimensions):
    """A WMS can return a transparent success PNG when no archived frame exists."""
    require(len(raw)>45 and raw[:16]==bytes.fromhex("89504e470d0a1a0a0000000d49484452")
            and list(struct.unpack(">II",raw[16:24]))==dimensions
            and raw[24:29]==bytes((8,6,0,0,0))
            and raw[-12:]==bytes.fromhex("0000000049454e44ae426082"),"Incomplete or unsupported WMS frame")
    at=8
    idat=[]
    while at<len(raw):
        size=struct.unpack(">I",raw[at:at+4])[0]
        require(at+size+12<=len(raw),"Truncated radar image")
        if raw[at+4:at+8] == b"IDAT":
            idat.append(raw[at+8:at+8+size])
        at+=size+12
    width,height=dimensions
    stride=width*4+1
    decomp=zlib.decompressobj()
    filtered=decomp.decompress(b"".join(idat),height*stride+1)
    require(decomp.eof and len(filtered)==height*stride,"Incomplete WMS image pixels")
    # A uniformly zero alpha plane leaves all alpha residuals zero under every
    # legal PNG filter. A nonzero residual proves at least one pixel is visible.
    require(any(any(filtered[i+4:i+stride:4]) for i in range(0,len(filtered),stride)),
            "WMS returned an empty transparent frame")


def collect_iem(now, fetch, radar_images=None):
    valid_dates=sorted({(now-20*MINUTE).date(),now.date()},reverse=True)
    candidates={}
    for day in valid_dates:
        directory=IEM+"/archive/data/"+day.strftime("%Y/%m/%d")+"/GIS/uscomp/"
        try:
            contents=fetch(directory,1_750_000).decode("utf-8",errors="replace")
            for stamp in set(re.findall(r'href=["\']n0q_(\d{12})\.png["\']',contents,re.I)):
                date=datetime.strptime(stamp,"%Y%m%d%H%M").replace(tzinfo=UTC)
                if (date.date()==day and date<=now and now-date<20*MINUTE and date.minute%5==0):
                    candidates[date]=directory+"n0q_"+stamp+".png"
        except Exception:
            continue
    require(candidates,"No dated IEM national reflectivity frame within 20 minutes")
    for valid in sorted(candidates,reverse=True):
        image_url,dimensions=iem_image_url(valid)
        try:
            raw=fetch(image_url,8_000_000)
            nonblank_wms_png(raw,dimensions)
        except Exception:
            continue
        colors=("#9098b4","#6376a8","#4568a6","#60b4d4","#43d67e","#0eb314","#0b840e","#327308",
                "#ffe200","#ffac00","#f80000","#aa0000","#ffeaff","#f960fa","#a400f7","#05eaf0","#04adb0")
        radar = {"status":"current","reason":"Dated IEM archive and a matching nonempty WMS frame verified.",
                "label":"NEXRAD base reflectivity","provider":"Iowa Environmental Mesonet (IEM)",
                "domain":"CONUS","units":"dBZ","checked_at":iso(now),"valid_time":iso(valid),
                "fresh_until":iso(valid+20*MINUTE), "freshness_minutes":20, "cadence_minutes":5,
                "projection":"EPSG:3857","bounds":IEM_BOUNDS,"image_dimensions":dimensions,
                "image_url":image_url,"source_url":IEM_DOC,"source_data_url":candidates[valid],
                "dashboard_url":HYDRO,
                "color_table":[{"threshold_dbz":i*5,"color":c} for i,c in enumerate(colors)],
                "frames":[{"valid_time":iso(t),"image_url":iem_image_url(t)[0]} for t in sorted(candidates) if t<=valid]}
        return verified_image(radar, raw, radar_images)
    raise ValueError("No verified nonempty IEM national WMS frame within 20 minutes")


def collect_radar(now,fetch,radar_images=None):
    primary=collect_mrms(now,fetch,radar_images)
    if primary["status"]=="current":
        return primary
    try:
        observed=collect_iem(now,fetch,radar_images)
        observed["primary"]={k:primary.get(k) for k in ("status","valid_time","source_url","reason")}
        return observed
    except Exception as exc:
        primary["alternate_status"]="unavailable"
        primary["alternate_reason"]=str(exc)[:150]
        return primary


class Text(HTMLParser):
    """Extract bulletin text and product listings, excluding scripts and styles."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.pre = []
        self.pre_stack = None
        self.ignored = False

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.ignored = True
        elif tag == "pre":
            self.pre_stack = []
        elif tag in {"br", "p", "td", "tr", "div"}:
            self.parts.append("\n")
            if self.pre_stack is not None:
                self.pre_stack.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.ignored = False
        elif tag == "pre" and self.pre_stack is not None:
            self.pre.append("".join(self.pre_stack))
            self.pre_stack = None

    def handle_data(self, data):
        if self.ignored:
            return
        self.parts.append(data)
        if self.pre_stack is not None:
            self.pre_stack.append(data)


def public_index(html):
    """Identify only active references. The static page also links the last expired MPD."""
    parser = Text()
    parser.feed(html)
    plain = " ".join(" ".join(parser.parts).split()).lower()
    require("current mesoscale precipitation discussions" in plain, "WPC current index heading missing")
    html = html.split("<!--Begin section to get Archived MPDs-->")[0]
    body = re.search(r"Current Mesoscale Precipitation Discussions.*", html, re.I | re.S)
    require(body, "WPC active section missing")
    content = body[0].split("**More About MPDs")[0]
    no_active = bool(re.search(r"No\s+MPDs\s+are\s+currently\s+in\s+effect", content, re.I))
    # Most recently issued is a historical reference even on a valid no-MPD day.
    content = re.sub(r"<a\b[^>]*>\s*Most recently issued MPD.*?</a>", "", content, flags=re.I|re.S)
    ids=set()
    for raw in re.findall(r"\b(?:href|HREF)\s*=\s*[\x22\x27]([^\x22\x27]+)[\x22\x27]", content):
        u=urlsplit(unescape(raw).strip())
        if u.path.rsplit("/",1)[-1]!="metwatch_mpd_multi.php":
            continue
        query=parse_qs(u.query)
        if not re.fullmatch(r"\d{1,4}",query.get("md",[""])[0].strip()):
            continue
        year=query.get("yr",[""])[0].strip()
        ids.add((int(year) if re.fullmatch(r"20\d\d",year) else None, int(query["md"][0].strip())))
    require(no_active != bool(ids), "WPC index has contradictory or missing active status")
    return no_active, ids


def latest_url(year, number):
    return f"{WPC}{DETAIL_PATH}?md={number:04d}&yr={year}"


def bulletin_from_html(html):
    parser = Text()
    parser.feed(html)
    bodies = [t for t in parser.pre if re.search(r"Mesoscale Precipitation Discussion\s+\d+", t, re.I)]
    require(bodies, "No numbered WPC bulletin in detail page")
    return bodies[-1]


def month_time(token, near):
    d, h, m = int(token[:2]), int(token[2:4]), int(token[4:])
    vals=[]
    for shift in (-1, 0, 1):
        y, zero_month = divmod(near.year*12 + near.month-1 + shift, 12)
        try:
            vals.append(datetime(y, zero_month+1, d, h, m, tzinfo=UTC))
        except ValueError:
            pass
    require(vals, "Invalid bulletin day/hour/minute")
    return min(vals, key=lambda t:abs(t-near))


def local_issued(text):
    match=re.search(r"^\s*(\d{1,2}):?(\d{2})\s*([AP]M)\s+(UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|HST|AKST|AKDT|AST)\s+[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(20\d\d)\s*$", text, re.M|re.I)
    if not match:
        return None
    h,m,part,zone,mo,d,y = match.groups()
    h=(int(h)%12)+(12 if part.upper()=="PM" else 0)
    offs={"UTC":0,"GMT":0,"EST":5,"EDT":4,"CST":6,"CDT":5,"MST":7,"MDT":6,
          "PST":8,"PDT":7,"HST":10,"AKST":9,"AKDT":8,"AST":4}
    month=("jan feb mar apr may jun jul aug sep oct nov dec".split()).index(mo.lower())+1
    return datetime(int(y),month,int(d),h,int(m),tzinfo=UTC)+timedelta(hours=offs[zone.upper()])


def distance(a,b):
    lat1,lat2=map(math.radians,(a[1],b[1]))
    x=math.sin(math.radians(b[1]-a[1])/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin(math.radians(b[0]-a[0])/2)**2
    return 12742*math.asin(math.sqrt(min(1,x)))


def text_polygon(text):
    groups = list(re.finditer(r"LAT\.{3}LON[ \t]+((?:\d{8,9}\b[ \t\r\n]*){3,})",text,re.I))
    require(groups,"Missing WPC LAT...LON polygon")
    ring = []
    for s in groups[-1][1].split():
        lat,lon=int(s[:4])/100,int(s[4:])/100
        if len(s)==8:
            if lon<40 or (40<=lon<80 and (lat>=49 or re.search(r"\b(ALASKA|ALEUTIAN|KODIAK|KENAI|ANCHORAGE)\b",text,re.I))) or (50<=lon<70 and re.search(r"\b(HAWAI[Iʻ’']*I?|KAUAI|OAHU|MAUI|MOLOKAI|LANAI|BIG ISLAND)\b",text,re.I)):
                lon+=100
        require(0<lat<90 and 0<lon<=180, "Invalid WPC coordinates")
        point=[-lon,lat]
        if not ring or point!=ring[-1]:
            ring.append(point)
    if ring[0]!=ring[-1]:
        ring.append(ring[0])
    require(len(ring)>=4 and len({tuple(p) for p in ring})>=3, "Degenerate WPC polygon")
    require(all(distance(a,b)<=1800 for a,b in zip(ring,ring[1:])), "Implausible WPC polygon edge")
    require(abs(sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(ring,ring[1:])))>1e-9, "Zero-area WPC polygon")
    return {"type":"Polygon","coordinates":[ring]}


def receiving_offices(text):
    """Return the WFO routing list exactly as printed, without including RFCs."""
    offices=[]
    lines=text.splitlines()
    for i,line in enumerate(lines):
        start=re.match(r"^\s*ATTN\.{3}\s*WFO\.{3}(.*)",line,re.I)
        if not start:
            continue
        material=[start[1]] + lines[i+1:]
        for chunk in material:
            chunk=re.split(r"\b(?:ATTN|LAT)\.{3}",chunk,maxsplit=1,flags=re.I)[0].strip()
            if not chunk or not re.fullmatch(r"(?:[A-Z]{3}(?:\.{2,}|[,\s]+|$)\s*)+",chunk):
                break
            offices.extend(re.findall(r"\b[A-Z]{3}\b",chunk))
        break
    return list(dict.fromkeys(offices))


US_STATES=set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP".split())


def ugc_states(header):
    """Use explicitly encoded bulletin UGC states, without inferring polygon coverage."""
    states=[]
    for line in header.splitlines():
        line=line.strip()
        if re.fullmatch(r"(?:[A-Z0-9>]+-)+",line):
            states.extend(st for st in re.findall(r"(?:^|-)([A-Z]{2})[CZ]\d{3}",line) if st in US_STATES)
    return list(dict.fromkeys(states))


def bulletin(text, now, *, issued=None, expected=None, api_url=None, fallback=None):
    # A correction can follow an older rendition in a single Web bulletin.
    headings=list(re.finditer(r"^\s*Mesoscale Precipitation Discussion\s+(\d{1,4})\b",text,re.I|re.M))
    require(headings,"WPC bulletin missing number")
    num=int(headings[-1][1])
    require(expected in (None,num),"WPC bulletin number differs from index")
    # Each WMO rendition has its own UGC header. A correction without one cannot
    # inherit the earlier routing geography.
    preceding=text[:headings[-1].start()]
    if len(headings)>1:
        preceding=preceding[headings[-2].end():]
        last_header=list(re.finditer(r"^FFGMPD\s*$",preceding,re.M))
        preceding=preceding[last_header[-1].end():] if last_header else ""
    states=ugc_states(preceding)
    text=text[headings[-1].start():]
    stamp=local_issued(text)
    issued=issued or stamp
    require(issued and issued <= now+2*MINUTE,"Unavailable or future WPC bulletin issue time")
    if stamp is not None:
        require(abs(stamp-issued)<=timedelta(hours=24),"WPC bulletin text and distribution dates disagree")
    mt=re.search(r"\bValid\s+(\d{6})Z?\s*[-–]\s*(\d{6})Z?\b",text,re.I)
    require(mt,"Missing WPC bulletin valid time")
    start=month_time(mt[1], issued)
    end=month_time(mt[2],start)
    require(timedelta(0)<end-start<=timedelta(hours=24) and abs(start-issued)<timedelta(hours=24),
            "WPC valid window is inconsistent with issuance")
    key=((stamp or issued).year,num)
    if now>=end or now<start:
        return key,issued,None
    areas=re.search(r"\bAreas affected\.{3}(.*?)(?=\s+Concerning\.{3})",text,re.I|re.S)
    tag=re.search(r"\bConcerning\.{3}(.*?)(?=\s+Valid\s+\d{6})",text,re.I|re.S)
    require(areas and tag,"Missing active WPC bulletin area or concerning line")
    clean=lambda t:" ".join(t.split()).strip(" .")
    area,concern=clean(areas[1]),clean(tag[1])
    require(area and concern and len(area)<650 and len(concern)<300,"Unexpected WPC bulletin text fields")
    if re.search(r"\b(?:this\s+(?:MPD|discussion)\s+(?:is|has been)\s+cancel(?:l)?ed|cancel(?:l)?ed\s+(?:this\s+)?MPD)\b",text,re.I):
        return key,issued,None
    offices=receiving_offices(text)
    props={"number":f"{num:04d}","year":key[0],"tag":concern,"areas":area,"issued":iso(issued),
           "valid_start":iso(start),"valid_end":iso(end),"source_url":latest_url(key[0],num),
           "geometry_source":"WPC bulletin LAT...LON",
           "wfos":offices,"states":states,
           "wfos_source":"ATTN WFO routing line" if offices else None,
           "states_source":"UGC routing codes in the original WPC bulletin" if states else None}
    if api_url:
        props["nws_product_url"]=api_url
    try:
        geometry=text_polygon(text)
    except ValueError:
        if fallback is None:
            raise
        geometry,verification_url=fallback(num,key[0],start,end,stamp or issued)
        props["geometry_source"]="WPC final, issuance-matched KML"
        props["geometry_url"]=verification_url
    return key,issued,{"type":"Feature","properties":props,"geometry":geometry}



def kmz_polygons(data, number, year, start, end, issued):
    """The rolling filename repeats yearly; require the same identity, issue and validity."""
    with ZipFile(BytesIO(data)) as package:
        entry=package.getinfo("doc.kml")
        require(entry.file_size<=3_000_000, "WPC KML file exceeds size limit")
        root=ElementTree.fromstring(package.read(entry))
    polygons=[]
    for place in root.findall(".//{*}Placemark"):
        description=place.findtext("{*}description", "")
        details=Text()
        details.feed(description)
        line=" ".join(" ".join(details.parts).split())
        id_match=re.search(r"\bMPDNumber\s+0*(\d+)\b",line,re.I)
        begin=re.search(r"\bValidStart\s+(\d{6})\b",line,re.I)
        finish=re.search(r"\bValidEndTi\w*\s+(\d{6})\b",line,re.I)
        edition=re.search(r"\bIssueTime\s+(.+?)\s+MPDNumber\b",line,re.I)
        require(id_match and int(id_match[1])==number and begin and finish and edition
                and begin[1]==start.strftime("%d%H%M") and finish[1]==end.strftime("%d%H%M")
                and local_issued(edition[1])==issued and issued.year==year,
                "WPC KML edition does not match the bulletin")
        for poly in place.findall(".//{*}Polygon"):
            rings=[]
            for exterior,children in [(True,poly.findall("{*}outerBoundaryIs")),
                                      (False,poly.findall("{*}innerBoundaryIs"))]:
                if exterior:
                    require(len(children)==1, "Missing WPC KML outer boundary")
                for child in children:
                    positions=child.findtext(".//{*}coordinates","").split()
                    coords=[[float(v) for v in xy.split(",")[:2]] for xy in positions]
                    require(len(coords)>=4 and all(len(a)==2 and abs(a[0])<=180 and abs(a[1])<=90 for a in coords)
                            and coords[0]==coords[-1] and all(distance(a,b)<=1800 for a,b in zip(coords,coords[1:])),
                            "Invalid WPC KML polygon coordinates")
                    rings.append(coords)
            polygons.append(rings)
    require(polygons,"No WPC final polygon")
    return ({"type":"Polygon","coordinates":polygons[0]} if len(polygons)==1
            else {"type":"MultiPolygon","coordinates":polygons})


def product_inventory(payload, now):
    rows=payload.get("@graph")
    require(isinstance(rows,list) and not payload.get("pagination",{}).get("next"), "Incomplete NWS product index")
    valid=[]
    for row in rows:
        require(row.get("wmoCollectiveId")=="AWUS01" and row.get("issuingOffice")=="KWNH"
                and row.get("productCode")=="FFG", "Unexpected NWS issuing office/product")
        product_id=row.get("id","")
        require(re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}",product_id),
                "Unexpected NWS product identity")
        url="https://api.weather.gov/products/"+product_id
        require(row.get("@id")==url, "NWS bulletin link disagrees")
        issued=from_iso(row["issuanceTime"])
        require(issued<=now+2*MINUTE,"NWS bulletin has a future issuance")
        valid.append((issued,url))
    valid.sort(reverse=True)
    if len(valid)>=50 and valid[-1][0]>=now-timedelta(hours=48):
        raise ValueError("NWS recent product list may be truncated")
    recent=[r for r in valid if r[0]>=now-timedelta(hours=48)]
    # A single final expired official bulletin corroborates quiet periods.
    return recent or valid[:1]


def fetch_wpc_page(fetch, suffix, maximum):
    error=None
    for host in (ORIGIN,WPC):
        try:
            contents=fetch(host+suffix,maximum)
            return contents.decode("utf-8",errors="replace")
        except Exception as exc:
            error=exc
    raise error


def collect_mpds(now, fetch):
    base={"label":"Mesoscale Precipitation Discussions","source_url":WPC+CURRENT_PATH,
          "inventory_url":NWS_PRODUCTS,"checked_at":iso(now),"fresh_until":None,
          "status":"unavailable","reason":"Official MPD inventory is unavailable.",
          "count":None,"features":[]}
    recent=[]
    ids=set()
    page_ok=False
    nws_ok=False
    explicit_none=False
    issues=[]
    with cf.ThreadPoolExecutor(max_workers=2) as pool:
        website=pool.submit(fetch_wpc_page,fetch,CURRENT_PATH,900000)
        nws=pool.submit(json_read,fetch,NWS_PRODUCTS,1800000)
        try:
            explicit_none,ids=public_index(website.result())
            page_ok=True
        except Exception as exc:
            issues.append("WPC index: "+str(exc))
        try:
            recent=product_inventory(nws.result(),now)
            nws_ok=True
        except Exception as exc:
            issues.append("NWS inventory: "+str(exc))
    if not (page_ok or nws_ok):
        return {**base,"reason":" / ".join(issues)[:240]}

    def geometry_fallback(num,year,start,end,edition):
        suffix=f"/kml/mpd/MPD_{num:04d}_final.kmz"
        error=None
        for host in (ORIGIN,WPC):
            try:
                geometry=kmz_polygons(fetch(host+suffix,1_000_000),num,year,start,end,edition)
                return geometry,host+suffix
            except Exception as exc:
                error=exc
        raise ValueError(f"No validated polygon for MPD {num:04d}") from error

    def detail_page(year,num):
        suffix=f"{DETAIL_PATH}?md={num:04d}&yr={year}"
        raw=fetch_wpc_page(fetch,suffix,800000)
        key,ts,feature=bulletin(bulletin_from_html(raw),now,expected=num,fallback=geometry_fallback)
        require(key[0]==year, "WPC linked year disagrees with bulletin")
        return key,ts,feature

    def detail_api(issued,url):
        data=json_read(fetch,url,900000)
        require(data.get("@id")==url and data.get("wmoCollectiveId")=="AWUS01"
                and data.get("issuingOffice")=="KWNH" and data.get("productCode")=="FFG"
                and from_iso(data["issuanceTime"])==issued,"NWS bulletin disagrees with the index")
        raw=data["productText"]
        require(re.search(r"^FFGMPD\s*$",raw,re.M),"Wrong NWS product identifier")
        return bulletin(raw,now,issued=issued,api_url=url,fallback=geometry_fallback)

    errors=[]
    records={}
    with cf.ThreadPoolExecutor(max_workers=5) as pool:
        work=[pool.submit(detail_api,issued,url) for issued,url in recent]
        for year,num in sorted(ids,key=lambda pair:(pair[0] or now.year,pair[1])):
            work.append(pool.submit(detail_page,year or now.year,num))
        for job in work:
            try:
                key,issued,feature=job.result()
                if key not in records or issued>records[key][0]:
                    records[key]=(issued,feature)
            except Exception as exc:
                errors.append(str(exc))
    present=[record[1] for record in records.values() if record[1] is not None]
    present.sort(key=lambda f:(f["properties"]["valid_start"],f["properties"]["number"]),reverse=True)
    # A frequently retrieved but unchanged event-driven page is a legitimate idle
    # state if its explicit no-MPD message agrees with the NWS distribution index.
    if not present and not (page_ok and nws_ok) and not (page_ok and ids and not errors):
        errors.append("The empty inventory lacks independent confirmation.")
    if errors:
        return {**base,"status":"partial" if present or page_ok or nws_ok else "unavailable",
                "reason":" / ".join(errors)[:260],"features":present,
                "fresh_until":iso(now+10*MINUTE),"source_notes":issues}
    until=min([now+10*MINUTE]+[from_iso(f["properties"]["valid_end"]) for f in present])
    return {**base,"status":"current","reason":("Active WPC bulletins within their valid periods."
               if present else "No active WPC Mesoscale Precipitation Discussions verified."),
            "features":present,"count":len(present),"fresh_until":iso(until),
            "explicit_no_mpd":explicit_none,"source_notes":issues,
            "latest_official_distribution":iso(recent[0][0]) if recent else None}


def collect(now=None, *, fetch=read_public, radar_images=None):
    """Return renderable, independently checked radar and MPD modules."""
    now=check_now(now)
    with cf.ThreadPoolExecutor(max_workers=2) as pool:
        radar=pool.submit(collect_radar,now,fetch,radar_images)
        mpd=pool.submit(collect_mpds,now,fetch)
        return {"radar":radar.result(),"mpd":mpd.result()}


if __name__ == "__main__":
    print(json.dumps(collect(),separators=(",",":")))
