import copy
import json
import struct
import unittest
import zlib
from datetime import timedelta
from urllib.parse import urlsplit
from unittest.mock import patch

import hydro_layers as h

NOW = h.from_iso("2026-11-24T23:48:00Z")
REV = "a"*40
NUMBER = "1592"
PRODUCT = "5c2c1bca-ab3e-43f1-9a7c-96cb310ba148"
PRODUCT_URL = "https://api.weather.gov/products/" + PRODUCT
INDEX = {"@graph":[{"id":PRODUCT,"@id":PRODUCT_URL,"productCode":"FFG","issuanceTime":"2026-11-24T20:00:00Z","wmoCollectiveId":"AWUS01","issuingOffice":"KWNH"}]}
QUIET = '''<td>Current Mesoscale Precipitation Discussions (MPDs)</td>
<td class="nompd">No MPDs are currently in effect.</td>
<td><a href="/metwatch/metwatch_mpd_multi.php?md=1592&amp;yr=2026">Most recently issued MPD: #1592</a></td>'''
ACTIVE = '''<td>Current Mesoscale Precipitation Discussions (MPDs)</td>
<a href="/metwatch/metwatch_mpd_multi.php?md=1592&amp;yr=2026">Discussion 1592</a>'''
TEXT = """AWUS01 KWNH 242000
FFGMPD

Mesoscale Precipitation Discussion 1592
NWS Weather Prediction Center College Park MD
300 PM EST Tue Nov 24 2026

Areas affected...Southern California
Concerning...Heavy rainfall...Flash flooding possible
Valid 242000Z - 250200Z

LAT...LON   34202000 34402000 34401950 34101890
"""
DATA = dict(INDEX["@graph"][0],productText=TEXT)
FRAME = {"png":"frames/mrms_rala_20261124T234038Z.png","valid_time_utc":"2026-11-24T23:40:38Z",
         "source_url":"https://mrms.ncep.noaa.gov/2D/ReflectivityAtLowestAltitude/MRMS_ReflectivityAtLowestAltitude_00.50_20261124-234038.grib2.gz",
         "source_key":"MRMS_ReflectivityAtLowestAltitude_00.50_20261124-234038.grib2.gz"}
MANIFEST = {"metadata_mode":"mrms_rala_loop_manifest_v2","product":"ReflectivityAtLowestAltitude","region":"CONUS",
            "units":"dBZ","display":{"projection":"EPSG:3857","resampling":"nearest-neighbor","smoothing":False,
            "visible_minimum_dbz":5,"leaflet_bounds":[[20,-130],[55,-60]],"image_width_px":7,"image_height_px":5,
            "color_table":[{"threshold_dbz":5,"color":"#74c7ec"},{"threshold_dbz":10,"color":"#4aa8df"}]},
            "frames":[FRAME],"frame_count":1,"target_frame_cadence_minutes":10,"latest_valid_time_utc":FRAME["valid_time_utc"],
            "freshness_limit_minutes":20,"generated_utc":"2026-11-24T23:43:00Z"}

def png(width,height,alpha):
    def chunk(name,b):
        return struct.pack(">I",len(b))+name+b+struct.pack(">I",zlib.crc32(name+b))
    data=bytearray((width*4+1)*height)
    data[4]=alpha
    return b"\x89PNG\r\n\x1a\n"+chunk(b"IHDR",struct.pack(">IIBBBBB",width,height,8,6,0,0,0))+chunk(b"IDAT",zlib.compress(data))+chunk(b"IEND",b"")

def routes(html, index, data):
    def fetch(url, limit):
        if "metwatch_mpd_multi" in url:
            return ("<pre>"+TEXT+"</pre>").encode()
        if h.CURRENT_PATH in url and html is not None:
            return html.encode()
        if url==h.NWS_PRODUCTS and index is not None:
            return json.dumps(index).encode()
        if url==PRODUCT_URL and data is not None:
            return json.dumps(data).encode()
        raise OSError("provider unavailable")
    return fetch


class Radar(unittest.TestCase):
    def test_bounds_time_and_immutable_frame(self):
        r=h.check_radar(MANIFEST,REV,NOW)
        self.assertEqual(r["status"],"current")
        self.assertIn(REV,r["image_url"])
        self.assertIn("20261124T234038Z",r["image_url"])
        self.assertEqual(r["fresh_until"],"2026-11-25T00:00:38Z")

    def test_stale_and_future(self):
        r=h.check_radar(MANIFEST,REV,h.from_iso("2026-11-25T00:00:38Z"))
        self.assertEqual((r["status"],r["image_url"],r["frames"]),("stale",None,[]))
        with self.assertRaises(ValueError):
            h.check_radar(MANIFEST,REV,NOW-timedelta(minutes=20))

    def test_invalid_source_or_filename(self):
        for field,value in (("png","../bad.png"),("valid_time_utc","2026-11-24T23:40:39Z"),
                            ("source_url","https://example.com/"+FRAME["source_key"])):
            d=copy.deepcopy(MANIFEST)
            d["frames"][0][field]=value
            with self.assertRaises(ValueError):
                h.check_radar(d,REV,NOW)

    def test_no_empty_or_incomplete_image_as_backup(self):
        h.nonblank_wms_png(png(12,11,255),[12,11])
        for bad in [png(12,11,0),png(12,11,0)[:-15],b"<ServiceException>Error</ServiceException>"]:
            with self.assertRaises((ValueError,struct.error)):
                h.nonblank_wms_png(bad,[12,11])

    def test_selects_named_past_archive_and_correct_provider(self):
        def fetch(url,limit):
            if "uscomp/" in url:
                return b'<a href="n0q_202611242350.png">future</a><a href="n0q_202611242345.png">actual</a>'
            self.assertIn("2026-11-24T23%3A45%3A00Z",url)
            return png(2100,1180,255)
        d=h.collect_iem(NOW,fetch)
        self.assertEqual((d["valid_time"],d["provider"],d["label"]),("2026-11-24T23:45:00Z","Iowa Environmental Mesonet (IEM)","NEXRAD base reflectivity"))
        self.assertEqual(d["projection"],"EPSG:3857")
        self.assertIn("n0q_202611242345.png",d["source_data_url"])

    def test_fallback_policy(self):
        current={"status":"current","provider":"NOAA MRMS via Hydro"}
        with patch.object(h,"collect_mrms",return_value=current),patch.object(h,"collect_iem") as alt:
            self.assertIs(h.collect_radar(NOW,None),current)
            alt.assert_not_called()
        with patch.object(h,"collect_mrms",return_value={"status":"stale"}),patch.object(h,"collect_iem",return_value={"status":"current"}):
            self.assertEqual(h.collect_radar(NOW,None)["primary"]["status"],"stale")


class Discussions(unittest.TestCase):
    def test_idle_history_link_never_active(self):
        self.assertEqual(h.public_index(QUIET),(True,set()))
        self.assertEqual(h.public_index(ACTIVE),(False,{(2026,1592)}))
        with self.assertRaises(ValueError):
            h.public_index("<html>Service unavailable</html>")

    def test_active_validity_shape_and_separate_issue(self):
        feature=h.bulletin(TEXT,NOW)[2]
        self.assertEqual(feature["properties"]["valid_start"],"2026-11-24T20:00:00Z")
        self.assertEqual(feature["properties"]["valid_end"],"2026-11-25T02:00:00Z")
        self.assertEqual(feature["geometry"]["coordinates"][0][0],[-120,34.2])
        self.assertEqual(feature["geometry"]["coordinates"][0][-1],[-120,34.2])
        self.assertIn("yr=2026",feature["properties"]["source_url"])
        self.assertIsNone(h.bulletin(TEXT,h.from_iso("2026-11-25T02:00:00Z"))[2])

    def test_resends_and_midnight_month_rollover(self):
        renewed=TEXT.replace("250200Z","250400Z")
        self.assertEqual(h.bulletin(TEXT+"\n"+renewed,NOW)[2]["properties"]["valid_end"],"2026-11-25T04:00:00Z")
        revised=TEXT.replace("Nov 24","Dec 31").replace("242000Z - 250200Z","312000Z - 010200Z")
        result=h.bulletin(revised,h.from_iso("2027-01-01T01:00:00Z"))
        self.assertEqual(result[0],(2026,1592))
        self.assertEqual(result[2]["properties"]["valid_end"],"2027-01-01T02:00:00Z")

    def test_ugc_and_multiline_receiving_offices_keep_distinct_meanings(self):
        annotated=TEXT.replace("FFGMPD\n","FFGMPD\nCAZ000-AZZ000-NVZ000-250200-\n").replace(
            "LAT...LON","ATTN...WFO...LOX...SGX...\n   PSR...VEF...SGX...\n\nATTN...RFC...RSA...NWC...\nLAT...LON")
        props=h.bulletin(annotated,NOW)[2]["properties"]
        self.assertEqual(props["wfos"],["LOX","SGX","PSR","VEF"])
        self.assertEqual(props["states"],["CA","AZ","NV"])
        self.assertIn("UGC",props["states_source"])
        missing=h.bulletin(TEXT,NOW)[2]["properties"]
        self.assertEqual((missing["states"],missing["wfos"]),([],[]))
        # An older edition's header cannot leak into a corrected rendition.
        self.assertEqual(h.bulletin(annotated+"\n"+TEXT,NOW)[2]["properties"]["states"],[])

    def test_claim_geometry_missing_remains_partial(self):
        broken=dict(DATA,productText=TEXT.split("LAT...LON")[0])
        result=h.collect_mpds(NOW,routes(QUIET,INDEX,broken))
        self.assertEqual(result["status"],"partial")
        self.assertIsNone(result["count"])

    def test_disagreement_found_active_in_api(self):
        result=h.collect_mpds(NOW,routes(QUIET,INDEX,DATA))
        self.assertEqual(result["count"],1)
        self.assertEqual(len(result["features"]),1)

    def test_double_source_duplicate_counts_once(self):
        data=h.collect_mpds(NOW,routes(ACTIVE,INDEX,DATA))
        self.assertEqual(data["count"],1)

    def test_explicit_none_corroborated_by_expired_bulletin(self):
        later=h.from_iso("2026-11-26T21:05:00Z")
        result=h.collect_mpds(later,routes(QUIET,INDEX,DATA))
        self.assertEqual(result["status"],"current")
        self.assertEqual(result["count"],0)

    def test_outage_not_zero(self):
        for page,nws,status in ((None,None,"unavailable"),(QUIET,None,"partial"),(None,{"@graph":[]},"partial")):
            data=h.collect_mpds(NOW,routes(page,nws,None))
            self.assertEqual(data["status"],status)
            self.assertIsNone(data["count"])


if __name__=="__main__":
    unittest.main()
