from copy import deepcopy
from datetime import datetime, timedelta, timezone
import unittest
from unittest.mock import patch

import ground


NOW = datetime(2026, 5, 4, 12, 30, tzinfo=timezone.utc)
FILE = NOW - timedelta(minutes=10)
OBS = NOW - timedelta(minutes=50)


def fc(rows, **extra):
    return {"features": [{"attributes": r} for r in rows], **extra}


def groups(**counts):
    counts = {"no_flooding": 9000, **counts}
    return fc([{
        "status": category, "site_count": count, "file_min": FILE.timestamp()*1000,
        "file_max": FILE.timestamp()*1000, "last_observation": OBS.strftime("%Y-%m-%d %H:%M:%S"),
    } for category, count in counts.items() if count])


def site(lid="ONEA1", **changes):
    return {
        "gaugelid": lid, "state": "AL", "status": "major", "obstime": OBS.strftime("%Y-%m-%d %H:%M:%S"),
        "observed": "20.5", "units": "ft", "latitude": 33.5, "longitude": -86,
        "waterbody": "Test River", "location": "Testville", "idp_filedate": FILE.timestamp()*1000, **changes,
    }


def event(rid="record1", flags=("Road closure reported",), **changes):
    issued = ground.stamp(NOW-timedelta(minutes=25))
    return {
        "id": rid, "title": "Flash flood", "state": "AL", "city": "Testville", "county": "Example",
        "wfo": "BMX", "valid": ground.stamp(OBS), "issued": issued,
        "lat": 33.5, "lon": -86, "impact_flags": list(flags), "revision": "original",
        "source_url": ground.PRODUCT + "202605041205-KBMX-NWUS54-LSRBMX", **changes,
    }


def board(*rows, **fields):
    src = {"status": "ok", "query_complete": True, "events": list(rows), "count": len(rows),
           "window_end": ground.stamp(FILE), "window_start": ground.stamp(FILE-timedelta(hours=72)), **fields}
    return {"sources": {"reports": src}, "health": {"reports": {"status": "ok", "retained": False}}}


class RiverTests(unittest.TestCase):
    def test_fresh_categories_evidence_and_source_clock(self):
        rows = [site(status="minor"), site("TWOA1")]
        out = ground.classify_rivers(groups(minor=1, major=1), fc(rows), NOW)
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["counts"], {"minor":1,"moderate":0,"major":1})
        self.assertEqual(out["total"], 2)
        self.assertEqual(out["asOf"], ground.stamp(FILE))
        s = out["sites"][0]
        self.assertEqual((s["id"], s["observedAt"], s["type"], s["state"], s["value"], s["unit"]),
                         ("TWOA1", ground.stamp(OBS), "observed", "AL", 20.5, "ft"))
        self.assertEqual(s["url"], "https://water.noaa.gov/gauges/twoa1")

    def test_true_zero_requires_current_classified_network_and_complete_details(self):
        good = ground.classify_rivers(groups(), fc([]), NOW)
        self.assertEqual((good["status"], good["total"], good["counts"]["major"]), ("ok", 0, 0))
        for stats, data in [(fc([]), fc([])), ({"error":{}}, fc([])), (groups(), None),
                            (fc([{"status":"obs_not_current", "site_count":50, "file_min":1, "file_max":1, "last_observation":"N/A"}]), fc([]))]:
            self.assertIsNone(ground.classify_rivers(stats,data,NOW)["total"])

    def test_freshly_generated_but_frozen_sensor_network_cannot_publish_zero(self):
        d = groups()
        d["features"][0]["attributes"]["last_observation"] = ground.stamp(NOW-timedelta(hours=7))
        r = ground.classify_rivers(d, fc([]), NOW)
        self.assertEqual(r["status"], "stale")
        self.assertIsNone(r["total"])

    def test_old_file_cannot_publish_fresh_numbers(self):
        r = ground.classify_rivers(groups(major=1), fc([site()]), NOW+timedelta(hours=4))
        self.assertEqual(r["status"], "stale")
        self.assertEqual(r["sites"], [])
        self.assertIsNone(r["counts"]["major"])

    def test_stale_future_forecast_and_foreign_gauges_are_excluded(self):
        rows = [site("GOOD1"), site("OLDA1",obstime=ground.stamp(NOW-timedelta(hours=8))),
                site("FUTA1",obstime=ground.stamp(NOW+timedelta(hours=1))),
                site("FORE1",status="forecast"), site("OTHR1",state="BC")]
        r = ground.classify_rivers(groups(major=4), fc(rows), NOW)
        self.assertEqual((r["status"],r["excludedOld"],r["availableCount"],r["total"]), ("partial",1,1,None))
        self.assertEqual([s["id"] for s in r["sites"]], ["GOOD1"])

    def test_incomplete_counts_truncation_and_refresh_race(self):
        s = site()
        another_edition = site("TWOA1", idp_filedate=(FILE-timedelta(minutes=30)).timestamp()*1000)
        for expected, data in [(groups(major=2), fc([s])), (groups(major=1), fc([s],exceededTransferLimit=True)),
                               (groups(major=2), fc([s,another_edition]))]:
            r = ground.classify_rivers(expected, data, NOW)
            self.assertEqual((r["status"],r["total"],r["availableCount"]), ("partial",None,1))

    def test_known_old_observation_does_not_invalidate_six_hour_subset(self):
        old = site("OLDA1", obstime=ground.stamp(NOW-timedelta(hours=8)))
        r = ground.classify_rivers(groups(major=2), fc([site(), old]), NOW)
        self.assertEqual((r["status"], r["total"], r["counts"]["major"], r["excludedOld"]), ("ok", 1, 1, 1))
        r = ground.classify_rivers(groups(major=1), fc([old]), NOW)
        self.assertEqual((r["status"], r["total"], r["excludedOld"]), ("ok", 0, 1))
        for rows in [[site("OLDA1"), old], [old, site("OLDA1")], [old, old]]:
            r = ground.classify_rivers(groups(major=2), fc(rows), NOW)
            self.assertEqual((r["status"], r["total"], r["availableCount"]), ("partial", None, 0))

    def test_conflicting_gauge_id_and_raw_measurement_sentinel(self):
        good = site("GOOD1",observed=-999,longitude=None)
        r = ground.classify_rivers(groups(major=2,minor=1),fc([site(),site(status="minor"),good]),NOW)
        self.assertEqual((r["status"],r["availableCount"]),("partial",1))
        self.assertEqual(r["sites"][0]["id"],"GOOD1")
        self.assertIsNone(r["sites"][0]["latitude"])
        self.assertIsNone(r["sites"][0]["value"])

    def test_limit_changes_display_only(self):
        rows=[site(f"A{i:04}") for i in range(ground.SITE_LIMIT+1)]
        r = ground.classify_rivers(groups(major=len(rows)),fc(rows),NOW)
        self.assertEqual(r["total"], len(rows)); self.assertEqual(len(r["sites"]),ground.SITE_LIMIT)


class ReportTests(unittest.TestCase):
    def test_one_report_can_have_multiple_impacts_and_public_evidence_only(self):
        e = event(flags=("Rescue reported","Stranded vehicles reported","Burn scar mentioned in report"), remark="uncopied")
        r=ground.classify_reports(board(e, impact_flag_types=list(ground.IMPACTS.values())), NOW)
        self.assertEqual((r["status"],r["total"],r["counts"]["rescue"],r["counts"]["strandedVehicle"]), ("ok",1,1,1))
        x=r["items"][0]
        self.assertEqual(r["counts"]["structuralDamage"],0)
        self.assertEqual(x["observedAt"],ground.stamp(OBS)); self.assertEqual(x["reportedAt"], e["issued"])
        self.assertNotIn("remark",x); self.assertEqual(x["url"],e["source_url"])
        self.assertEqual(x["state"],"AL")

    def test_legacy_generic_wind_damage_never_proves_structural_damage(self):
        r=ground.classify_reports(board(event(flags=(),title="Thunderstorm wind damage")),NOW)
        self.assertEqual((r["status"],r["total"],r["counts"]["roadClosure"]), ("ok",0,0))
        self.assertIsNone(r["counts"]["structuralDamage"])
        self.assertNotIn("structuralDamage",r["supportedCategories"])

    def test_explicit_structural_damage_and_separate_records_at_same_point(self):
        r=ground.classify_reports(board(event(),event("other",("Structural damage reported",)),
                                         impact_flag_types=list(ground.IMPACTS.values())),NOW)
        self.assertEqual((r["total"],r["counts"]["roadClosure"],r["counts"]["structuralDamage"]),(2,1,1))

    def test_use_event_and_issuance_cutoffs_and_exclude_withdrawals(self):
        r=ground.classify_reports(board(event(),event("future",issued=ground.stamp(NOW)),
              event("out",valid=ground.stamp(FILE-timedelta(hours=25))),event("withdrawn",revision="withdrawal")),NOW)
        self.assertEqual((r["status"],r["total"]),("ok",1))
        self.assertEqual(r["items"][0]["id"],"record1")

    def test_invalid_origin_future_at_issuance_and_unmatched_revisions_lack_attribution(self):
        for invalid in [event("other", source_url="https://example.org/unverified"),event("other", revision_match="unmatched"),
                        event("other", state="BC"),event("other", valid=ground.stamp(FILE))]:
            r=ground.classify_reports(board(event(),invalid),NOW)
            self.assertEqual((r["status"],r["total"],r["availableCount"]),("partial",None,1))

    def test_unavailable_retained_short_or_stale_read_never_zero(self):
        retained = board()
        retained["health"]["reports"]["retained"] = True
        for source in [None, {}, retained,board(status="partial",count=None), board(query_complete=False),
                       board(window_start=ground.stamp(FILE-timedelta(hours=3))), board(status="unavailable"),
                       board(window_end=ground.stamp(NOW-timedelta(hours=3)))]:
            self.assertIsNone(ground.classify_reports(source,NOW)["total"])
        self.assertEqual(ground.classify_reports(board(),NOW+timedelta(hours=3))["status"],"stale")

    def test_missing_coordinates_dont_create_a_map_point(self):
        r=ground.classify_reports(board(event(lat=None, lon=50, city=None, county="Test Parish", state="LA")),NOW)
        x=r["items"][0]; self.assertIsNone(x["latitude"]); self.assertIsNone(x["longitude"])
        self.assertEqual(x["location"], "Test Parish")

    def test_rank_rescues_before_closures_and_keep_exact_total_when_capped(self):
        rows=[event(str(i)) for i in range(ground.REPORT_LIMIT+1)]+[event("help",("Rescue reported",))]
        r=ground.classify_reports(board(*rows),NOW)
        self.assertEqual(r["total"],len(rows))
        self.assertEqual(len(r["items"]),ground.REPORT_LIMIT)
        self.assertEqual(r["items"][0]["id"],"help")

    def test_river_transport_failure_does_not_lose_storm_reports(self):
        with patch("ground.query",side_effect=OSError("no response")):
            r=ground.collect(board(event()),ground.stamp(NOW))
        self.assertEqual((r["status"],r["rivers"]["total"],r["reports"]["total"]),("partial",None,1))


if __name__ == "__main__":
    unittest.main()
