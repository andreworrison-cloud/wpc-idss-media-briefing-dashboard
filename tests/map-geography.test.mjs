import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import test from 'node:test';
const root=existsSync(new URL('./geographic-base.js',import.meta.url))?new URL('./',import.meta.url):new URL('../assets/',import.meta.url);
const {geometryNear,MAP_REGIONS,BASEMAP_CHOICES}=await import(new URL('geographic-base.js',root));
const {reportPoint,pointCounts,pointCountLabel,pointKey,observationsOnMap}=await import(new URL('map-points.js',root));
const {matchingPoints,newestFirst}=await import(new URL('point-browser.js',root));

test('an Aleutian polygon and interior ring remain local across the date line',()=>{
  const input={type:'Polygon',coordinates:[
    [[179,51],[-178,51],[-178,53],[179,53],[179,51]],
    [[179.5,51.5],[-179.5,51.5],[-179.5,52.5],[179.5,52.5],[179.5,51.5]]
  ]};
  const projected=geometryNear(input,-157);
  assert.equal(Math.min(...projected.coordinates[0].map(p=>p[0])),-181);
  assert.equal(Math.max(...projected.coordinates[0].map(p=>p[0])),-178);
  assert.equal(projected.coordinates[1][0][0],-180.5);
  assert.deepEqual(projected.coordinates[0][0],projected.coordinates[0].at(-1));
  assert.equal(input.coordinates[0][0][0],179);
});

test('state and territory views preserve physical locations and all domestic state shapes',()=>{
  const data=JSON.parse(readFileSync(new URL('geo-reference.json',root)));
  assert.equal(data.states.length,56);assert.equal(new Set(data.states.map(s=>s[0])).size,56);
  for(const [region,lon] of [['AK',-159],['HI',-157],['PR',-66],['GU',145],['AS',-170]]){
    const {bounds}=MAP_REGIONS[region];
    assert.ok(lon>bounds[0][1]&&lon<bounds[1][1]);
  }
});

test('reports retain explicit zero and UTC measurement time in the first hover lines',()=>{
  const row={id:'test',sourceType:'PNS',category:'rain',phenomenon:'Rainfall',value:0,unit:'in',place:'Example',state:'TX',
    office:'FWD',observedAt:'2026-11-24T10:15:00Z',issuedAt:'2026-11-24T11:10:00Z',durationHours:24,
    latitude:32.7,longitude:-97.3,measurementType:'rainfall',url:'https://www.weather.gov/'};
  const point=reportPoint(row);assert.equal(point.value,'0 in');assert.match(point.lines.slice(0,3).join(' '),/10:15 UTC/);
  assert.match(point.lines.slice(0,3).join(' '),/Public Information Statement · FWD/);
  assert.ok(point.lines.includes('24 h accumulation'));assert.equal(reportPoint({...row,latitude:null}),null);
  assert.equal(reportPoint({...row,trace:true,value:null}).value,'Trace');
  assert.equal(reportPoint({...row,url:null,source_url:row.url}).url,null);
});

test('a cluster opens every source entry once even when a later record supplies its map symbol',()=>{
  const doc={createElement:()=>({dataset:{},style:{setProperty(){}},setAttribute(){},append(){},addEventListener(){}})};
  let marker;
  const L={latLng:(lat,lng)=>({lat,lng}),divIcon:icon=>icon,marker:()=>{
    const handlers={};const el=doc.createElement();
    marker={addTo(){return this;},bindTooltip(){},getElement:()=>el,closeTooltip(){},
      on(event,handler){handlers[event]=handler;},fire:event=>handlers[event]()};
    return marker;
  }};
  const map={getBounds:()=>({pad:()=>({contains:()=>true})}),getZoom:()=>6,getSize:()=>({x:800}),
    getCenter:()=>({lng:-77}),latLngToContainerPoint:()=>({x:1,y:1,distanceTo:()=>0})};
  const base={lat:35,lon:-77,lines:[],place:'Example',title:'Observation'};
  const rows=[{...base,source:'LSR',id:'1',record:{eligibleForBrief:false}},
    {...base,source:'PNS',id:'1',record:{eligibleForBrief:true}},{...base,source:'NWPS',id:'3'}];
  let opened;
  observationsOnMap(L,map,null,rows,{doc,onInspect:(records,representative)=>{opened={records,representative};}});
  marker.fire('click');
  assert.equal(opened.representative,rows[1]);
  assert.deepEqual(opened.records,rows);
  assert.equal(new Set(opened.records.map(pointKey)).size,3);
  assert.equal(marker.getElement().dataset.pointCount,'3');
  assert.deepEqual([...pointCounts(rows)].map(([s,n])=>pointCountLabel(s,n)),['1 local storm report','1 PNS observation','1 river gauge']);
  assert.equal(pointCountLabel('NWPS',4),'4 river gauges');
});

test('group search combines source, location, station, county, impact and hazard while preserving UTC order',()=>{
  const base={id:'g1',place:'Stumpy Point, NC',source:'NWPS',stationId:'STUN7',measure:'major flooding',observedAt:'2026-11-26T18:00:00Z'};
  const reports=[{...base,id:'r1',source:'LSR',office:'MHX',county:'Dare',impacts:'road closure',issuedAt:'2026-11-26T18:35:00Z'},
    {...base,id:'r2',source:'LSR',office:'MHX',county:'Dare',impacts:'road closure',issuedAt:'2026-11-26T19:00:00Z'},
    base,{...base,id:'old',observedAt:null,issuedAt:'2026-11-26T17:30:00Z'}];
  assert.deepEqual(matchingPoints(newestFirst(reports),'LSR',' daRE  closure mhx ').map(p=>p.id),['r2','r1']);
  assert.deepEqual(matchingPoints(reports,'NWPS','stun7 point').map(p=>p.id),['g1','old']);
  assert.deepEqual(matchingPoints(reports,'PNS','Point'),[]);
  assert.equal(newestFirst(reports).at(-1).id,'old');
});

test('the briefing map accepts current native zones and mixed collections while excluding expired shapes',async()=>{
  const {briefingFeatures}=await import(new URL('command-map.js',root));
  const now=Date.parse('2026-11-25T00:10:00Z');
  const native={type:'Polygon',coordinates:[[[-90,38],[-89,38],[-89,39],[-90,38]]]};
  const current={type:'Feature',properties:{event:'Winter Storm Watch',valid_end:'2026-11-25T12:00:00Z'},geometry:native};
  const old={...current,properties:{...current.properties,valid_end:'2026-11-24T12:00:00Z'}};
  const collection={type:'FeatureCollection',features:[current,old,{type:'Feature',properties:{label:'Forecast area'},geometry:{type:'GeometryCollection',geometries:[native,{type:'Point',coordinates:[-90,38]}]}}]};
  const result=briefingFeatures({features:collection},now);
  assert.equal(result.length,2);
  assert.equal(result[0],current);
  assert.equal(result[1].properties.label,'Forecast area');
  assert.equal(result[1].geometry,native);
  assert.deepEqual(briefingFeatures({features:collection,fresh_until:'2026-11-25T00:08:00Z'},now),[]);
  assert.deepEqual(briefingFeatures({features:[current],valid_end:'2026-11-25T00:10:00Z'},now),[]);
});

test('published relief and city orientation data include the national and regional geography',()=>{
  const d=JSON.parse(readFileSync(new URL('geo-reference.json',root)));
  for(const name of ['Seattle','Denver','St. Louis','Juneau'])assert.ok(d.cities.some(c=>c[0]===name&&Number.isFinite(c[1])&&Number.isFinite(c[2])));
  assert.deepEqual(BASEMAP_CHOICES.map(x=>x.id),['dark','light','topo']);
  const dark=readFileSync(new URL('briefing-relief.webp',root));
  const light=readFileSync(new URL('briefing-light-relief.webp',root));
  for(const plate of [light,dark]){
    assert.equal(plate.toString('ascii',8,12),'WEBP');
    assert.ok(plate.length>30000);
  }
  assert.notDeepEqual(light,dark);
});

test('outage map labels expose each reading time, reporting status and geographic coverage',async()=>{
  const {outageMapReading}=await import(new URL('command-map.js',root));
  const base={level:'state',status:'current',as_of:'2026-11-26T13:30:00Z',geometry_status:'current'};
  assert.match(outageMapReading(base),/State readings.*13:30 UTC.*customer accounts/);
  assert.match(outageMapReading({...base,level:'county',status:'stale',geometry_status:'partial'}),/County outage readings have expired.*13:30 UTC.*Some geographic boundaries/);
  assert.match(outageMapReading({...base,as_of:null,status:'unavailable',geometry_status:'unavailable'}),/State outage readings are unavailable\. The geographic boundaries/);
});

test('NWS cartography requires an exact CAP id, hazard, issuance, expiry and active segment',async()=>{
  const {alertOutline,indexGISShapes,indexWinterShapes}=await import(new URL('active-alert-shapes.js',root));
  const now=Date.parse('2026-11-26T12:30:00Z');
  const a={id:'bulletin-1',title:'Winter Storm Warning',sent:'2026-11-26T12:00:00Z',effective:'2026-11-26T12:00:00Z',
    expires:'2026-11-26T18:00:00Z',ends:null,ugc:['TXZ001','TXZ002'],geometry:[]};
  const g={type:'Polygon',coordinates:[[[-100,30],[-99,30],[-99,31],[-100,30]]]};
  const p={cap_id:a.id,prod_type:a.title,issuance:'2026-11-26T07:00:00-05:00',expiration:a.expires,ends:' '};
  const feature=properties=>({type:'Feature',geometry:g,properties});
  const gis=indexGISShapes([feature(p),feature(p)]);
  assert.equal(alertOutline(a,null,gis,now).geometry[0].type,'MultiPolygon');
  assert.equal(alertOutline({...a,geometry:[g]},null,gis,now).geometry[0],g);
  for(const change of [{cap_id:'different'},{prod_type:'Watch'},{issuance:'2026-11-26T11:58:00Z'},
    {expiration:'2026-11-26T19:00:00Z'},{ends:'2026-11-26T14:00:00Z'}]){
    assert.equal(alertOutline(a,null,indexGISShapes([feature({...p,...change})]),now),null);
  }
  assert.equal(alertOutline({...a,geometry_status:'Active segment boundary unavailable'},null,gis,now),null);
  assert.equal(alertOutline(a,null,gis,Date.parse(a.expires)),null);
  const zone=code=>feature({event:a.title,event_id:a.id,issued:a.sent,valid_start:a.effective,valid_end:a.expires,ugc:code});
  const local=indexWinterShapes([zone('TXZ001'),zone('TXZ002'),zone('TXZ003')]);
  assert.equal(alertOutline(a,local,gis,now).basis,'NWS forecast zones');
  const partial=indexWinterShapes([zone('TXZ001'),zone('TXZ003')]);
  assert.equal(alertOutline(a,partial,null,now).partial,true);
  assert.match(alertOutline(a,partial,gis,now).basis,/GIS/);
});

test('a partial upstream GIS transfer cannot be described as a complete national edition',async()=>{
  const {loadAlertGIS}=await import(new URL('active-alert-shapes.js',root));
  const fetched=[];
  const broken=async url=>{
    fetched.push(new URL(url));
    return {ok:true,json:async()=>({type:'FeatureCollection',features:[],exceededTransferLimit:true})};
  };
  await assert.rejects(loadAlertGIS(broken),/complete NWS/);
  assert.equal(fetched.length,1);
  assert.equal(fetched[0].searchParams.get('outSR'),'4326');
  assert.match(fetched[0].searchParams.get('outFields'),/cap_id/);
});

test('the packaged radar image matches only its exact source time, content hash, upstream URL and Pages origin',async()=>{
  const {localRadarImage}=await import(new URL('command-map.js',root));
  const digest='b'.repeat(64),rootURL='https://example.github.io/idss/assets/',origin='https://example.github.io';
  const radar={valid_time:'2026-11-26T04:10:38Z',image_url:'https://raw.githubusercontent.com/example/latest.png',
    image_sha256:digest,local_image:'radar/20261126T041038Z-'+digest+'.png'};
  const frame={image_url:radar.image_url,valid_time:radar.valid_time};
  assert.equal(localRadarImage(radar,null,rootURL,origin),rootURL+radar.local_image);
  assert.equal(localRadarImage(radar,frame,rootURL,origin),rootURL+radar.local_image);
  for(const changed of [{...frame,valid_time:'2026-11-26T04:00:38Z'},{...frame,image_url:'https://example.com/other.png'}]){
    assert.equal(localRadarImage(radar,changed,rootURL,origin),null);
  }
  assert.equal(localRadarImage({...radar,local_image:'https://other.example/radar.png'},null,rootURL,origin),null);
  assert.equal(localRadarImage({...radar,image_sha256:'a'.repeat(64)},null,rootURL,origin),null);
  assert.equal(localRadarImage(radar,null,rootURL,'https://other.example'),null);
});
