"""Read the frozen Census reference and intersect public hazard polygons with resident centers."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import lzma
from pathlib import Path
import zipfile

import numpy as np
import shapely
from shapely.geometry import Polygon

CENSUS = 'https://www.census.gov/geographies/reference-files/2020/geo/2020-centers-population.html'
ZONE_CATALOG = 'https://www.weather.gov/gis/PublicZones'
DEFAULT_DIR = Path(__file__).with_name('exposure_data')
STATE_FIPS = dict(zip('01 02 04 05 06 08 09 10 11 12 13 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 44 45 46 47 48 49 50 51 53 54 55 56 72'.split(), 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split()))
FIPS_BY_CODE = {v: int(k) for k, v in STATE_FIPS.items()}
# Retain the published six-decimal coordinates and full 12-digit block group ID.
DTYPE = np.dtype([('geoid','<u8'),('lon','<i4'),('lat','<i4'),('pop','<u4')])


def pack(raw):
    archive = base64.b64encode(lzma.compress(raw, preset=6)).decode('ascii')
    return '\n'.join(archive[i:i+120] for i in range(0,len(archive),120)) + '\n'


def unpack(folder, spec):
    encoded = (Path(folder) / spec['name']).read_bytes()
    data = lzma.decompress(base64.b64decode(b''.join(encoded.split()), validate=True))
    if hashlib.sha256(data).hexdigest() != spec['sha256']:
        raise ValueError('Reference checksum mismatch')
    return data


class Centers:
    def __init__(self, records):
        self.geoid = records['geoid']
        self.lon = records['lon'].astype('float64') / 1e6
        self.lat = records['lat'].astype('float64') / 1e6
        self.population = records['pop'].astype('int64')
        self.state = (self.geoid // 10**10).astype('int16')

    def state_rows(self, ids):
        if len(ids) == 0:
            return []
        # Integer bincounts avoid floating point in resident totals.
        states = self.state[ids]
        rows = [{'code': STATE_FIPS[f'{s:02d}'], 'population': int(self.population[ids[states == s]].sum())}
                for s in np.unique(states)]
        return sorted(rows, key=lambda r: (-r['population'], r['code']))

    def intersect(self, geometry, state_ids=None):
        """Indices of unique centers inside or on polygon edges, including a hole's edge."""
        result = set()
        eligible = np.arange(len(self.lat)) if state_ids is None else state_ids
        base_x = self.lon if state_ids is None else self.lon[eligible]
        y = self.lat if state_ids is None else self.lat[eligible]
        valid = invalid = repaired = 0
        for rings in _polygon_coordinates(geometry):
            try:
                if not rings or any(len(ring) < 4 for ring in rings):
                    raise ValueError('Empty or short ring')
                coordinates = [np.asarray(r, dtype='float64')[:, :2] for r in rings]
                for ring in coordinates:
                    if ring.shape[1] != 2 or not np.isfinite(ring).all() or not np.array_equal(ring[0], ring[-1]):
                        raise ValueError('Areal coordinates need closed, finite rings')
                    if np.abs(ring[:,0]).max() > 180.000001 or np.abs(ring[:,1]).max() > 90.000001:
                        raise ValueError('Coordinates outside geographic range')
                crosses = any(np.abs(np.diff(r[:,0])).max() > 180 for r in coordinates)
                if crosses:
                    coordinates = [np.column_stack((np.mod(r[:,0], 360), r[:,1])) for r in coordinates]
                polygon = Polygon(coordinates[0], coordinates[1:])
                if not polygon.is_valid:
                    # Intersection must remain areal after GEOS topology repair.
                    pieces = list(_area_parts(shapely.make_valid(polygon)))
                    if not pieces:
                        raise ValueError('No polygon after topology repair')
                    polygon = shapely.union_all(pieces)
                    repaired += 1
                if polygon.is_empty or polygon.area <= 0:
                    raise ValueError('Empty footprint')
                west, south, east, north = polygon.bounds
                x = np.mod(base_x, 360) if crosses else base_x
                candidates = (x >= west) & (x <= east) & (y >= south) & (y <= north)
                if candidates.any():
                    hits = shapely.intersects_xy(polygon, x[candidates], y[candidates])
                    result.update(eligible[candidates][hits].tolist())
                valid += 1
            except (ValueError, TypeError, IndexError, OverflowError, shapely.errors.GEOSException):
                invalid += 1
        if not valid and not invalid:
            invalid = 1
        return result, valid, invalid, repaired


def _area_parts(geometry):
    if geometry.geom_type == 'Polygon' and not geometry.is_empty:
        yield geometry
    elif geometry.geom_type in ('GeometryCollection','MultiPolygon'):
        for part in geometry.geoms:
            yield from _area_parts(part)


def _polygon_coordinates(g):
    if not isinstance(g,dict):
        yield None
    elif g.get('type') == 'Polygon':
        yield g.get('coordinates')
    elif g.get('type') == 'MultiPolygon' and isinstance(g.get('coordinates'),(list,tuple)):
        yield from g['coordinates'] or [None]
    elif g.get('type') == 'GeometryCollection' and isinstance(g.get('geometries'),(list,tuple)):
        for part in g['geometries'] or [None]:
            yield from _polygon_coordinates(part)
    else:
        yield None


def load_reference(folder=DEFAULT_DIR):
    folder = Path(folder)
    manifest = json.loads((folder/'manifest.json').read_text())
    records = np.concatenate([np.frombuffer(unpack(folder, part), dtype=DTYPE) for part in manifest['parts']])
    if len(records) != manifest['populated_centers'] or np.any(records['geoid'][1:] <= records['geoid'][:-1]):
        raise ValueError('Census center count/order mismatch')
    centers = Centers(records)
    expected = {key:int(value['population']) for key,value in manifest['jurisdictions'].items()}
    actual = {row['code']:row['population'] for row in centers.state_rows(np.arange(len(records)))}
    if actual != expected or set(actual) != set(FIPS_BY_CODE) or sum(actual.values()) != 334735155:
        raise ValueError('Census population benchmark mismatch')
    return centers, manifest


def read_zone_memberships(centers, archive, filename, wanted=None):
    """Build Census center membership from verified NWS public-zone shapefile bytes."""
    import shapefile

    stem = filename.removesuffix('.zip')
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        parts = {ext:bundle.getinfo(f'{stem}.{ext}') for ext in ('shp','dbf','shx')}
        if sum(item.file_size for item in parts.values())>450_000_000:
            raise ValueError('Oversized NWS zone reference')
        streams = {k:io.BytesIO(bundle.read(v)) for k,v in parts.items()}
    by_state = {k:np.flatnonzero(centers.state==v) for k,v in FIPS_BY_CODE.items()}
    zone_ids = {}
    repairs = 0
    with shapefile.Reader(**streams,encoding='latin-1') as reader:
        count = len(reader)
        for record in reader.iterRecords():
            props = record.as_dict()
            state,zone = props['STATE'],props['ZONE']
            if state not in by_state:
                continue
            if props['STATE_ZONE']!=state+zone or len(zone)!=3 or not zone.isdecimal():
                raise ValueError('Unexpected NWS forecast zone identity')
            code=state+'Z'+zone
            if wanted is not None and code not in wanted:
                continue
            ids,valid,invalid,repaired = centers.intersect(reader.shape(record.oid).__geo_interface__, by_state[state])
            if invalid or not valid:
                raise ValueError(f'Invalid geometry for {code}')
            zone_ids.setdefault(code,set()).update(ids)
            repairs+=repaired
    return zone_ids, count, repairs
