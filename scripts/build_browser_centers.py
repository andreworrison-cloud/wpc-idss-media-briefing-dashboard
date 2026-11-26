"""Encode the committed Census/forecast-zone reference for offline browser workers."""
import base64
import gzip
import hashlib
import json
import lzma
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'scripts/exposure_data'
TARGET = ROOT / 'assets/recovery-centers.bin.gz'
RECORD = struct.Struct('<QiiI')
BROWSER_RECORD = struct.Struct('<iiIBH')
STATE_CODES = dict(zip(map(int, '01 02 04 05 06 08 09 10 11 12 13 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 44 45 46 47 48 49 50 51 53 54 55 56 72'.split()),
                       'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split()))


def read(spec):
    raw = lzma.decompress(base64.b64decode((SOURCE / spec['name']).read_bytes()))
    if hashlib.sha256(raw).hexdigest() != spec['sha256']:
        raise ValueError('Invalid reference checksum')
    return raw


def build(target=TARGET):
    manifest = json.loads((SOURCE / 'manifest.json').read_bytes())
    membership = json.loads(read(manifest['zones']))
    count = manifest['populated_centers']
    codes = sorted(membership)
    zone_ids = [[] for _ in range(count)]
    for number, code in enumerate(codes):
        for i in membership[code]:
            zone_ids[i].append(number)
    signatures = {(): 0}
    totals = dict.fromkeys(STATE_CODES.values(), 0)
    data = bytearray()
    for index, (geoid, lon, lat, residents) in enumerate(RECORD.iter_unpack(b''.join(read(x) for x in manifest['parts']))):
        state = geoid // 10**10
        totals[STATE_CODES[state]] += residents
        zones = tuple(zone_ids[index])
        group = signatures.setdefault(zones, len(signatures))
        data.extend(BROWSER_RECORD.pack(lon, lat, residents, state, group))
    if len(data) != count * BROWSER_RECORD.size or totals != {k: v['population'] for k, v in manifest['jurisdictions'].items()}:
        raise ValueError('Reference coverage differs from Census jurisdiction totals')
    header = json.dumps({'version': 1, 'count': count, 'residents': sum(totals.values()), 'states': STATE_CODES,
                         'effective': manifest['zones']['effective'], 'codes': codes, 'members': list(signatures)},
                        separators=(',', ':')).encode()
    target.write_bytes(gzip.compress(b'IDSC' + struct.pack('<I', len(header)) + header + data, mtime=0))


if __name__ == '__main__':
    build()
