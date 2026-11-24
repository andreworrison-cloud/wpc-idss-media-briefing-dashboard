import json
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import aviation

NOW = datetime(2026, 11, 24, 22, 50, tzinfo=timezone.utc)
START = "2026-11-24T22:00:00Z"
END = "2026-11-25T00:30:00Z"


def field(airport, **events):
    return {"airportId": airport, "latitude": "40.7", "longitude": "-73.8", **events}


def facility(airport, icao, state, city=None):
    return {"attributes": {"ARPT_ID": airport, "ICAO_ID": icao, "STATE_CODE": state, "CITY": city}}


class AviationTests(unittest.TestCase):
    def collected(self, records, stamp=NOW, xml_stamp=NOW, facilities=(), *, invalid_xml=False, bad_geo=False):
        def fetch(url, accept):
            if url == aviation.BTS_URL:
                raise OSError("BTS intentionally unavailable in FAA-only tests")
            if url == aviation.EVENTS_URL:
                return json.dumps(records).encode(), stamp
            if url == aviation.XML_URL:
                if invalid_xml:
                    return b"not FAA XML", NOW
                content = format_datetime(xml_stamp) if xml_stamp else ""
                return f"<AIRPORT_STATUS_INFORMATION><Update_Time>{content}</Update_Time></AIRPORT_STATUS_INFORMATION>".encode(), NOW
            self.assertTrue(url.startswith(aviation.FACILITIES_URL + "/query?"))
            params = parse_qs(urlsplit(url).query)
            self.assertNotIn("*", params["outFields"][0])
            if bad_geo:
                raise OSError
            return json.dumps({"features": list(facilities)}).encode(), NOW

        with patch.object(aviation, "fetch", side_effect=fetch):
            result = aviation.collect(NOW)
        json.dumps(result, allow_nan=False)
        return result

    def test_program_and_reported_delay_at_one_airport(self):
        row = field("ORD", airportLongName="Chicago OHare International",
                    groundDelay={"id": "gdp", "airportId": "ORD", "startTime": START, "endTime": END,
                                 "updatedAt": START, "avgDelay": 47.0, "maxDelay": 99,
                                 "impactingCondition": "equipment outage", "includedFlights": ": ALL CONTIGUOUS US DEP",
                                 "advisoryUrl": "https://www.fly.faa.gov/adv/adv_otherdis.jsp?advn=57&title=FAA ADV"},
                    arrivalDelay={"airportId": "ORD", "updateTime": START, "reason": "WX:Wind",
                                  "averageDelay": "30",
                                  "arrivalDeparture": {"type": "Arrival", "min": "31 minutes", "max": "45 minutes",
                                                       "trend": "Increasing"}})
        result = self.collected([row], facilities=[facility("ORD", "KORD", "IL", "CHICAGO")])
        self.assertEqual((result["status"], result["affected_airports"], result["event_count"]), ("ok", 1, 2))
        self.assertEqual(result["airports"], ["ORD"])
        program, report = result["events"]
        self.assertEqual((program["delay"], program["time_basis"]), ("Avg 47 min, max 99 min", "Program estimate"))
        self.assertEqual(program["reason"], "Equipment outage")
        self.assertIn("contiguous U.S.", program["scope"])
        self.assertEqual((report["delay"], report["reason"]), ("31–45 min, increasing", "Wind"))
        self.assertEqual((report["start_utc"], report["updated_utc"], report["time_basis"]), (None, START, "Reported delay"))
        self.assertEqual((report["city"], report["state"], report["icao"]), ("Chicago", "IL", "KORD"))
        self.assertEqual(report["flight_counts_url"], "https://www.flightaware.com/live/cancelled/today/KORD")
        self.assertTrue(program["source_url"].startswith("https://www.fly.faa.gov/adv/"))

    def test_restriction_is_scoped_and_contacts_removed(self):
        rec = {"startTime": START, "endTime": END, "notamNumber": 150,
               "text": "TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR CTC 555-012-3456 OR contact@example.com"}
        result = self.collected([field("LAS", freeForm=rec, airportClosure=dict(rec))])
        self.assertEqual(result["event_count"], 1)
        a = result["events"][0]
        self.assertEqual(a["kind"], "airport_restriction")
        self.assertIn("unscheduled transient general aviation", a["scope"])
        self.assertNotIn("555", json.dumps(result))
        self.assertNotIn("@", json.dumps(result))
        self.assertIsNone(a["reason"])

    def test_closed_stop_and_deicing_timing(self):
        stop = {"airportId": "SJU", "startTime": START, "endTime": "2026-11-24T22:47:00Z",
                "impactingCondition": "WEATHER / THUNDERSTORMS"}
        result = self.collected([field("SJU", groundStop=stop,
                                      airportClosure={"startTime": START, "endTime": "2026-11-24T22:48:00Z"}),
                                 field("ANC", deicing={"eventTime": "2026-11-24T23:00:00Z", "expTime": END}),
                                 field("HNL", deicing={"eventTime": START, "expTime": END})],
                                facilities=[facility("SJU", "TJSJ", "PR"), facility("ANC", "PANC", "AK"),
                                            facility("HNL", "PHNL", "HI")])
        self.assertEqual(result["airports"], ["HNL", "SJU"])
        stop, deicing = result["events"]
        self.assertEqual((stop["end_label"], stop["state"]), ("Next FAA update expected", "PR"))
        self.assertEqual(stop["reason"], "Thunderstorms")
        self.assertEqual(deicing["flight_counts_url"].rsplit("/", 1)[1], "PHNL")
        self.assertEqual(result["scheduled_events"][0]["state"], "AK")
        self.assertEqual(result["scheduled_events"][0]["phase"], "scheduled")

    def test_safe_missing_and_disputed_geocodes(self):
        row = field("ABC", groundDelay={"startTime": START, "avgDelay": 0,
                    "advisoryUrl": "https://www.fly.faa.gov.invalid/example",
                    "impactingCondition": "Contact 555-000-0000"}, latitude="nan")
        bad_geo = self.collected([row], bad_geo=True)
        a = bad_geo["events"][0]
        self.assertEqual(a["delay"], "Avg 0 min")
        self.assertEqual(a["source_url"], aviation.FAA_SITE)
        self.assertEqual([a[k] for k in ("state", "icao", "flight_counts_url", "reason", "lat", "lon")], [None] * 6)
        result = self.collected([row], facilities=[facility("ABC", "KABC", "OH"), facility("ABC", "PABC", "AK")])
        self.assertIsNone(result["events"][0]["state"])
        self.assertIsNone(result["events"][0]["flight_counts_url"])

    def test_future_at_snapshot_cannot_become_observed_without_an_update(self):
        snapshot = NOW - timedelta(minutes=10)
        row = field("LGA", groundDelay={"startTime": "2026-11-24T22:45:00Z", "endTime": END})
        result = self.collected([row], stamp=snapshot, xml_stamp=snapshot)
        self.assertEqual(result["event_count"], 0)
        self.assertEqual(result["scheduled_events"][0]["phase"], "scheduled")

    def test_http_clock_or_xml_clock_can_verify_feed(self):
        self.assertEqual(self.collected([], invalid_xml=True)["as_of_basis"], "FAA airport-events response")
        self.assertEqual(self.collected([], stamp=None)["as_of_basis"], "FAA feed update")
        self.assertEqual(self.collected([], stamp=None, invalid_xml=True)["status"], "unavailable")

    def test_stale_xml_or_event_response_is_not_freshened(self):
        old = NOW - timedelta(hours=1)
        for stamp, xmlstamp in [(NOW, old), (old, NOW), (NOW + timedelta(hours=2), NOW), (NOW, NOW + timedelta(hours=2))]:
            with self.subTest(stamp=stamp, xmlstamp=xmlstamp):
                result = self.collected([], stamp=stamp, xml_stamp=xmlstamp)
                self.assertEqual(result["status"], "stale")
                self.assertIsNone(result["event_count"])
                self.assertIsNone(result["affected_airports"])

    def test_quiet_valid_feed_does_not_zero_flight_counts(self):
        result = self.collected([field("ORD", airportConfig={"arrivalRate": 60})])
        self.assertEqual((result["affected_airports"], result["event_count"]), (0, 0))
        self.assertIsNone(result["flight_counts"]["delayed"])
        self.assertIsNone(result["flight_counts"]["cancelled"])
        self.assertEqual(self.collected([])["status"], "ok")

    def test_failure_or_schema_change_returns_unknown(self):
        with patch.object(aviation, "fetch", side_effect=OSError("Example")):
            self.assertIsNone(aviation.collect(NOW)["event_count"])
        for data in ({"error": "example"}, [{}], [field("ABC", previouslyUnknownEvent={})],
                     [field("LGA", departureDelay=5)], [field("LGA", groundStop={"startTime": "yesterday"})],
                     [field("LGA", groundStop={"airportId": "ORD", "startTime": START})]):
            with self.subTest(data=data):
                result = self.collected(data)
                self.assertEqual(result["status"], "unavailable")
                self.assertIsNone(result["event_count"])

    def test_departure_and_unrestricted_closure(self):
        result = self.collected([field("LAX", airportClosure={"text": "", "startTime": START, "endTime": END}),
                                 field("LGA", departureDelay={"reason": "WX:LOW CEILINGS", "averageDelay": 45,
                                                             "updateTime": START, "trend": "decreasing"})])
        closure, dep = result["events"]
        self.assertEqual(closure["kind"], "airport_closure")
        self.assertEqual((dep["kind"], dep["delay"]), ("departure_delay", "Avg 45 min, decreasing"))
        self.assertEqual(dep["reason"], "Low ceilings")



class MonthlyContextTests(unittest.TestCase):
    def page(self, *, airport="All Airports", carrier="All Carriers", delayed="11",
             cancelled="5", total="20", month="September", title="Reporting Operating Carrier"):
        header = "".join(f"<th>{v}</th>" for v in aviation.BTS_HEADER)
        cells = [month, "3", "15%", delayed, "55%", cancelled, "25%", "1", total]
        row = "".join(f"<td>{v}</td>" for v in cells)
        return f"""
          <h1>On-Time Performance - {title} Flight Delays at a Glance</h1>
          <select name="Airport"><option selected>{airport}</option></select>
          <select name="Carrier"><option selected>{carrier}</option></select>
          <select name="xYear"><option selected>2026</option></select>
          <table><tr>{header}</tr><tr>{row}</tr></table>""".encode()

    def test_month_is_explicit_and_independent_of_faa(self):
        def fetched(url, accept):
            if url == aviation.BTS_URL:
                return self.page(), NOW
            raise OSError("FAA unavailable")
        with patch.object(aviation, "fetch", side_effect=fetched):
            result = aviation.collect(NOW)
        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["flight_counts"]["cancelled"])
        month = result["monthly_context"]
        self.assertEqual((month["status"], month["period"], month["period_label"]),
                         ("historical", "2026-09", "September 2026"))
        self.assertEqual((month["delayed_arrivals"], month["cancelled"], month["flight_operations"]), (11, 5, 20))
        self.assertIn("at least 15 minutes", month["delay_definition"])

    def test_changed_scope_bad_counts_and_current_month_are_unavailable(self):
        for kwargs in ({"airport": "One airport"}, {"carrier": "One carrier"}, {"total": "99"},
                       {"delayed": "-3"}, {"month": "November"}, {"title": "Marketing Carrier"}):
            with self.subTest(kwargs=kwargs), patch.object(aviation, "fetch", return_value=(self.page(**kwargs), NOW)):
                month = aviation.monthly_context(NOW)
                self.assertEqual(month["status"], "unavailable")
                self.assertIsNone(month["cancelled"])

    def test_daily_cache_dated_fallback_and_newer_preference(self):
        with patch.object(aviation, "fetch", return_value=(self.page(), NOW)):
            month = aviation.monthly_context(NOW)
        with patch.object(aviation, "fetch", side_effect=OSError("BTS unavailable")) as source:
            self.assertEqual(aviation.monthly_context(NOW + timedelta(hours=2), month), month)
            source.assert_not_called()
            older = aviation.monthly_context(NOW + timedelta(days=2), month)
            self.assertEqual(older["period"], "2026-09")
            self.assertEqual(older["checked_at"], month["checked_at"])
            self.assertIn("last verified", older["detail"])
        with patch.object(aviation, "fetch", return_value=(self.page(month="August"), NOW)):
            self.assertEqual(aviation.monthly_context(NOW + timedelta(days=2), month)["period"], "2026-09")
        with patch.object(aviation, "fetch", return_value=(self.page(month="October"), NOW)):
            self.assertEqual(aviation.monthly_context(NOW + timedelta(days=2), month)["period_label"], "October 2026")

if __name__ == "__main__":
    unittest.main()
