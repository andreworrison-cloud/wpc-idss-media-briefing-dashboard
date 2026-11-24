import unittest

from scripts.publish import SOURCES
from scripts.verify_pages import validate_release


class PublicReleaseTests(unittest.TestCase):
    def setUp(self):
        self.revision = '2026-11-24T22:24:07.510Z'
        self.board = {'schema': 1, 'revision': self.revision, 'sources': dict.fromkeys(SOURCES),
                      'impacts':dict.fromkeys(('aviation','power','ground','exposure')), 'health': {source: {'status':'ok'} for source in SOURCES}}
        self.home = b'<html>Briefing board</html>'

    def test_exact_published_snapshot_preserves_partial_source_status(self):
        self.board['health']['alerts']['status'] = 'partial'
        validate_release(self.home, self.board, self.home, self.revision)

    def test_default_home_and_cached_snapshot_fail_the_public_check(self):
        with self.assertRaisesRegex(ValueError, 'homepage'):
            validate_release(b'<html>Repository README</html>', self.board, self.home, self.revision)
        with self.assertRaisesRegex(ValueError, 'Expected revision'):
            validate_release(self.home, self.board, self.home, '2026-11-24T22:34:16.000Z')
        del self.board['health']['reports']
        with self.assertRaisesRegex(ValueError, 'source inventory'):
            validate_release(self.home, self.board, self.home, self.revision)
