import copy
import json
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import power


NOW = datetime(2026, 11, 24, 22, 52, tzinfo=timezone.utc)
STAMP = "2026-11-24T22:50:00Z"
OTHER = "2026-11-24T22:45:00Z"
OLD = "2026-11-24T21:50:00Z"
COUNTY_PATH = "/outages/counties?limit=500&offset=0"


def packet(data, stamp=STAMP, **meta):
    return {"data": data, "meta": {"updated": stamp, **meta}}


def feeds():
    return {
        "/outages": packet({
            "customers_out": 9, "states_affected": 1, "counties_affected": 2,
            "utilities_reporting": 3, "coverage": {"customers_tracked": 100, "customers": 200, "share": 0.5},
        }),
        "/outages/states": packet([
            {"state": "CA", "name": "California", "customers_out": 8, "customers": 200, "coverage": 0.5},
            {"state": "VT", "name": "Vermont", "customers_out": 0, "customers": 100, "coverage": 0.4},
            {"state": "AK", "name": "Alaska", "customers_out": 0, "customers": 200, "coverage": None},
        ], count=3),
        "/status": packet({
            "states": [{"state": "CA", "customers_tracked": 100}],
            "utilities_on_previous_reading": 1,
        }),
        COUNTY_PATH: packet([
            {"fips": "06023", "name": "Humboldt County", "state": "CA", "customers_out": 4,
             "customers": 999, "share_out": 0.004},
            {"fips": "06037", "name": "Los Angeles County", "state": "CA", "customers_out": 3,
             "customers": 999, "share_out": 0.003},
        ], count=2, offset=0),
    }


def collect(fixtures):
    def get(path):
        response = fixtures[path]
        if isinstance(response, Exception):
            raise response
        return copy.deepcopy(response)

    with patch.object(power, "_get", side_effect=get):
        return power.collect(NOW)


class ElectricityTests(unittest.TestCase):
    def test_source_times_geography_units_and_separate_counts(self):
        r = collect(feeds())
        self.assertEqual((r["status"], r["states_status"], r["counties_status"]), ("current",) * 3)
        self.assertEqual(r["checked_at"], "2026-11-24T22:52:00Z")
        self.assertEqual(r["as_of"], STAMP)
        self.assertEqual(r["stale_after"], "2026-11-24T23:20:00Z")
        self.assertEqual(r["customers_out"], 9)
        self.assertEqual(r["counties"][0]["fips"], "06023")
        self.assertEqual(sum(x["customers_out"] for x in r["counties"]), 7)
        self.assertAlmostEqual(r["counties"][0]["lat"], 40.7, delta=0.5)
        self.assertLess(r["counties"][0]["lon"], -120)
        self.assertEqual(r["states"][0]["fips"], "06")
        self.assertEqual(r["states"][0]["affected_counties"], 2)
        self.assertEqual(r["coverage_percent"], 50)
        self.assertEqual(r["states"][0]["customers_tracked"], 100)
        self.assertEqual(r["previous_reading_utilities"], 1)
        self.assertIsNone(r["counties"][0]["customers_tracked"])
        self.assertIsNone(r["counties"][0]["percent_out"])
        self.assertIn({"label": "Power Out Map", "url": "https://poweroutmap.com/"}, r["links"])
        json.dumps(r, allow_nan=False)

    def test_national_history_preserves_gaps_and_zero(self):
        data = feeds()
        data["/outages/history"] = packet({
            "start": "2026-11-24T21:45:00Z", "step_minutes": 15,
            "customers_out": [19, None, -3, 0, 9],
        })
        result = collect(data)
        self.assertEqual(result["history"]["counts"], [19, None, None, 0, 9])
        self.assertEqual(result["history"]["status"], "current")
        self.assertEqual(result["history"]["as_of"], STAMP)
        for key, replacement in [("start", "2026-11-23T20:00:00Z"), ("step_minutes", 30), ("start", "n/a")]:
            with self.subTest(key=key, replacement=replacement):
                broken = copy.deepcopy(data)
                broken["/outages/history"]["data"][key] = replacement
                failed = collect(broken)
                self.assertEqual(failed["history"]["status"], "unavailable")
                self.assertEqual(failed["customers_out"], 9)
        data["/outages/history"]["meta"]["updated"] = OLD
        self.assertEqual(collect(data)["history"]["status"], "stale")

    def test_zero_only_with_reported_coverage(self):
        r = collect(feeds())
        states = {state["state"]: state for state in r["states"]}
        self.assertIsNone(states["AK"]["customers_out"])
        self.assertEqual(states["VT"]["customers_out"], 0)
        self.assertEqual(r["covered_states"], 2)
        data = feeds()
        data["/outages"]["data"].update(customers_out=0, utilities_reporting=0)
        self.assertIsNone(collect(data)["customers_out"])

    def test_stale_source_date_does_not_use_retrieval_clock(self):
        data = feeds()
        data["/outages"]["meta"].update(updated=OLD, generated=STAMP)
        r = collect(data)
        self.assertEqual(r["status"], "stale")
        self.assertEqual(r["as_of"], OLD)
        self.assertEqual(r["counties"], [])
        self.assertIsNone(r["customers_out"])
        self.assertIsNone(r["customers_tracked"])

    def test_reject_missing_malformed_and_future_timestamps(self):
        for stamp in [None, "yesterday", "2026-11-24T22:45:00", "2026-11-25T00:00:00Z"]:
            with self.subTest(stamp=stamp):
                data = feeds()
                data["/outages"]["meta"]["updated"] = stamp
                r = collect(data)
                self.assertEqual(r["status"], "unavailable")
                self.assertIsNone(r["as_of"])
                self.assertIsNone(r["customers_out"])

    def test_no_fabricated_totals_when_provider_fails(self):
        data = feeds()
        data["/outages"] = TimeoutError()
        r = collect(data)
        self.assertEqual(r["states"], [])
        self.assertIsNone(r["customers_out"])
        data = feeds()
        data["/outages"]["data"]["customers_out"] = True
        self.assertEqual(collect(data)["status"], "unavailable")

    def test_stale_or_failed_independent_layers(self):
        data = feeds()
        data[COUNTY_PATH]["meta"]["updated"] = OLD
        r = collect(data)
        self.assertEqual(r["counties_status"], "stale")
        self.assertEqual(r["counties_as_of"], OLD)
        self.assertIsNone(r["states"][0]["affected_counties"])
        self.assertEqual(r["customers_out"], 9)
        data["/outages/states"] = OSError()
        self.assertEqual(collect(data)["states_status"], "unavailable")

    def test_layers_with_different_times_cannot_share_denominators(self):
        data = feeds()
        data["/status"]["meta"]["updated"] = OTHER
        data[COUNTY_PATH]["meta"]["updated"] = OTHER
        r = collect(data)
        self.assertEqual(r["counties_as_of"], OTHER)
        self.assertEqual(r["states_as_of"], STAMP)
        self.assertIsNone(r["states"][0]["customers_tracked"])
        self.assertEqual(r["states"][0]["coverage_percent"], 50)
        self.assertIsNone(r["states"][0]["affected_counties"])
        self.assertIsNone(r["previous_reading_utilities"])

    def test_duplicate_fips_and_malformed_state_do_not_replace_independent_sections(self):
        data = feeds()
        data[COUNTY_PATH]["data"][1]["fips"] = "06023"
        r = collect(data)
        self.assertEqual(r["counties_status"], "inconsistent")
        self.assertEqual(r["counties"], [])
        self.assertEqual(len(r["states"]), 3)
        data = feeds()
        data["/outages/states"]["data"][1]["state"] = "CA"
        r = collect(data)
        self.assertEqual(r["states_status"], "inconsistent")
        self.assertEqual(len(r["counties"]), 2)

    def test_pagination_all_pages_required_and_stamp_must_match(self):
        data = feeds()
        first, second = "/outages/counties?limit=1&offset=0", "/outages/counties?limit=1&offset=1"
        rows = data[COUNTY_PATH]["data"]
        data[first] = packet(rows[:1], count=2, offset=0)
        data[second] = packet(rows[1:], count=2, offset=1)
        with patch.object(power, "PAGE_SIZE", 1):
            self.assertEqual(len(collect(data)["counties"]), 2)
            data[second]["meta"]["updated"] = OTHER
            self.assertEqual(collect(data)["counties_status"], "inconsistent")
            data[second] = OSError()
            r = collect(data)
            self.assertEqual(r["counties_status"], "unavailable")
            self.assertEqual(r["counties"], [])
            self.assertEqual(r["customers_out"], 9)

    def test_explicit_empty_mapped_layer(self):
        data = feeds()
        data[COUNTY_PATH] = packet([], count=0, offset=0)
        self.assertEqual(collect(data)["counties_status"], "inconsistent")
        data["/outages"]["data"]["counties_affected"] = 0
        r = collect(data)
        self.assertEqual((r["counties_status"], r["counties"]), ("current", []))
        self.assertEqual(r["customers_out"], 9)

    def test_unusual_missing_geometry_retains_explicit_source_count(self):
        data = feeds()
        data[COUNTY_PATH]["data"][0]["fips"] = "06999"
        r = collect(data)
        self.assertEqual(r["counties_status"], "current")
        self.assertIsNone(r["counties"][0]["lat"])
        self.assertEqual(r["counties"][0]["customers_out"], 4)

    def test_census_coordinates_include_legacy_connecticut(self):
        points = power._load_points()
        self.assertEqual(points["09001"][0], "CT")
        self.assertEqual(points["09110"][0], "CT")
        self.assertEqual(points["02"][0], "AK")
        self.assertEqual(points["15003"][0], "HI")


if __name__ == "__main__":
    unittest.main()
