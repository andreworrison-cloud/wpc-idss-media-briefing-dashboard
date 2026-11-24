"""Confirm that GitHub Pages is serving the briefing release this job built."""
import json
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from scripts.publish import SOURCES


def validate_release(html, board, expected_html, revision):
    if html != expected_html:
        raise ValueError('The public homepage differs from the briefing viewer')
    if board.get('schema') != 1 or board.get('revision') != revision:
        raise ValueError(f"Expected revision {revision}; served {board.get('revision')}")
    if set(board.get('sources', {})) != SOURCES or set(board.get('health', {})) != SOURCES:
        raise ValueError('The public release has an unexpected source inventory')
    if set(board.get('impacts', {})) != {'aviation','power','ground','exposure'}:
        raise ValueError('The public release is missing its impact data')


def read(url):
    req = Request(url, headers={'User-Agent':'WPC-IDSS-Pages-Verification/1.0', 'Cache-Control':'no-cache'})
    with urlopen(req, timeout=12) as response:
        return response.read()


def verify(page_url, revision):
    root = page_url.rstrip('/') + '/'
    expected_html = (Path(__file__).resolve().parents[1] / 'index.html').read_bytes()
    for attempt in range(8):
        query = '?' + urlencode({'revision': revision, 'probe': time.time_ns()})
        try:
            html = read(root + query)
            board = json.loads(read(root + 'data/board.json' + query))
            validate_release(html, board, expected_html, revision)
            states = ', '.join(f"{name} {board['health'][name]['status']}" for name in sorted(SOURCES))
            print(f'Verified public IDSS revision {revision}. {states}', flush=True)
            return
        except (HTTPError, URLError, OSError, ValueError, KeyError, TypeError) as exc:
            if attempt == 7:
                raise
            print(f'Waiting for the Pages release. {exc}', flush=True)
            time.sleep(10)


if __name__ == '__main__':
    verify(sys.argv[1], sys.argv[2])
