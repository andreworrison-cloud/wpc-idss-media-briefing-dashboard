import tempfile
import json
import os
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

import exposure as e
from exposure_reference import Centers, DEFAULT_DIR, DTYPE, load_reference, unpack

NOW = datetime(2026, 11, 24, 22, 24, tzinfo=timezone.utc)
STAMP = e._iso(NOW)
END = e._iso(NOW + timedelta(hours=2))
PAST = e._iso(NOW - timedelta(hours=1))


def box(x1, y1, x2, y2):
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]


def polygon(*rings):
    return {"type": "Polygon", "coordinates": list(rings)}


def toy_centers():
    rows = [
        (1, 0.3, 0.3, 10),
        (1, 1, 1, 20),
        (1, 1, 2, 30),
        (2, 5, 5, 40),
        (2, 179, 52, 50),
        (2, -179, 52, 60),
    ]
    return Centers(
        np.array(
            [(st * 10**10 + i, int(x * 1e6), int(y * 1e6), n) for i, (st, x, y, n) in enumerate(rows)],
            dtype=DTYPE,
        )
    )


def alert(ident="one", title="Flood Warning", geometry=None, **updates):
    return {
        "id": ident,
        "title": title,
        "family": "Flood",
        "effective": PAST,
        "expires": END,
        "states": ["AL"],
        "geometry": geometry or [],
        **updates,
    }


class PolygonTests(unittest.TestCase):
    def setUp(self):
        self.c = toy_centers()

    def test_union_holes_and_boundary(self):
        shell = box(0, 0, 4, 4)
        hole = box(0.7, 0.7, 1.5, 1.5)
        ids, g, b, _ = self.c.intersect(polygon(shell, hole))
        self.assertEqual((ids, g, b), ({0, 2}, 1, 0))
        ids, _, _, _ = self.c.intersect(polygon(shell, box(1, 1, 2, 2)))
        self.assertEqual(ids, {0, 1, 2})  # A polygon includes the boundaries of its holes.
        g = {"type": "MultiPolygon", "coordinates": [[shell, hole], [shell, hole]]}
        self.assertEqual(self.c.intersect(g)[0], {0, 2})

    def test_dateline_uses_short_arc(self):
        self.assertEqual(self.c.intersect(polygon(box(175, 50, -175, 53)))[0], {4, 5})

    def test_rank_deduplication_exclusive_and_cumulative(self):
        cov = e.Coverage()
        cov.polygon(self.c, polygon(box(0, 0, 6, 6)), 1)
        cov.polygon(self.c, polygon(box(0, 0, 6, 6)), 1)
        cov.polygon(self.c, polygon(box(0.5, 0.5, 2, 3)), 2)
        cov.polygon(self.c, polygon(box(0.5, 0.5, 1.1, 1.5)), 3)
        out = e._record(self.c, {}, cov, "current", "test", e.ERO)
        self.assertEqual(out["population"], 100)
        self.assertEqual([b["population"] for b in out["bands"]], [50, 30, 20, 0])
        self.assertEqual([b["at_or_above"] for b in out["bands"]], [100, 50, 20, 0])
        self.assertEqual(out["states"], [{"code": "AL", "population": 60}, {"code": "AK", "population": 40}])
        self.assertEqual(
            out["bands"][0]["states"], [{"code": "AK", "population": 40}, {"code": "AL", "population": 10}]
        )

    def test_missing_and_valid_zeros(self):
        broken = e.Coverage()
        broken.polygon(self.c, None)
        self.assertEqual(e._record(self.c, {}, broken, "current", "test")["status"], "unavailable")
        broken.polygon(self.c, polygon(box(0, 0, 0.5, 0.5)))
        total = e._record(self.c, {}, broken, "current", "test")
        self.assertEqual(
            (total["status"], total["population"], total["mapped_population"]), ("partial", None, 10)
        )
        some = e.Coverage()
        some.polygon(self.c, polygon(box(71, 71, 72, 72)))
        out = e._record(self.c, {}, some, "current", "test")
        self.assertEqual((out["population"], out["zero_basis"]), (0, "no_populated_center_in_footprint"))
        some.missing = 1
        out = e._record(self.c, {}, some, "current", "test")
        self.assertEqual((out["population"], out["mapped_population"]), (None, None))
        no_risk = e._record(self.c, {}, e.Coverage(), "current", "test")
        self.assertEqual((no_risk["population"], no_risk["zero_basis"]), (0, "no_qualifying_footprint"))


class FeedTests(unittest.TestCase):
    def setUp(self):
        self.c = toy_centers()

    def test_ero_missing_source_vs_explicit_empty(self):
        d = {
            "day": 1,
            "status": "current",
            "features": [],
            "valid_start": PAST,
            "valid_end": END,
            "fresh_until": END,
            "no_risk_area": True,
        }
        b = {"sources": {"ero": {"days": [d]}}}
        rows = e._ero(b, NOW, self.c, ("current", STAMP, END))
        self.assertEqual(rows[0]["population"], 0)
        self.assertIsNone(rows[1]["population"])
        d["no_risk_area"] = False
        self.assertIsNone(e._ero(b, NOW, self.c, ("current", STAMP, END))[0]["population"])
        d.update(no_risk_area=True, fresh_until=PAST)
        self.assertEqual(e._ero(b, NOW, self.c, ("current", STAMP, END))[0]["status"], "stale")

    def test_alert_expiry_zonal_geometry_and_unsupported_territory(self):
        g = polygon(box(0, 0, 2, 3))
        events = [
            alert(geometry=[g]),
            alert("two", geometry=[g]),
            alert("expired", geometry=[g], expires=PAST),
            alert(
                "zone",
                "Freeze Warning",
                ugc=["ALZ001"],
                zone_urls=["https://api.weather.gov/zones/forecast/ALZ001"],
            ),
            alert("marine", "Heavy Freezing Spray Warning", states=[]),
            alert(
                "no_polygon",
                "Flash Flood Warning",
                ugc=["ALZ001"],
                zone_urls=["https://api.weather.gov/zones/forecast/ALZ001"],
            ),
            alert(
                "fire_ref",
                "High Wind Warning",
                ugc=["ALZ001"],
                zone_urls=["https://api.weather.gov/zones/fire/ALZ001"],
            ),
            alert("island", "Hurricane Warning", states=["VI"], geometry=[polygon(box(-65, 18, -64, 19))]),
        ]
        b = {"sources": {"alerts": {"events": events}}}
        grouped, selected = e._alerts(b, NOW, self.c, ("current", STAMP, END), {"ALZ001": [0]})
        self.assertNotIn("expired", selected)
        self.assertNotIn("marine", selected)
        self.assertEqual(selected["one"]["population"], 60)
        self.assertEqual(next(r for r in grouped if r["label"] == "Flood Warning")["population"], 60)
        self.assertEqual(selected["zone"]["population"], 10)
        for ident in ["no_polygon", "fire_ref", "island"]:
            self.assertIsNone(selected[ident]["population"])
        self.assertEqual(selected["zone"]["valid_end"], END)

    def test_expired_segment_geometry_is_not_carried(self):
        g = polygon(box(0, 0, 2, 3))
        row = alert(
            geometry=[g], segments=[{"effective": PAST, "expires": END}, {"effective": PAST, "expires": PAST}]
        )
        cov, _ = e._event_coverage(self.c, row, {}, NOW)
        self.assertEqual((cov.valid, cov.missing), (0, 1))

    def test_outlook_separates_equal_hazard_different_dates(self):
        def fac(ident, start):
            return {
                "id": ident,
                "properties": {
                    "group": "precipitation",
                    "region": "Contiguous U.S.",
                    "hazard": "Heavy Rain",
                    "valid_start_date": start,
                    "valid_end_date": start,
                },
                "geometry": polygon(box(0, 0, 2, 3)),
            }

        b = {
            "sources": {
                "outlook": {
                    "features": [fac("x", "2026-11-27"), fac("y", "2026-11-27"), fac("z", "2026-11-28")],
                    "groups": [{"id": "precipitation", "status": "ok"}],
                }
            }
        }
        rows = e._outlook(b, NOW, self.c, ("current", STAMP, END))
        self.assertEqual([(r["population"], r["feature_ids"]) for r in rows], [(60, ["x", "y"]), (60, ["z"])])

    def test_wssi_source_cycles_and_original_geometry(self):
        w = {
            "issued": STAMP,
            "valid_start": "2026-11-24T18:00:00Z",
            "valid_end": "2026-11-27T18:00:00Z",
            "features": [
                {
                    "id": STAMP + "/3",
                    "properties": {"impact": "Moderate"},
                    "geometry": polygon(box(0, 0, 6, 6)),
                }
            ],
        }
        b = {"sources": {"winter": w}}
        p = {
            "objectid": 3,
            "impact": "MODERATE",
            "component": "WSSI_OVERALL",
            "product": "WINTER STORM SEVERITY INDEX",
            "issue_time": "2026-11-24 2224Z",
            "start_time": "18Z 11/24/26",
            "end_time": "18Z 11/27/26",
        }
        src = {
            "type": "FeatureCollection",
            "features": [{"properties": p, "geometry": polygon(box(0, 0, 0.5, 0.5))}],
        }
        self.assertEqual(e._winter(b, NOW, self.c, ("current", STAMP, END), src)[0]["population"], 10)
        with tempfile.TemporaryDirectory() as cache, patch.dict(os.environ, {"IDSS_WSSI_CACHE_DIR": cache}):
            w = b["sources"]["winter"]
            with patch.object(e, "_download_wssi_native", side_effect=[OSError("Temporary GIS failure"), src]) as download:
                first = e._wssi_native(w, None)
                self.assertEqual(download.call_count, 2)
            with patch.object(e, "_download_wssi_native", side_effect=OSError("offline")) as download:
                self.assertEqual(e._wssi_native(w, None), first)
                download.assert_not_called()
                changed = {**w, "valid_end": "2026-11-28T18:00:00Z"}
                with self.assertRaises(OSError):
                    e._wssi_native(changed, None)
                self.assertEqual(download.call_count, 2)
        p["start_time"] = "12Z 11/24/26"
        out = e._winter(b, NOW, self.c, ("current", STAMP, END), src)[0]
        self.assertEqual((out["status"], out["population"]), ("unavailable", None))

    def test_reference_and_source_failure(self):
        b = {"sources": {"alerts": {"status": "ok", "retrieved_at": PAST}}}
        self.assertEqual(e.source_state(b, "alerts", NOW)[0], "stale")
        b["sources"]["alerts"]["retrieved_at"] = STAMP
        b["attempts"] = {"alerts": {"retained": True}}
        self.assertEqual(e.source_state(b, "alerts", NOW)[0], "stale")
        missing = e.collect(b, NOW, reference_dir=Path(__file__).with_name("nonexistent-reference"))
        self.assertEqual(missing["status"], "unavailable")
        self.assertEqual(missing["groups"]["alerts"], [])

    def test_catalog_latest_effective_release_and_switch_day(self):
        def row(name, dt, h):
            return f'<tr><td>{dt}</td><td><a href="/source/gis/Shapefiles/WSOM/{name}">{name}</a></td><td>{h}</td></tr>'

        html = row("z_16ap26.zip", "16 April 2026", "0" * 32) + row(
            "z_01de26.zip", "1 December 2026", "1" * 32
        )
        self.assertEqual(e.catalog_edition(html, NOW)["filename"], "z_16ap26.zip")
        self.assertIsNone(e.catalog_edition(html, datetime(2026, 12, 1, tzinfo=timezone.utc)))
        self.assertEqual(
            e.catalog_edition(html, datetime(2026, 12, 2, tzinfo=timezone.utc))["filename"], "z_01de26.zip"
        )
        self.assertIsNone(e.catalog_edition("unavailable", NOW))


class Benchmarks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c, cls.manifest = load_reference()

    def test_national_and_territory_totals(self):
        j = self.manifest["jurisdictions"]
        self.assertEqual(sum(r["population"] for i, r in j.items() if i != "PR"), 331449281)
        self.assertEqual(j["AK"]["population"], 733391)
        self.assertEqual(j["HI"]["population"], 1455271)
        self.assertEqual(j["PR"]["population"], 3285874)
        self.assertEqual(self.manifest["populated_centers"], 240942)
        ids, _, _, _ = self.c.intersect(polygon(box(-69, 17, -65.15, 19.1)))
        self.assertEqual(e._stats(self.c, ids)[0], 3285874)
        ids, _, _, _ = self.c.intersect(polygon(box(-179, 18, -151, 30)))
        self.assertEqual(e._stats(self.c, ids)[0], 1455271)

    def test_zone_index_native_memberships_and_id_bounds(self):
        zones = json.loads(unpack(DEFAULT_DIR, self.manifest["zones"]))
        self.assertEqual(len(zones), 4025)
        self.assertEqual(len(zones["AKZ844"]), 58)
        self.assertEqual(len(zones["PRZ001"]), 858)
        for code, ids in zones.items():
            self.assertEqual(len(ids), len(set(ids)))
            self.assertTrue(all(0 <= i < len(self.c.geoid) for i in ids))


if __name__ == "__main__":
    unittest.main()


class MapLayerExposureTests(unittest.TestCase):
    def test_zone_watch_union_and_missing_code(self):
        from weather_exposure import winter_issuances
        events = [dict(id=name, event='Winter Storm Watch', effective=PAST, valid_end=END, states=['AL'],
                       ugc=[code], zone_urls=['https://api.weather.gov/zones/forecast/'+code])
                  for name,code in [('a','ALZ001'),('b','ALZ002')]]
        centers = toy_centers()
        rows = winter_issuances(centers, events, {'ALZ001':[0,1],'ALZ002':[1,2]}, STAMP, NOW)
        self.assertEqual((len(rows), rows[0]['population']), (1,60))
        partial = winter_issuances(centers, events, {'ALZ001':[0,1]}, STAMP, NOW)[0]
        self.assertEqual((partial['status'],partial['population'],partial['mapped_population']), ('partial',None,30))

    def test_future_or_expired_mpd_cannot_contribute_residents(self):
        from weather_exposure import discussions
        props = dict(number='0042', valid_start=PAST, valid_end=END, source_url='https://www.wpc.ncep.noaa.gov/')
        layer = dict(status='current', checked_at=STAMP, fresh_until=END, features=[
            dict(geometry=polygon(box(0,0,1.2,1.2)),properties=props),
            dict(geometry=polygon(box(0,0,5,5)),properties={**props,'valid_start':END}),
            dict(geometry=polygon(box(0,0,5,5)),properties={**props,'valid_end':PAST})])
        rows = discussions(toy_centers(), layer, NOW)
        self.assertEqual([(r['id'],r['population']) for r in rows], [('mpd-0042',30)])
        self.assertFalse(discussions(toy_centers(),{**layer,'fresh_until':PAST},NOW))
