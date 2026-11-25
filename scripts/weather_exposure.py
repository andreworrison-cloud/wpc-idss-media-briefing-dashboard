"""Count residents within an active WPC discussion or matched NWS winter issuance."""
from collections import defaultdict
from datetime import timedelta
import hashlib
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen

import exposure as exp
from exposure_reference import DEFAULT_DIR, FIPS_BY_CODE, unpack

WSSI_LEVELS = {1:'Winter Weather Area', 2:'Minor', 3:'Moderate', 4:'Major', 5:'Extreme'}


def live(start, end, now):
    a, b = exp._dt(start), exp._dt(end)
    return a is not None and b is not None and a <= now < b


def public_zones(events, centers, manifest, exposure, now):
    wanted = {code for row in events if not row.get('geometry') for code in row.get('ugc', [])}
    if not wanted:
        return {}
    saved = manifest.get('zones') or {}
    verified = exposure.get('coverage', {}).get('forecast_zones', {})
    if verified.get('status') == 'verified' and verified.get('effective') == saved.get('effective'):
        return json.loads(unpack(DEFAULT_DIR, saved))
    edition = exp.catalog_edition(exp._get_catalog(), now)
    if not edition:
        return {}
    if all(edition[k] == saved.get(k) for k in ('effective', 'filename', 'md5')):
        return json.loads(unpack(DEFAULT_DIR, saved))
    return exp._current_zone_ids(centers, edition, wanted, os.environ.get('IDSS_ZONE_CACHE_DIR'))


def discussions(centers, layer, now):
    since = layer.get('checked_at')
    fresh = layer.get('fresh_until')
    if layer.get('status') not in {'current', 'ok', 'partial'} or not live(since, fresh, now):
        return []
    rows = []
    for feature in layer.get('features', []):
        p = feature.get('properties') or {}
        if not live(p.get('valid_start'), p.get('valid_end'), now):
            continue
        area = exp.Coverage()
        area.polygon(centers, feature.get('geometry'))
        n = str(p.get('number') or '').zfill(4)
        meta = {
            'id': 'mpd-' + n, 'label': 'WPC MPD ' + n, 'family': 'Flood',
            'map_product': 'mpd', 'basis': 'WPC mesoscale precipitation discussion polygon',
            'valid_start': p['valid_start'], 'valid_end': p['valid_end'],
            'fresh_until': exp._ends(fresh, p['valid_end']), 'as_of': since,
            'source_url': p.get('source_url') or layer.get('source_url'),
        }
        rows.append(exp._record(centers, meta, area, 'current',
                   'Residents within this WPC discussion area. Flash flooding may affect only part of the polygon.'))
    return rows


def winter_issuances(centers, events, zones, checked, now):
    until = exp._iso(exp._dt(checked) + timedelta(minutes=30)) if exp._dt(checked) else None
    if not live(checked, until, now):
        return []
    hazards = defaultdict(list)
    seen = set()
    for e in events:
        title = e.get('event') or e.get('title')
        start = e.get('effective') or e.get('valid_start')
        end = exp._ends(e.get('valid_end'), e.get('expires'), e.get('ends'))
        if not title or not e.get('id') or e['id'] in seen or not live(start, end, now):
            continue
        seen.add(e['id'])
        area = exp.Coverage()
        if e.get('geometry'):
            area.polygon(centers, e['geometry'])
        elif 'snow squall' in title.casefold():
            area.missing += 1
        else:
            exp._zone_coverage(area, e, zones)
        if set(e.get('states') or []).difference(FIPS_BY_CODE):
            area.missing += 1
        hazards[title].append((e, area, end))
    rows = []
    for title, members in sorted(hazards.items()):
        coverage = exp.Coverage()
        for _, area, _ in members:
            coverage.include(area)
        end = exp._ends(*(end for _, _, end in members))
        rows.append(exp._record(centers, {
            'id': 'winter-zone-' + exp._slug(title), 'label': title, 'family': 'Winter',
            'basis': 'NWS issuance polygons or full public forecast zones', 'as_of': checked,
            'map_product': 'winter_alerts', 'valid_start': checked, 'valid_end': end,
            'fresh_until': exp._ends(until, end), 'source_url': 'https://www.weather.gov/',
            'alert_ids': [e['id'] for e, _, _ in members],
        }, coverage, 'current',
        'Residents are counted once across overlapping areas of this alert type. A zone-based issuance can include communities outside the expected impacts.'))
    return rows


def full_wssi(centers, layer, checked, now, fetch=None):
    """Only use full native geometries for the same validated issuance as the display."""
    expected = {f['properties']['objectid']: f['properties']['impact'] for f in layer['features']}
    if not expected or set(layer.get('expected_objectids') or []) != set(expected):
        raise ValueError('Incomplete WSSI feature inventory')
    until = exp._ends(layer['valid_end'], exp._iso(exp._dt(layer['issued']) + timedelta(hours=6)))
    if not live(layer['issued'], until, now):
        return None
    url = layer['native_query_url']
    if not url.startswith(exp.WSSI_LAYER + '/query?'):
        raise ValueError('Unexpected WSSI geometry service')
    fingerprint = hashlib.sha256(json.dumps(layer, ensure_ascii=True, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    folder = os.environ.get('IDSS_WSSI_CACHE_DIR')
    path = Path(folder, 'all-bands-population.json') if folder else None
    if path and path.is_file():
        try:
            cache = json.loads(path.read_text())
            if cache['key'] == fingerprint and cache['record']['status'] == 'current':
                return dict(cache['record'], as_of=checked)
        except (OSError, ValueError, KeyError):
            pass
    if fetch:
        native = fetch(url)
    else:
        with urlopen(Request(url, headers={'User-Agent':'WPC-IDSS-Dashboard/1.0'}), timeout=25) as response:
            raw = response.read(64_000_001)
        if len(raw) > 64_000_000:
            raise ValueError('Native WSSI file exceeds the download limit')
        native = json.loads(raw)
    verified = exp._validate_wssi_native(layer, native, expected.copy())
    c = exp._features(centers, verified, WSSI_LEVELS, 'impact')
    record = exp._record(centers, {
        'id':'wssi-all-d1-3', 'label':'WSSI Days 1–3 · All mapped categories', 'family':'Winter',
        'map_product':'wssi_d1_3', 'issued':layer['issued'], 'as_of':checked, 'fresh_until':until,
        'valid_start':layer['valid_start'], 'valid_end':layer['valid_end'],
        'basis':'WPC native WSSI overall polygons', 'source_url':layer['source_url'],
    }, c, 'current',
        'CONUS residents assigned to their highest mapped WSSI category for Days 1–3. The Winter Weather Area includes potential limited impacts.',
        WSSI_LEVELS)
    if path and record['status'] == 'current':
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({'key': fingerprint, 'record': record}, separators=(',', ':')))
        except OSError:
            pass
    return record


def add_weather_exposure(board, now):
    exposure = board['impacts']['exposure']
    groups = exposure.get('groups')
    if not isinstance(groups, dict):
        return
    weather = board['weather']
    for r in groups.get('winter', []):
        if r.get('id') == 'wssi-d1-3':
            r['label'] = 'WSSI Days 1–3 · Moderate or greater'
    if not exposure.get('coverage', {}).get('populated_block_groups'):
        return
    centers, manifest = exp._load(DEFAULT_DIR)
    winter = weather.get('winter') or {}
    layers = {item['id']:item for item in winter.get('layers', [])}
    wssi = layers.get('wssi_d1_3') or {}
    if wssi.get('status') == 'ok':
        try:
            record = full_wssi(centers, wssi, winter['retrieved_at'], now)
            if record and record['status'] == 'current':
                groups['winter'] = [record]
        except (OSError, ValueError, TypeError, KeyError) as exc:
            print(f'Full WSSI exposure unavailable ({type(exc).__name__}).', flush=True)
    md = weather.get('mpd') or {}
    groups['mpd'] = discussions(centers, md, now)
    al = layers.get('winter_alerts') or {}
    events = al.get('events') or []
    if al.get('status') in {'current', 'ok', 'partial'} and events:
        try:
            zones = public_zones(events, centers, manifest, exposure, now)
        except (OSError, ValueError, TypeError, KeyError):
            zones = {}
        checked = al.get('retrieved_at') or weather['winter'].get('retrieved_at')
        groups['winter_alerts'] = winter_issuances(centers, events, zones, checked, now)
        complete = {r['label'] for r in groups['winter_alerts'] if r['status'] == 'current'}
        groups['alerts'] = [r for r in groups.get('alerts', []) if r.get('label') not in complete]
