import copy
from datetime import timedelta
from html.parser import HTMLParser
from pathlib import Path
import re
import unittest
from urllib.parse import urljoin, urlsplit

from scripts.publish import ASSETS, GENERATED_CENTER_INDEX, SOURCES, qualify, stamp

ROOT = Path(__file__).resolve().parents[1]
WHEN = '2026-11-24T21:51:51.965Z'


def snapshot():
    status = {'mode': 'collector', 'storage': 'available', 'revision': WHEN}
    board = {**status, 'schema': 1, 'captured_at': WHEN, 'comparison': None,
             'sources': {s: {} for s in SOURCES}, 'attempts': {s: {} for s in SOURCES},
             'health': {s: {'status': 'ok', 'retrieved_at': WHEN} for s in SOURCES}}
    board['sources']['reports']['events'] = [{'title': 'Flood', 'source_url': 'https://mesonet.agron.iastate.edu/lsr/'}]
    return status, board, {'edition': None}


class PagesTests(unittest.TestCase):
    def test_current_snapshot_and_explicit_partial_coverage_are_retained(self):
        status, board, handoff = snapshot()
        board['health']['winter']['status'] = 'partial'
        out, shift = qualify(status, board, handoff, stamp(WHEN))
        self.assertEqual(out['health']['winter']['status'], 'partial')
        self.assertEqual(out['revision'], WHEN)
        self.assertIsNone(shift['edition'])

    def test_stale_bootstrap_and_regressing_revisions_do_not_publish(self):
        status, board, handoff = snapshot()
        now = stamp(WHEN)
        with self.assertRaises(ValueError):
            qualify(status, board, handoff, now + timedelta(minutes=21))
        with self.assertRaises(ValueError):
            qualify(status, {**board, 'mode':'reviewed_snapshot'}, handoff, now)
        with self.assertRaises(ValueError):
            qualify({**status, 'revision':'2026-11-24T22:10:00Z'}, board, handoff, now)

    def test_unknown_source_and_private_report_fields_are_rejected(self):
        status, board, handoff = snapshot()
        changed = copy.deepcopy(board)
        changed['sources']['extra'] = {}
        with self.assertRaises(ValueError):
            qualify(status, changed, handoff, stamp(WHEN))
        board['sources']['reports']['events'][0]['remark'] = 'Unreviewed text'
        with self.assertRaises(ValueError):
            qualify(status, board, handoff, stamp(WHEN))

    def test_nested_private_fields_unapproved_links_and_future_editions_are_rejected(self):
        status, board, handoff = snapshot()
        for item in ({'email':'private@example.invalid'}, {'url':'https://weather.gov.example.invalid/'}, {'url':'https://docs.google.com/spreadsheets/d/example'}):
            with self.subTest(item=item):
                board['sources']['messages']['items'] = [item]
                with self.assertRaises(ValueError):
                    qualify(status, board, handoff, stamp(WHEN))
        del board['sources']['messages']['items']
        handoff['edition'] = {'slot':'2026-11-25T00Z', 'captured_at':'2026-11-25T00:01:00Z'}
        with self.assertRaises(ValueError):
            qualify(status, board, handoff, stamp(WHEN))

    def test_past_shift_edition_keeps_its_own_public_sources(self):
        status, board, handoff = snapshot()
        brief = {'title':'National shift briefing', 'area':'National', 'scope':'All hazards', 'window':12,
                 'asof':'1205Z', 'snapshot':'1205Z', 'sections':[{'title':'Rainfall', 'lines':['See official outlook.']}],
                 'evidence':[{'label':'WPC', 'url':'https://www.wpc.ncep.noaa.gov/'}]}
        handoff['edition'] = {'slot':'2026-11-24T12Z', 'captured_at':'2026-11-24T12:05:00Z', 'brief':brief}
        _, out = qualify(status, board, handoff, stamp(WHEN))
        self.assertEqual(out['edition']['brief']['evidence'], brief['evidence'])
        brief['extra'] = 'unexpected'
        with self.assertRaises(ValueError):
            qualify(status, board, handoff, stamp(WHEN))

    def test_css_navigation_and_modules_resolve_below_project_path(self):
        class References(HTMLParser):
            def __init__(self):
                super().__init__(); self.links = []
            def handle_starttag(self, tag, attrs):
                for key, value in attrs:
                    if key in ('src', 'href') and value and not value.startswith(('#','https:')):
                        self.links.append(value)
        parser = References(); parser.feed((ROOT/'index.html').read_text())
        self.assertGreaterEqual(len(parser.links), 4)
        refs = [('index.html', url) for url in parser.links]
        for stylesheet in (ROOT/'assets').rglob('*.css'):
            for raw in re.findall(r'url\(([^)]+)\)', stylesheet.read_text()):
                target = raw.strip(chr(39) + chr(34))
                if not target.startswith(('data:', '#', 'https:')):
                    refs.append((str(stylesheet.relative_to(ROOT)),target))
        for js in (ROOT/'assets').glob('*.js'):
            refs += [('assets/'+js.name, url) for url in re.findall(r"from ['\"]([^'\"]+)['\"]", js.read_text())]
        root = 'https://example.github.io/one-project/'
        for filename, url in refs:
            resolved = urljoin(root + filename, url)
            self.assertTrue(resolved.startswith(root), resolved)
            self.assertTrue((ROOT/urlsplit(resolved).path.removeprefix('/one-project/')).is_file(), f'{filename} → {url} → {resolved}')
        self.assertEqual(set(ASSETS), {str(p.relative_to(ROOT/'assets')) for p in (ROOT/'assets').rglob('*') if p.is_file() and p.name != GENERATED_CENTER_INDEX})

    def test_dedicated_workflow_has_no_cross_repository_trigger(self):
        workflow = (ROOT/'.github/workflows/publish.yml').read_text()
        self.assertNotIn('workflow_run:', workflow)
        self.assertNotIn('wpc-hydro-dashboard', workflow)
        self.assertIn('workflow_dispatch:', workflow)
        self.assertIn('7,17,27,37,47,57 * * * *', workflow)
        js = (ROOT/'assets/briefing.js').read_text()
        self.assertRegex(js, r"readRelease\(\s*'board'\s*[,)]")
        self.assertIn("readRelease('handoff')", js)
        self.assertNotIn("fetch('/api/", js)


if __name__ == '__main__':
    unittest.main()
