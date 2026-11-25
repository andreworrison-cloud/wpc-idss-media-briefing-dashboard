import json
import struct
import unittest
import zlib
from datetime import datetime,timezone
from unittest.mock import patch
from urllib.parse import urlparse,parse_qs
import winter_layers as w

NOW=datetime(2026,11,24,23,45,tzinfo=timezone.utc)
TRI={'type':'Polygon','coordinates':[[[-89.1,38],[-89.1,39],[-88.5,38.5],[-89.1,38]]]}
def b(d):return json.dumps(d).encode()
def f(k='MINOR',oid=1,threshold=None):
    a={'objectid':oid,'product':'WINTER STORM SEVERITY INDEX','component':'WSSI_OVERALL','impact':k,
       'issue_time':'2026-11-24 2316Z','start_time':'18Z 11/24/26','end_time':'18Z 11/25/26'}
    if threshold is not None:a={'objectid':oid,'product':'Day 1 probability of ice greater than .25 inches',
        'dn':threshold,'outlook':w.PROBNAMES[threshold],'issue_time':'2026-11-24 21:56:15','start_time':'2026-11-25 00:00:00','end_time':'2026-11-26 00:00:00'}
    return {'type':'Feature','geometry':TRI,'properties':a}
def feats(rows,**kwargs):return {'type':'FeatureCollection','features':rows,**kwargs}
def prefer(rows,choice=('wssi_d1',1,1,'wssi'),now=NOW,**kw):return w.categorical(choice,now,lambda url:b(feats(rows,**kw)))
def cap(uid='abc',zone='ILZ047',event='Winter Storm Watch',expiry='2026-11-25T09:00:00Z',geom=None):
    uid='urn:oid:2.49.'+uid
    return {'type':'Feature','id':'https://api.weather.gov/alerts/'+uid,'geometry':geom,'properties':{'id':uid,'status':'Actual',
        'messageType':'Alert','event':event,'sent':'2026-11-24T22:00:00Z','effective':'2026-11-24T22:00:00Z','onset':'2026-11-25T05:00:00Z',
        'ends':'2026-11-26T00:00:00Z','expires':expiry,'areaDesc':'Selected zone','severity':'Moderate','geocode':{'UGC':[zone]},
        'affectedZones':['https://api.weather.gov/zones/forecast/'+zone]}}
def zone(url,code='ILZ047',vintage='2026-04-16T18:00:00Z'):
    return {'type':'Feature','id':url.split('?')[0],'geometry':TRI,'properties':{'id':code,'effectiveDate':vintage,
        'expirationDate':'2200-01-01T00:00:00Z','type':'public','name':'Selected zone'}}
def alerts(rows,z=None,pagination=None):
    def get(u):
        if '/alerts/active' in u:return b(feats(rows,updated='2026-11-24T23:20:00Z',**({'pagination':pagination} if pagination else {})))
        if z is False:raise OSError('Zone temporarily unavailable')
        return b(z(u) if callable(z) else zone(u))
    return w.winter_alerts(NOW,get)
def png():
    def chunk(name,payload):
        return struct.pack('>I',len(payload))+name+payload+struct.pack('>I',zlib.crc32(name+payload))
    # A proper 1200 x 675 gray raster with valid filtered scanlines.
    header=struct.pack('>IIBBBBB',1200,675,8,0,0,0,0)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',header)+chunk(b'IDAT',zlib.compress(bytes(1201*675)))+chunk(b'IEND',b'')
def obs(now=NOW,flip=False,body=None):
    t=NOW.replace(hour=12,minute=0)
    d=round(t.timestamp()*1000);hits=[0]
    def get(url):
        if '/export?' in url:return png() if body is None else body
        hits[0]+=1
        return b({'features':[{'attributes':{'idp_validtime':d,'idp_issueddate':d,'idp_filedate':d+(1 if flip and hits[0]>1 else 0),'objectid':1,'name':'test.grib2'}}]})
    return w.snowpack('snow_depth',now,get)
class WinterChecks(unittest.TestCase):
 def test_all_wssi_levels_have_correct_official_colors_and_mapped_geometry(self):
    r=prefer([f(c,i+1) for i,c in enumerate(w.IMPACTS)]);self.assertEqual(r['status'],'ok')
    self.assertEqual(r['levels'],['Winter Weather Area','Minor','Moderate','Major','Extreme'])
    self.assertEqual([q['properties']['color'] for q in r['features']],['#D2DFE7','#FAF5A3','#F7962F','#E61F26','#7853A1'])
    self.assertEqual(r['issued'],'2026-11-24T23:16:00Z');self.assertEqual(r['features'][0]['geometry'],TRI)
 def test_full_native_query_is_locked_to_all_timestamps_and_unsimplified(self):
    r=prefer([f()]);q=parse_qs(urlparse(r['native_query_url']).query)
    self.assertIn('issue_time',q['where'][0]);self.assertIn('start_time',q['where'][0]);self.assertIn('end_time',q['where'][0])
    self.assertNotIn('maxAllowableOffset',q);self.assertEqual(q['outSR'],['4326']);self.assertEqual(r['expected_objectids'],[1])
 def test_only_explicit_subthreshold_edition_proves_no_contour(self):
    opt=('ice025_d1',4,1,'ice');self.assertEqual(prefer([f(threshold=0)],opt)['status'],'none')
    self.assertEqual(prefer([],opt)['status'],'unavailable')
    self.assertEqual(prefer([f(threshold=1)],opt)['features'][0]['properties']['probability_min_pct'],10)
 def test_inconsistent_product_and_category_or_bad_geometry_rejected(self):
    x=f();x['properties']['component']='SNOW_LOAD';self.assertEqual(prefer([x])['status'],'unavailable')
    x=f();x['geometry']=None;self.assertEqual(prefer([x])['status'],'unavailable')
    x=f();x['properties']['impact']='SOMETHING ELSE';self.assertEqual(prefer([x])['status'],'unavailable')
    x=f(threshold=1);x['properties']['outlook']='Moderate (40-69%)';self.assertEqual(prefer([x],('ice025_d1',4,1,'ice'))['status'],'unavailable')
 def test_mixed_duplicate_or_truncated_layers_withhold_data(self):
    x=f('MAJOR',2);x['properties']['issue_time']='2026-11-24 2115Z'
    for r in [prefer([f(),x]),prefer([f(),f()]),prefer([f()],exceededTransferLimit=True),prefer([f()],properties={'exceededTransferLimit':True})]:
        self.assertEqual(r['status'],'unavailable');self.assertFalse(r['features'])
 def test_age_future_and_bad_time_window(self):
    r=prefer([f()],now=NOW.replace(day=25,hour=7));self.assertEqual(r['status'],'stale');self.assertFalse(r['features'])
    r=prefer([f()],now=NOW.replace(hour=17));self.assertEqual(r['status'],'unavailable')
    x=f();x['properties']['end_time']='18Z 11/26/26';self.assertEqual(prefer([x])['status'],'unavailable')
 def test_wssi_next_day_and_composite_have_their_own_bounds(self):
    x=f();x['properties'].update(start_time='18Z 11/25/26',end_time='18Z 11/26/26')
    self.assertEqual(prefer([x],('wssi_d2',2,2,'wssi'))['status'],'ok')
    x['properties'].update(start_time='18Z 11/24/26',end_time='18Z 11/27/26');r=prefer([x],('wssi_d1_3',4,4,'wssi'))
    self.assertEqual(r['valid_end'],'2026-11-27T18:00:00Z')
 def test_active_operations_include_watches_before_hazard_onset(self):
    e=cap();r=alerts([e]);self.assertEqual(r['status'],'ok');self.assertEqual(r['events'][0]['geometry'],None)
    f0=r['features'][0]['properties'];self.assertEqual(f0['event_id'],e['properties']['id']);self.assertEqual(f0['color'],'#4682B4')
    self.assertEqual(f0['zone_valid_from'],'2026-04-16T18:00:00Z');self.assertEqual(f0['ugc'],'ILZ047');self.assertEqual(f0['valid_end'],'2026-11-25T09:00:00Z')
 def test_missing_zone_preserves_cap_count_without_false_map(self):
    r=alerts([cap()],False);self.assertEqual(r['status'],'partial');self.assertEqual(r['event_count'],1)
    self.assertFalse(r['features']);self.assertEqual(r['events'][0]['missing_geometry_ugc'],['ILZ047'])
 def test_wrong_zone_or_boundary_vintage_never_drawn(self):
    for z in [lambda u:zone(u,'MOZ111'),lambda u:zone(u,vintage='2027-01-01T00:00:00Z')]:
        self.assertEqual(alerts([cap()],z)['features'],[])
 def test_zone_reuse_and_event_identity_across_overlapping_watch_advisory(self):
    seen=[]
    def fetchzone(u):seen.append(u);return zone(u)
    r=alerts([cap('a'),cap('b',event='Winter Weather Advisory')],fetchzone)
    self.assertEqual(r['event_count'],2);self.assertEqual(r['zone_count'],1);self.assertEqual(len(seen),1);self.assertEqual(r['feature_count'],2)
    self.assertEqual({f['properties']['color'] for f in r['features']},{'#7B68EE','#4682B4'})
 def test_no_count_for_unavailable_feed_and_verified_zero_for_expired_alerts(self):
    r=alerts([cap(expiry='2026-11-24T23:45:00Z')]);self.assertEqual([r['event_count'],r['status']],[0,'none'])
    r=w.winter_alerts(NOW,lambda u:b({'error':'offline'}));self.assertIsNone(r['event_count']);self.assertEqual(r['status'],'unavailable')
 def test_snow_squall_missing_polygon_never_uses_whole_zone(self):
    r=alerts([cap(event='Snow Squall Warning')]);self.assertEqual(r['status'],'partial');self.assertFalse(r['features'])
    r=alerts([cap(event='Snow Squall Warning',geom=TRI)]);self.assertEqual(r['status'],'ok');self.assertEqual(r['events'][0]['geometry'],TRI)
 def test_new_cap_identifier_supersedes_referenced_winter_message(self):
    old=cap('aaa');new=cap('bbb')
    new['properties']['references']=[{'identifier':old['properties']['id']}]
    new['properties']['messageType']='Update';new['properties']['sent']='2026-11-24T23:10:00Z'
    r=alerts([old,new]);self.assertEqual(r['event_count'],1);self.assertEqual(r['events'][0]['id'],new['properties']['id'])
 def test_foreign_or_circular_next_link_fails_closed(self):
    r=alerts([cap()],pagination={'next':'https://example.org/alerts/active'});self.assertEqual(r['status'],'unavailable')
 def test_observed_raster_pinned_by_edition_and_has_mercator_bounds(self):
    r=obs();self.assertEqual(r['status'],'ok');self.assertEqual(r['analysis_time'],'2026-11-24T12:00:00Z')
    self.assertEqual(r['projection'],'EPSG:3857');self.assertEqual(r['bounds'][0],[24.0,-125.0]);self.assertTrue(r['image_url'].startswith('data:image/png;base64,'))
 def test_changed_or_damaged_snow_analysis_not_deemed_verified(self):
    self.assertEqual(obs(flip=True)['status'],'unavailable');self.assertEqual(obs(body=b'<html>') ['status'],'unavailable')
    self.assertEqual(obs(now=NOW.replace(day=26,hour=12))['status'],'stale')
 def test_invalid_and_date_naive_strings_never_become_utc_by_accident(self):
    for text in ['2026-11-31 2316Z', '2026-11-24T23:46:11', 'bad']:
        with self.assertRaises(ValueError):w.moment(text)
if __name__=='__main__':unittest.main()
