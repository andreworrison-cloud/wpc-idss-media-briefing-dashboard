"""Build a static Pages release from the dedicated IDSS collector's public products."""
import json
import re
import shutil
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
COLLECTOR = 'https://wpc-impact-briefing.aorrison.chatgpt.site'
SOURCES = {'alerts', 'reports', 'ero', 'winter', 'outlook', 'messages'}
REPORT_FIELDS = set('id observation_id title family state states wfo city county valid issued lat lon magnitude unit qualifier trace impact_flags height_ft_agl height_estimated accumulation_hours preliminary revision revision_match source_url'.split())
RAW_KEYS = {'remarks', 'reporter', 'reporter_name', 'reported_by', 'email', 'spreadsheetid', 'private_key', 'access_token', 'raw_rows', 'raw_text'}
IMPACT_HOSTS = ('noaa.gov', 'weather.gov', 'iastate.edu', 'poweroutmap.com', 'poweroutage.us', 'ornl.gov', 'census.gov', 'faa.gov', 'flightaware.com', 'dot.gov', 'bts.gov')
WEATHER_HOSTS = ('noaa.gov', 'weather.gov', 'iastate.edu')
ASSETS = (
    'alert-zones.js', 'barlow.woff2', 'barlowcondensed-license.txt', 'briefing.css', 'briefing.js',
    'command-map.css', 'command-map.js', 'conus-reference.webp', 'county-reference.js', 'dm-sans.woff2',
    'dmsans-license.txt', 'geo-reference.json', 'geographic-base.js', 'hazard-palette.js', 'impact-logic.js',
    'impacts.js', 'leaflet/LICENSE', 'leaflet/images/layers-2x.png', 'leaflet/images/layers.png',
    'leaflet/images/marker-icon-2x.png', 'leaflet/images/marker-icon.png',
    'leaflet/images/marker-shadow.png', 'leaflet/leaflet.css', 'leaflet/leaflet.js',
    'leaflet/leaflet.js.map', 'logic.js', 'map-points.js', 'mark.svg', 'observed-graphics.js', 'offices.js',
    'outage-geo-central.json', 'outage-geo-islands.json', 'outage-geo-northeast.json',
    'outage-geo-south.json', 'outage-geo-southeast.json', 'outage-geo-states.json', 'outage-geo-west.json',
    'outage-layer.css', 'outage-layer.js', 'release.js',
)


class FixedOrigin(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('The fixed IDSS collector returned a redirect')


def read_public(route):
    request = Request(f'{COLLECTOR}/api/{route}?check={time.time_ns()}', headers={
        'Accept': 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'WPC-IDSS-Pages/1.0',
    })
    with build_opener(FixedOrigin()).open(request, timeout=50) as response:
        if response.headers.get_content_type() != 'application/json':
            raise ValueError(f'Unexpected {route} response type')
        return json.load(response)


def stamp(value):
    if not isinstance(value, str) or not value.endswith('Z'):
        raise ValueError('Expected a UTC collection timestamp')
    return datetime.fromisoformat(value[:-1] + '+00:00')


def review_fields(obj, domains=('noaa.gov', 'weather.gov', 'iastate.edu'), hydro=False):
    if isinstance(obj, list):
        for member in obj:
            review_fields(member, domains, hydro)
    elif isinstance(obj, dict):
        for key, value in obj.items():
            if key.lower() in RAW_KEYS:
                raise ValueError('Unexpected raw or private field')
            review_fields(value, domains, hydro)
    elif isinstance(obj, str):
        if 'docs.google.com/spreadsheets' in obj.lower() or 'BEGIN PRIVATE KEY' in obj:
            raise ValueError('Unexpected private source')
        if obj.startswith(('https://', 'http://')):
            target = urlsplit(obj)
            host = target.hostname or ''
            allowed = any(host == end or host.endswith('.' + end) for end in domains)
            if hydro and host in {'andreworrison-cloud.github.io','raw.githubusercontent.com','github.com','api.github.com'}:
                prefix = {'andreworrison-cloud.github.io': '/wpc-hydro-dashboard/', 'api.github.com': '/repos/andreworrison-cloud/wpc-hydro-dashboard/'}.get(host, '/andreworrison-cloud/wpc-hydro-dashboard/')
                allowed = target.path.startswith(prefix) and not set(target.path.split('/')).intersection({'..','.'})
            if hydro and host in {'noaa-mrms-pds.s3.amazonaws.com', 'noaa-mrms-pds.s3.us-east-1.amazonaws.com', 's3.amazonaws.com'}:
                prefix = '/noaa-mrms-pds/' if host == 's3.amazonaws.com' else '/'
                allowed = target.path.startswith(prefix + 'CONUS/ReflectivityAtLowestAltitude_00.50/') and target.path.endswith('.grib2.gz')
            if domains == IMPACT_HOSTS and host == 'services.arcgis.com':
                allowed = target.path == '/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_Aviation_Facilities/FeatureServer/0'
            if target.scheme != 'https' or not allowed or target.username or target.password:
                raise ValueError(f'Unexpected public evidence domain {host}')


def qualify(status, board, handoff, now):
    for obj in (status, board):
        if obj.get('mode') != 'collector' or obj.get('storage') != 'available':
            raise ValueError('A stored live collection is required')
    revision = stamp(board['revision'])
    if revision != stamp(board['captured_at']) or revision < stamp(status['revision']):
        raise ValueError('The rendered collection predates the verified status')
    if not -120 <= (now - revision).total_seconds() <= 1200:
        raise ValueError('The collector revision falls outside the publication window')
    if board.get('schema') != 1 or any(set(board.get(key, {})) != SOURCES for key in ('sources', 'health', 'attempts')):
        raise ValueError('Unexpected briefing schema or sources')
    for report in board['sources']['reports'].get('events', []):
        if set(report) - REPORT_FIELDS:
            raise ValueError('Unreviewed storm report fields')
    if not isinstance(handoff, dict) or set(handoff) != {'edition'}:
        raise ValueError('Unexpected handoff envelope')
    edition = handoff['edition']
    if edition is not None:
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T(?:00|12)Z', edition['slot']):
            raise ValueError('Unexpected handoff edition')
        if stamp(edition['captured_at']) > revision:
            raise ValueError('The handoff is newer than the rendered board')
        if set(edition) != {'slot', 'captured_at', 'brief'}:
            raise ValueError('Unreviewed handoff fields')
        brief = edition['brief']
        brief_fields = {'title', 'area', 'scope', 'window', 'asof', 'snapshot', 'sections', 'evidence'}
        if set(brief) != brief_fields:
            raise ValueError('Unexpected briefing fields')
        for section in brief['sections']:
            if set(section) != {'title', 'lines'} or not all(isinstance(line, str) for line in section['lines']):
                raise ValueError('Unexpected briefing section')
        for source in brief['evidence']:
            if set(source) != {'label', 'url'}:
                raise ValueError('Unexpected briefing evidence')
    public_board = {key: board[key] for key in ('schema', 'revision', 'captured_at', 'sources', 'health', 'attempts', 'comparison', 'storage', 'mode')}
    public_handoff = {'edition': edition}
    review_fields(public_board)
    review_fields(public_handoff)
    return public_board, public_handoff


def snapshots():
    for attempt in range(3):
        try:
            # Status waits for due inputs. Read the board and handoff after that collection.
            status = read_public('status')
            board = read_public('board')
            handoff = read_public('handoff')
            return qualify(status, board, handoff, datetime.now(timezone.utc))
        except (URLError, OSError, ValueError, KeyError, TypeError) as exc:
            if attempt == 2:
                raise
            print(f'Collection retry {attempt + 1}. {type(exc).__name__}', flush=True)
            time.sleep(5 * (attempt + 1))


def publish():
    from impact_pipeline import collect_impacts
    from weather_layers import collect_weather
    from weather_exposure import add_weather_exposure
    board, handoff = snapshots()
    now = datetime.now(timezone.utc)
    with ThreadPoolExecutor(max_workers=2) as pool:
        impacts = pool.submit(collect_impacts, board, lambda data: review_fields(data, IMPACT_HOSTS), now)
        layers = pool.submit(collect_weather, board, lambda data: review_fields(data, WEATHER_HOSTS, hydro=True), now)
        board['impacts'] = impacts.result()
        board['weather'] = layers.result()
    add_weather_exposure(board, datetime.now(timezone.utc))
    # Publish only the explicitly listed viewer files and approved snapshot documents.
    # Actions uploads the completed directory only after this script exits successfully.
    with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
        output = Path(tmp) / 'public'
        (output / 'assets').mkdir(parents=True)
        (output / 'data').mkdir()
        shutil.copyfile(ROOT / 'index.html', output / 'index.html')
        for name in ASSETS:
            dest = output / 'assets' / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / 'assets' / name, dest)
        for name, document in [('board', board), ('handoff', handoff)]:
            (output / 'data' / f'{name}.json').write_text(json.dumps(document, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')
        destination = ROOT / '_site'
        if destination.exists():
            shutil.rmtree(destination)
        output.rename(destination)
    print('Impact data: ' + ', '.join(f"{key} {value['status']}" for key, value in board['impacts'].items()), flush=True)
    print('Geographic layers: ' + ', '.join(f"{key} {value['status']}" for key, value in board['weather'].items()), flush=True)
    print(f"IDSS revision {board['revision']} confirmed. " + ', '.join(f"{key} {board['health'][key]['status']}" for key in sorted(SOURCES)))


if __name__ == '__main__':
    publish()
