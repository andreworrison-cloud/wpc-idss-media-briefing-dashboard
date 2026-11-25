import io
import json
import unittest
import zipfile
from unittest.mock import patch

import report_layers as m

END = m.instant("2026-11-24T20:00:00Z")
NAME = "PNSBUF_202611241700.txt"


def product(table, corrected=False):
    return f"""311
NOUS41 KBUF 241700
PNSBUF
NYZ001>002-251500-

Public Information Statement{"...Corrected" if corrected else ""}
National Weather Service Buffalo NY
1200 PM EST Tue Nov 24 2026

{table}

$$
"""


def parse(table):
    return m.pns_product(NAME, product(table), END)


def archive(files):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        for name, body in files.items():
            z.writestr(name, body)
    return out.getvalue()


def board(events, **changes):
    return {
        "sources": {
            "reports": {
                "status": "ok",
                "query_complete": True,
                "events": events,
                "window_start": "2026-11-21T20:00:00Z",
                "window_end": m.stamp(END),
                **changes,
            }
        }
    }


def event(title="Hail", value=1, unit="in", **overrides):
    return {
        "id": "lsr-" + title,
        "title": title,
        "wfo": "BUF",
        "state": "NY",
        "county": "Erie",
        "city": "Buffalo",
        "lat": 42.9,
        "lon": -78.9,
        "valid": "2026-11-24T16:00:00Z",
        "issued": "2026-11-24T17:00:00Z",
        "magnitude": value,
        "unit": unit,
        "qualifier": "Measured",
        "source_url": m.TEXT + "202611241700-KBUF-NWUS51-LSRBUF",
        "impact_flags": [],
        **overrides,
    }


class ProductTests(unittest.TestCase):
    def test_compact_and_extended_exact_match_once(self):
        rows, kind, _ = parse("""...SNOWFALL REPORTS...
Location                     Amount    Time/Date       Provider
...New York...
...Erie County...
2 W Buffalo                  2.5 Inch  0700 AM 11/24   Trained Spotter
&&
:11/24/2026,0700 AM, NY, Erie, Buffalo, 2, W, 42.9, -78.9, SNOW_24, 2.5, Inch, Public, 24 hour snowfall,""")
        self.assertEqual((kind, len(rows)), ("measurement", 1))
        r = rows[0]
        self.assertEqual(
            (r["place"], r["office"], r["value"], r["durationHours"]), ("2 W Buffalo", "BUF", 2.5, 24)
        )
        self.assertEqual((r["observedAt"], r["issuedAt"]), ("2026-11-24T12:00:00Z", "2026-11-24T17:00:00Z"))
        self.assertTrue(r["url"].endswith("202611241700-KBUF-NOUS41-PNSBUF"))

    def test_plaintext_source_coordinates_and_unlocated_trace(self):
        rows, kind, _ = parse("""...24 HOUR SNOWFALL REPORTS...
Location                     Amount    Time/Date       Lat/Lon/Elev
...New York...
...Erie County...
Buffalo                      T Inch    0800 AM 11/24
Ski Area                     12 Inch   0900 AM 11/24   42.88N/78.86W""")
        self.assertEqual(kind, "measurement")
        self.assertIsNone(rows[0]["value"])
        self.assertTrue(rows[0]["trace"])
        self.assertIsNone(rows[0]["latitude"])
        self.assertEqual(
            (rows[1]["latitude"], rows[1]["longitude"], rows[1]["durationHours"]), (42.88, -78.86, 24)
        )

    def test_mixed_precipitation_note_does_not_create_ice_or_rain(self):
        rows, _, _ = parse("""...PRECIPITATION REPORTS FOR THE LAST 48 HOURS...
...AMOUNTS MAY INCLUDE SNOW MELT, FREEZING RAIN AND RAIN...
...New York...
...Erie County...
Buffalo                    1.25 in   0600 AM 11/24
&&
:11/24/2026,0600 AM,NY,Erie,Example Station,,,42.9,-78.9,RAIN_24,1.25,Inch,COOP,24 hour rainfall,""")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["measurementType"], "precipitation")
        self.assertEqual(rows[0]["durationHours"], 24)
        self.assertIsNone(m.heading_duration("SNOWFALL REPORTS FOR THE LAST 48 HOURS"))

    def test_end_of_year_timezone_future_and_out_of_window(self):
        self.assertEqual(
            m.stamp(m.from_local("12/31", "1100 PM", "PST", m.instant("2027-01-01T12:00:00Z"))),
            "2027-01-01T07:00:00Z",
        )
        rows, _, _ = parse("""...SNOWFALL REPORTS...
...New York...
...Erie County...
Buffalo                      20 in      0100 PM 11/24
Olcott                       21 in      0100 PM 11/20""")
        self.assertEqual(rows, [])

    def test_unknown_or_foreign_coordinates_and_private_station_name(self):
        rows, _, _ = parse(
            """:11/24/2026,0700 AM, NY, Erie, John Doe personal station, , , 42.9, 78.9, SNOW_24, 2.5, Inch, John Doe, 24 hour snowfall,"""
        )
        r = rows[0]
        self.assertIsNone(r["longitude"])
        self.assertEqual(r["place"], "Erie reporting area")
        self.assertNotIn("John Doe", json.dumps(r))

    def test_different_phenomena_capabilities_and_units(self):
        data = "\n".join(
            f":11/24/2026,0700 AM, NY, Erie, Buffalo, , , 42.9, -78.9, {typ}, {v}, {u}, Trained Spotter, Report,"
            for typ, v, u in [
                ("PKGUST", "40", "kt"),
                ("SNOW_D", "12", "inch"),
                ("SLEET", "2", "inch"),
                ("FREEZING_RAIN", "0.25", "inch"),
                ("HEAT_INDEX", "102", "F"),
                ("WIND_CHILL", "-30", "F"),
            ]
        )
        rows, _, _ = parse(data)
        d = {r["measurementType"]: r["value"] for r in rows}
        self.assertEqual(
            d,
            {
                "windGust": 46.031,
                "snowDepth": 12,
                "sleet": 2,
                "iceAccretion": 0.25,
                "heatIndex": 102,
                "windChill": -30,
            },
        )

    def test_correction_replaces_missing_row_same_office_ugc_and_heading(self):
        f1 = "PNSBUF_202611241600.txt"
        f2 = NAME
        heading = "...RAINFALL REPORTS...\n...New York...\n...Erie County...\n"
        files = {
            f1: product(heading + "Buffalo                    7.0 in   0600 AM 11/24"),
            f2: product(heading + "Olcott                      2.0 in   0600 AM 11/24", True),
        }
        with patch.object(m, "fetch", return_value=archive(files)):
            rows, info = m.pns_rows(END)
        self.assertEqual(info["supersededBulletins"], 1)
        self.assertEqual([r["place"] for r in rows], ["Olcott"])
        self.assertEqual(rows[0]["url"], m.TEXT + "202611241700-KBUF-NOUS41-PNSBUF")

    def test_office_history_and_narrative_forecast_are_not_observations(self):
        rows, kind, _ = parse("...TODAY IN WEATHER HISTORY...\nForecast snowfall 12 inches at Buffalo.")
        self.assertEqual((rows, kind), ([], "other"))

    def test_failed_reads_are_not_observed_zero_and_stale_time_not_relabelled(self):
        with patch.object(m, "fetch", side_effect=OSError("offline")):
            d = m.collect(END, board=None)
        self.assertEqual(d["status"], "unavailable")
        self.assertIsNone(d["counts"]["located"])
        self.assertIsNone(d["sources"]["pns"]["asOf"])
        self.assertEqual(d["leaderStatus"]["snow"], "unknown")
        with patch.object(m, "fetch", return_value=archive({})):
            d = m.collect(END, board([]))
        self.assertEqual(d["counts"]["located"], 0)
        self.assertEqual(d["leaderStatus"]["snow"], "noQualifyingReport")

    def test_lsr_tornado_and_landslide_remain_named_events_and_snow_wins_only_new_snow(self):
        events = [
            event("Hail", 25.4, "mm"),
            event("Tornado", 2, "°F"),
            event("Landslide", None, None),
            event("Snow", 5, "in"),
            event("Marine thunderstorm wind", 65, "mph"),
            event("Non-thunderstorm wind gust", 45, "mph"),
            event("Wind chill", -49, "°F"),
            event("Heat", 101, "°F"),
        ]
        with patch.object(m, "fetch", return_value=archive({})):
            d = m.collect(END, board(events))
        self.assertEqual(d["leaders"]["hail"][0]["value"], 1)
        self.assertEqual(d["leaders"]["wind"][0]["value"], 45)
        self.assertEqual(d["leaders"]["cold"][0]["value"], -49)
        self.assertEqual(d["leaders"]["heat"], [])
        self.assertTrue(
            all(
                r["value"] is None
                for r in d["features"]
                if r["phenomenon"] in ("Landslide", "Tornado", "Heat")
            )
        )

    def test_trace_without_unit_is_not_assigned_inch_or_zero(self):
        rows, _ = m.lsr_rows(board([event("Snow", None, None, trace=True)]), END)
        self.assertEqual((rows[0]["trace"], rows[0]["value"], rows[0]["unit"]), (True, None, None))

    def test_lsr_strict_issue_and_observation_cutoff_with_source_status(self):
        data = board(
            [
                event(),
                event("Snow", 3, "in", issued="2026-11-25T00:05:00Z"),
                event("Tornado", valid="2026-11-24T18:00:00Z"),
            ]
        )
        rows, meta = m.lsr_rows(data, END)
        self.assertEqual(len(rows), 1)
        self.assertEqual(meta["status"], "partial")
        stale = board([], window_end="2026-11-24T16:00:00Z")
        self.assertEqual(m.lsr_rows(stale, END)[1]["status"], "stale")


if __name__ == "__main__":
    unittest.main()
