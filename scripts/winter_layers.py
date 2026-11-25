"""Public NOAA winter map layers. Reads public NOAA/NWS products and versioned zone boundaries."""
from __future__ import annotations
import base64
import concurrent.futures as cf
import json
import math
import re
import struct
import zlib
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

UTC = timezone.utc
NOAA = 'https://mapservices.weather.noaa.gov'
WSSI = NOAA + '/vector/rest/services/outlooks/wpc_wssi/MapServer'
PWPF = NOAA + '/vector/rest/services/precip/wpc_prob_winter_precip/MapServer'
OBS = NOAA + '/raster/rest/services/snow/NOHRSC_Snow_Analysis/MapServer'
WSSI_PUBLIC = 'https://www.wpc.ncep.noaa.gov/wwd/wssi/wssi.php'
PWPF_PUBLIC = 'https://www.wpc.ncep.noaa.gov/wwd/winter_wx.shtml'
OBS_PUBLIC = 'https://www.nohrsc.noaa.gov/nsa/'
CAP = 'https://api.weather.gov/alerts/active'
UA = {'User-Agent':'WPC-IDSS-research/0.4 (public NOAA winter mapping)', 'Accept':'application/geo+json, application/json, image/png, */*'}
IMPACTS = {
    'WINTER WEATHER AREA': ('Winter Weather Area','#D2DFE7'), 'MINOR':('Minor','#FAF5A3'),
    'MODERATE':('Moderate','#F7962F'), 'MAJOR':('Major','#E61F26'), 'EXTREME':('Extreme','#7853A1'),
}
PROBS = {1:('At least 10%','#0000FF'),2:('At least 40%','#008B00'),3:('At least 70%','#FF0000')}
PROBNAMES = {0:'Less than 10 percent',1:'Slight (10-39%)',2:'Moderate (40-69%)',3:'High (70-100%)'}
# NWS priority drawing order, source https://www.weather.gov/help-map .
ALERT_COLORS = {'Blizzard Warning':'#FF4500','Snow Squall Warning':'#C71585','Ice Storm Warning':'#8B008B',
                'Winter Storm Warning':'#FF69B4','Lake Effect Snow Warning':'#008B8B','Winter Weather Advisory':'#7B68EE','Winter Storm Watch':'#4682B4'}
SNOW_SCALE = [
    ('0–0.39','transparent'),('0.39–2.0','#ABC1BF'),('2.0–3.9','#66C1C4'),('3.9–9.8','#63A9CB'),
    ('9.8–20','#5079C8'),('20–39','#3C3FC2'),('39–59','#5720C3'),('59–98','#7D01BB'),('98–197','#B404B1'),
    ('197–295','#A91377'),('295–394','#992B50'),('394–787','#8B4545')]
SWE_SCALE = [
    ('0–0.04','transparent'),('0.04–0.20','#80A5C0'),('0.20–0.39','#5F7EB5'),('0.39–0.98','#4448AB'),
    ('0.98–2.00','#462CA7'),('2.00–3.90','#501490'),('3.90–5.90','#8722A4'),('5.90–9.80','#9B3394'),
    ('9.80–20','#BD589A'),('20–30','#BD7290'),('30–39','#C38E96'),('39–79','#B39E99')]
ISOS = re.compile(r'^https://api\.weather\.gov/zones/(forecast|public|county)/([A-Z]{2}[CZ]\d{3})$')
WSSI_FIELDS = 'objectid,product,component,impact,issue_time,start_time,end_time'
PWPF_FIELDS = 'objectid,product,outlook,dn,issue_time,start_time,end_time'
HOSTS = {'api.weather.gov','mapservices.weather.noaa.gov'}
DISPLAY_NOTICE = 'Display geometry is generalized. Use the full-resolution source for exposure calculations.'


def stamp(d):
    return d.astimezone(UTC).isoformat(timespec='seconds').replace('+00:00','Z')


def moment(s):
    if isinstance(s, datetime):
        if s.tzinfo is None:
            raise ValueError('Timezone required.')
        return s.astimezone(UTC)
    if isinstance(s,(float,int)):
        return datetime.fromtimestamp(s/1000, UTC)
    if not isinstance(s,str):
        raise ValueError('Missing source time.')
    for fmt in ('%Y-%m-%d %H%MZ','%HZ %m/%d/%y','%HZ %m/%d/%Y','%Y-%m-%d %H:%M:%S'):
        try:
            return datetime.strptime(s,fmt).replace(tzinfo=UTC)
        except ValueError:
            pass
    return moment(datetime.fromisoformat(s.replace('Z','+00:00')))


def _get(url):
    if urlparse(url).hostname not in HOSTS:
        raise ValueError('Unexpected source hostname.')
    with urlopen(Request(url,headers=UA),timeout=24) as response:
        raw=response.read(16_000_001)
    if len(raw)>16_000_000:
        raise ValueError('Resource exceeds the data budget.')
    return raw


def doc(url,fetch):
    data=json.loads(fetch(url))
    if not isinstance(data,dict) or data.get('error') or data.get('exceededTransferLimit') or (data.get('properties') or {}).get('exceededTransferLimit'):
        raise ValueError('Incomplete NOAA GIS response.')
    return data


def query(base,layer,**kw):
    return f'{base}/{layer}/query?'+urlencode(kw)


def legend(values):
    return [{'label':s,'color':c} for s,c in values]


def layer_base(id,title,source,palette,kind='geojson'):
    return {'id':id,'title':title,'family':'Winter','kind':kind,'status':'unavailable','issued':None,'valid_start':None,'valid_end':None,
            'source_url':source,'legend':legend(palette),'features':[],'issues':[]}


def interval(a,now,is_wssi,day):
    try:
        issued,start,end=(moment(a[k]) for k in ('issue_time','start_time','end_time'))
    except (ValueError,KeyError,TypeError):
        raise ValueError('Unverified NOAA issuance or valid window.')
    expected=(72 if is_wssi and day==4 else 24)
    if issued>now+timedelta(minutes=2) or start>=end or end-start!=timedelta(hours=expected) or start>now+timedelta(days=4):
        raise ValueError('Invalid NOAA forecast interval.')
    stale=now>=end or now-issued>timedelta(hours=6 if is_wssi else 18)
    return {'issued':stamp(issued),'valid_start':stamp(start),'valid_end':stamp(end)},stale


def _xy(pt):
    if not isinstance(pt,(list,tuple)) or len(pt)<2:
        raise ValueError('Invalid geometry coordinate.')
    x,y=pt[:2]
    if not all(isinstance(z,(int,float)) and math.isfinite(z) for z in (x,y)) or not(-180<=x<=180 and -90<=y<=90):
        raise ValueError('Invalid geometry coordinate.')
    return [x,y]


def geometry(g,display=False):
    if not isinstance(g,dict) or g.get('type') not in ('Polygon','MultiPolygon'):
        raise ValueError('Missing source polygon.')
    polygons=[g['coordinates']] if g['type']=='Polygon' else g['coordinates']
    if not isinstance(polygons,list) or not polygons:
        raise ValueError('Empty source polygon.')
    out=[]; collapsed=0
    for poly in polygons:
        if not poly: raise ValueError('Empty source polygon.')
        new=[]
        for i,ring in enumerate(poly):
            coords=[_xy(p) for p in ring]
            if not coords or coords[0]!=coords[-1]: raise ValueError('Unclosed source polygon.')
            if len(set(map(tuple,coords)))<3:
                if not display:raise ValueError('Degenerate source polygon.')
                collapsed+=1
                if i==0:break
                continue
            new.append(coords)
        if new: out.append(new)
    if not out: raise ValueError('No drawable geometry at this scale.')
    return ({'type':'Polygon','coordinates':out[0]} if len(out)==1 else {'type':'MultiPolygon','coordinates':out}),collapsed


def categorical(layer,now,fetch):
    key,index,day,threshold=layer
    wssi=threshold=='wssi'; ice=threshold=='ice'
    base=WSSI if wssi else PWPF
    source=WSSI_PUBLIC if wssi else PWPF_PUBLIC
    prefix='WSSI overall impacts' if wssi else 'Probability of 0.25 in ice' if ice else f'Probability of {threshold} in snow'
    title=prefix+' · '+('Days 1–3' if day==4 else f'Day {day}')
    colors=IMPACTS if wssi else PROBS
    out=layer_base(key,title,source,colors.values())
    out.update(scope='Contiguous U.S.',style='fill' if wssi else 'outline',period=('Days 1–3' if day==4 else f'Day {day}'),display_notice=DISPLAY_NOTICE,
               product=('Winter Storm Severity Index' if wssi else 'WPC 24-hour probabilistic winter precipitation'))
    if not wssi:
        out.update(threshold=0.25 if ice else int(threshold),threshold_unit='in',variable='ice accumulation' if ice else 'snowfall')
    try:
        fields=WSSI_FIELDS if wssi else PWPF_FIELDS
        params=dict(where='1=1',outFields=fields,returnGeometry='true',outSR='4326',f='geojson',geometryPrecision='4',maxAllowableOffset='0.015')
        data=doc(query(base,index,**params),fetch)
        if data.get('type')!='FeatureCollection' or not isinstance(data.get('features'),list) or not data['features']:
            raise ValueError('No edition metadata in the selected NOAA layer.')
        records=data['features'];attrs=[f.get('properties') or {} for f in records]
        dates={(p.get('issue_time'),p.get('start_time'),p.get('end_time'))for p in attrs}
        objectids=[a.get('objectid') for a in attrs]
        if len(dates)!=1 or any(not isinstance(x,int) for x in objectids) or len(set(objectids))!=len(objectids):
            raise ValueError('Mixed or duplicate product edition.')
        times,stale=interval(attrs[0],now,wssi,day);out.update(times,retrieved_at=stamp(now))
        out['fresh_until']=stamp(min(moment(times['valid_end']),moment(times['issued'])+timedelta(hours=6 if wssi else 18)))
        if stale:out.update(status='stale',issues=['This NOAA forecast has aged beyond the product window.']);return out
        for a in attrs:
            if wssi and (a.get('component')!='WSSI_OVERALL' or a.get('product')!='WINTER STORM SEVERITY INDEX'):
                raise ValueError('Unexpected WSSI component.')
            if not wssi:
                expected=f'Day {day} probability of '+('ice greater than .25 inches' if ice else f'snow greater than {threshold} inches')
                if a.get('product')!=expected: raise ValueError('Unexpected PWPF threshold.')
        cond=' AND '.join(f"{k} = '{attrs[0][k]}'" for k in ('issue_time','start_time','end_time'))
        if not wssi:cond+=' AND dn > 0'
        out['native_query_url']=query(base,index,where=cond,outFields=fields,returnGeometry='true',outSR=4326,f='geojson')
        out['source_gis_url']=f'{base}/{index}'; features=[];collapsed=0; ids=[]
        for obj,a in zip(records,attrs):
            k=a.get('impact') if wssi else a.get('dn')
            if not wssi and PROBNAMES.get(k)!=a.get('outlook'): raise ValueError('Unrecognized WPC probability contour.')
            if not wssi and k==0:continue
            if k not in colors: raise ValueError('Unrecognized WPC category.')
            label,color=colors[k];rank=list(colors).index(k)
            geom,lost=geometry(obj.get('geometry'),display=True);collapsed+=lost;ids.append(a['objectid'])
            fc_id=f"{key}:{out['issued']}:{a['objectid']}"
            features.append({'type':'Feature','id':fc_id,'geometry':geom,'properties':{'id':fc_id,'objectid':a['objectid'],
                'label':label,'impact':label if wssi else None,'probability_min_pct':None if wssi else {1:10,2:40,3:70}[k],
                'color':color,'rank':rank,'family':'Winter','hazard':title,'source_url':source,**times}})
        features.sort(key=lambda f:f['properties']['rank'])
        out.update(status='ok' if features else 'none',features=features,expected_objectids=sorted(ids),
            levels=list(dict.fromkeys(f['properties']['label'] for f in features)),collapsed_display_rings=collapsed)
        if not features:out['note']='WPC identifies probabilities below its lowest mapped contour (10%) for this edition.'
    except (ValueError,KeyError,IndexError,TypeError,OSError) as exc:out['issues']=[str(exc)[:180]]
    return out


def _rdp(points,eps):
    if len(points)<=4:return points
    # Two open paths around the most distant vertex avoid a coincident ring-end baseline.
    split=max(range(1,len(points)-1),key=lambda i:(points[i][0]-points[0][0])**2+(points[i][1]-points[0][1])**2)
    def curve(seq):
        kept={0,len(seq)-1};stack=[(0,len(seq)-1)]
        while stack:
            lo,hi=stack.pop()
            if hi<=lo+1:continue
            ax,ay=seq[lo];bx,by=seq[hi];dx,dy=bx-ax,by-ay;den=dx*dx+dy*dy
            best,dist=0,eps*eps
            for idx in range(lo+1,hi):
                x,y=seq[idx]; t=max(0,min(1,((x-ax)*dx+(y-ay)*dy)/den)) if den else 0
                d=(x-ax-t*dx)**2+(y-ay-t*dy)**2
                if d>dist:best,dist=idx,d
            if best:kept.add(best);stack.extend(((lo,best),(best,hi)))
        return [seq[i] for i in sorted(kept)]
    picked=curve(points[:split+1])[:-1]+curve(points[split:])
    return picked if len(picked)>=4 else points


def display_zone(g):
    source,_=geometry(g)
    polys=[source['coordinates']] if source['type']=='Polygon' else source['coordinates']
    out=[]
    for poly in polys:
        rings=[]
        for ring in poly:
            selected=_rdp(ring,0.005)
            rounded=[[round(x,4),round(y,4)] for x,y in selected]
            rings.append(rounded if len(set(map(tuple,rounded)))>=3 else selected)
        out.append(rings)
    return {'type':'Polygon','coordinates':out[0]} if len(out)==1 else {'type':'MultiPolygon','coordinates':out}


def _alert_event(f,now):
    p=f['properties']
    if p['status']!='Actual' or p['messageType'] in ('Cancel','Ack','Error'):return None
    if p['messageType'] not in ('Alert','Update') or p['event'] not in ALERT_COLORS:raise ValueError('Unrecognized winter CAP product.')
    sent=moment(p['sent']); eff=moment(p['effective']); stop=moment(p['expires']); end=moment(p['ends']) if p.get('ends') else stop
    if sent>now or eff>now or now>=min(stop,end):return None
    uid=p['id'];url=f['id']
    if not re.fullmatch(r'urn:oid:[A-Za-z0-9.:-]+',uid) or url!='https://api.weather.gov/alerts/'+uid:raise ValueError('Unverified CAP identifier.')
    ugc=sorted(set(p['geocode']['UGC']))
    if not ugc or any(not re.fullmatch(r'[A-Z]{2}[CZ]\d{3}',z) for z in ugc):raise ValueError('Unverified CAP geography.')
    urls=sorted(set(u for u in p.get('affectedZones',[]) if ISOS.fullmatch(u) and ISOS.fullmatch(u)[2] in ugc))
    native=geometry(f['geometry'])[0] if f.get('geometry') else None
    office=next(iter((p.get('parameters') or {}).get('WMOidentifier',[])),'').split()
    references={r['identifier'] for r in p.get('references',[]) if isinstance(r,dict) and isinstance(r.get('identifier'),str)}
    references.update(triple.split(',')[1] for group in (p.get('parameters') or {}).get('expiredReferences',[]) if isinstance(group,str) for triple in group.split() if len(triple.split(','))==3)
    return {'id':uid,'event_id':uid,'_references':list(references),'event':p['event'],'title':p['event'],'area':str(p.get('areaDesc') or '')[:800],
            'severity':str(p.get('severity') or ''),'office':office[1] if len(office)>1 else '',
            'ugc':ugc,'states':sorted({z[:2] for z in ugc}),'zone_urls':urls,'geometry':native,
            'geometry_status':'source polygon' if native else 'zone validation pending','issued':stamp(sent),'effective':stamp(eff),
            'onset':stamp(moment(p['onset'])) if p.get('onset') else None,'valid_start':stamp(eff),'valid_end':stamp(min(stop,end)),
            'expires':stamp(stop),'ends':stamp(end),'source_url':url,'color':ALERT_COLORS[p['event']]}


def _zone(url,at,fetch):
    if not ISOS.fullmatch(url):raise ValueError('Invalid NWS source zone URL.')
    q=url+'?'+urlencode({'effective':stamp(at)})
    f=doc(q,fetch);a=f.get('properties') or {};m=ISOS.fullmatch(url)
    if f.get('type')!='Feature' or f.get('id')!=url or a.get('id')!=m[2] or a.get('type') not in ('public','county','fire','coastal','offshore','land','marine'):
        raise ValueError('NWS returned a different forecast zone.')
    start=moment(a['effectiveDate']);end=moment(a['expirationDate'])
    if not(start<=at<end):raise ValueError('The zone vintage does not cover the snapshot.')
    return {'url':url,'native_url':q,'ugc':a['id'],'name':str(a.get('name') or '')[:160],'valid_from':stamp(start),'valid_until':stamp(end),
            'geometry':display_zone(f.get('geometry'))}


def winter_alerts(now,fetch):
    out=layer_base('winter_alerts','NWS winter warnings, watches and advisories','https://www.weather.gov/',ALERT_COLORS.items())
    out.update(scope='National including Alaska, Hawaii and U.S. territories',product='NWS active CAP messages',style='fill',events=[],feature_count=0,
        event_count=None,display_notice=DISPLAY_NOTICE)
    try:
        u=CAP+'?'+urlencode({'status':'actual','event':','.join(ALERT_COLORS)})
        pages=set();items={};change=None
        while u:
            parsed=urlparse(u)
            if parsed.hostname!='api.weather.gov' or parsed.path!='/alerts/active' or u in pages:raise ValueError('Invalid winter alert pagination.')
            pages.add(u);d=doc(u,fetch)
            if d.get('type')!='FeatureCollection' or not isinstance(d.get('features'),list):raise ValueError('Unverified winter alert coverage.')
            change_=moment(d['updated'])
            if change_>now+timedelta(minutes=2) or (change and change!=change_):raise ValueError('Inconsistent winter CAP collection timestamp.')
            change=change_
            for f in d['features']:
                ev=_alert_event(f,now)
                if ev:
                    if ev['id'] in items and items[ev['id']]!=ev:raise ValueError('Conflicting CAP records.')
                    items[ev['id']]=ev
            nx=(d.get('pagination') or {}).get('next');u=nx
        superseded={ref for e in items.values() for ref in e.pop('_references',[])}
        items={uid:e for uid,e in items.items() if uid not in superseded}
        out.update(source_gis_url=CAP,source_time=stamp(change),issued=stamp(change),valid_start=stamp(now),retrieved_at=stamp(now),fresh_until=stamp(now+timedelta(minutes=30)),
                   valid_end=stamp(max(moment(e['valid_end']) for e in items.values())) if items else None,event_count=len(items))
        if not items:out.update(status='none',note='No active winter warning, watch or advisory CAP records at collection.');return out
        # A single snapshot-time zone resolution is shared by overlapping watch/advisory messages.
        urls=sorted({u for e in items.values() if not e['geometry'] and e['event']!='Snow Squall Warning' for u in e['zone_urls']})
        zones={}
        with cf.ThreadPoolExecutor(max_workers=8) as pool:
            jobs={pool.submit(_zone,u,now,fetch):u for u in urls}
            for job,u in jobs.items():
                try:zones[u]=job.result()
                except (OSError,KeyError,IndexError,TypeError,ValueError):pass
        partial=False
        for e in items.values():
            common={k:e[k] for k in ('event_id','event','issued','effective','onset','valid_start','valid_end','color','source_url','area','office')}
            common.update(family='Winter',label=e['event'],hazard=e['event'])
            missing=set(e['ugc']);used=[]
            if e['geometry']:
                geom=display_zone(e['geometry']);missing.clear()
                used=[{'type':'Feature','id':e['id'],'geometry':geom,'properties':{**common,'geometry_basis':'NWS storm polygon','ugc':e['ugc']}}]
            elif e['event']!='Snow Squall Warning':
                for u in e['zone_urls']:
                    z=zones.get(u)
                    if not z:continue
                    missing.discard(z['ugc'])
                    used.append({'type':'Feature','id':e['id']+'/'+z['ugc'],'geometry':z['geometry'],'properties':{
                        **common,'geometry_basis':'NWS forecast zone','zone_url':z['url'],'native_zone_url':z['native_url'],'zone_valid_from':z['valid_from'],
                        'zone_valid_until':z['valid_until'],'ugc':z['ugc'],'name':z['name']}})
            out['features'].extend(used);e['missing_geometry_ugc']=sorted(missing)
            if not e['geometry']:
                e['geometry_status']='zone geometry unavailable' if not used else 'partial verified zones' if missing else 'verified NWS zones'
            partial|=bool(missing)
        out.update(events=list(items.values()),feature_count=len(out['features']),zone_count=len(zones),
                   status='partial' if partial else 'ok',levels=list(dict.fromkeys(e['event'] for e in items.values())))
        if partial:out['issues']=['Some active alert areas lack a verified current boundary.']
    except (IndexError,KeyError,TypeError,ValueError,OSError) as exc:out['issues']=[str(exc)[:180]]
    return out

def _obs_meta(foot,fetch):
    d=doc(query(OBS,foot,where='1=1',returnGeometry='false',outFields='objectid,name,idp_validtime,idp_issueddate,idp_filedate',f='json'),fetch)
    rec=d.get('features')
    if not isinstance(rec,list) or len(rec)!=1:raise ValueError('A unique active NOAA snowpack raster edition was not found.')
    a=rec[0]['attributes']
    return (moment(a['idp_validtime']),moment(a['idp_issueddate']),a['objectid'],a['idp_filedate'],a['name'])


def _png(raw):
    if len(raw)>1_200_000 or raw[:8]!=b'\x89PNG\r\n\x1a\n' or raw[12:16]!=b'IHDR' or struct.unpack('>II',raw[16:24])!=(1200,675):
        raise ValueError('Unexpected NOAA raster dimensions or image encoding.')
    offset=8;saw_z=False
    while offset<len(raw):
        length=struct.unpack('>I',raw[offset:offset+4])[0];k=raw[offset+4:offset+8]; payload=raw[offset+8:offset+8+length]
        if len(payload)!=length or zlib.crc32(k+payload)!=int.from_bytes(raw[offset+8+length:offset+12+length],'big'):raise ValueError('Truncated NOAA raster.')
        offset+=12+length
        if k==b'IDAT' and length:saw_z=True
        if k==b'IEND':
            if offset!=len(raw) or not saw_z:raise ValueError('Incomplete NOAA raster.')
            return
    raise ValueError('Incomplete NOAA raster.')


def snowpack(id,now,fetch):
    depth=id=='snow_depth'; idx=3 if depth else 7
    scale=SNOW_SCALE if depth else SWE_SCALE
    out=layer_base(id,'Analyzed snow depth' if depth else 'Analyzed snow water equivalent',OBS_PUBLIC,[(s+' in',c) for s,c in scale],'raster')
    out.update(product='NOHRSC National Snow Analyses',scope='Contiguous U.S.',projection='EPSG:3857',
               note='Snowpack analysis with assimilated observations. Shading shows inches of '+('snow on the ground.' if depth else 'water stored in the snowpack.'))
    try:
        a=_obs_meta(idx-1,fetch);analysis,issued,oid,filetime,name=a
        if analysis>now or issued>now:raise ValueError('Future NOAA analysis edition.')
        out.update(issued=stamp(issued),valid_start=stamp(analysis),analysis_time=stamp(analysis),
                   expires_at=stamp(analysis+timedelta(hours=36)),fresh_until=stamp(analysis+timedelta(hours=36)),retrieved_at=stamp(now),source_gis_url=f'{OBS}/{idx}',raster_objectid=oid,source_file_time=stamp(moment(filetime)))
        if now-analysis>timedelta(hours=36):
            out.update(status='stale',issues=['The published snowpack analysis is more than 36 hours old.']);return out
        # Use an aspect-correct Web Mercator extent. ArcGIS expands a mismatched
        # bounding box for its requested image size; precompute the exact rectangle.
        radius=6378137.;xmin=radius*math.radians(-125);xmax=radius*math.radians(-66)
        ymin=radius*math.log(math.tan(math.pi/4+math.radians(24)/2));ymax=ymin+(xmax-xmin)*675/1200
        north=math.degrees(2*math.atan(math.exp(ymax/radius))-math.pi/2)
        args={'f':'image','bbox':','.join(f'{v:.6f}'for v in (xmin,ymin,xmax,ymax)),'bboxSR':3857,'imageSR':3857,
              'size':'1200,675','format':'png32','transparent':'true','layers':f'show:{idx}'}
        raw=fetch(OBS+'/export?'+urlencode(args));_png(raw)
        if _obs_meta(idx-1,fetch)!=a:raise ValueError('NOAA snowpack edition changed while the raster was being read.')
        out.update(status='ok',image_url='data:image/png;base64,'+base64.b64encode(raw).decode(),bounds=[[24.,-125.],[round(north,7),-66.]],
                   source_filename=name)
    except (KeyError,TypeError,ValueError,IndexError,OSError,struct.error) as exc:out['issues']=[str(exc)[:180]]
    return out


def collect(now=None,fetch=_get):
    """Read public layers independently. Keyword fetch accepts an injectable URL → bytes reader."""
    at=moment(now) if now is not None else datetime.now(UTC)
    choices=[(f'wssi_{s}',i,i,'wssi') for i,s in ((1,'d1'),(2,'d2'),(3,'d3'),(4,'d1_3'))]
    choices.extend((('ice025' if v=='ice' else 'snow'+v)+f'_d{day}',(day-1)*5+offset,day,v)
        for day in (1,2,3) for offset,v in enumerate(('4','8','12','ice'),1))
    with cf.ThreadPoolExecutor(max_workers=6) as pool:
        jobs=[pool.submit(winter_alerts,at,fetch)]+[pool.submit(categorical,c,at,fetch) for c in choices]
        jobs.extend(pool.submit(snowpack,i,at,fetch) for i in ('snow_depth','snow_swe'))
        layers=[j.result() for j in jobs]
    valid=sum(l['status'] in ('ok','none') for l in layers)
    return {'status':'ok' if valid==len(layers) else 'partial' if valid or any(l['status']=='partial' for l in layers) else 'unavailable',
        'retrieved_at':stamp(at),'layers':layers,'issues':[] if valid==len(layers) else ['See the individual product status and edition.']}


if __name__=='__main__':
    import argparse
    from pathlib import Path
    ap=argparse.ArgumentParser();ap.add_argument('output',type=Path);args=ap.parse_args()
    d=collect();d['collected_at']=stamp(datetime.now(UTC));args.output.write_text(json.dumps(d,allow_nan=False,separators=(',',':')))
    for l in d['layers']:print(l['id'],l['status'],l['issued'],len(l['features']),l['issues'])
