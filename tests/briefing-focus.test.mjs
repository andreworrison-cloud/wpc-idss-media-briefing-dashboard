import assert from 'node:assert/strict';
import test from 'node:test';
import {briefingFocus} from '../assets/briefing-focus.js';

const now=Date.parse('2026-11-25T00:11Z');
const at=minutes=>new Date(now+minutes*60000).toISOString();
const square=(w,s,e,n)=>[[w,s],[e,s],[e,n],[w,n],[w,s]];
const area=(...rings)=>({type:'Polygon',coordinates:rings});
const geographic=(geometry,properties={})=>({type:'Feature',geometry,properties});
const issue='urn:nws:watch';
const dateFields={valid_start:at(-12),valid_end:at(100),fresh_until:at(30),as_of:at(-1)};
const record={id:'winter-zone-winter-storm-watch',label:'Winter Storm Watch',family:'Winter',status:'current',alert_ids:[issue],
  source_url:'https://www.weather.gov/',population:125,states:[{code:'MO',population:125}],...dateFields};
const geometry=area(square(-95,37,-89,42),square(-93,38,-92,39));
function winterEvent(id=issue){
  return {id,title:'Winter Storm Watch',event:'Winter Storm Watch',geometry:null,ugc:['MOZ001'],states:['MO'],
    effective:at(-20),valid_end:at(100),source_url:'https://api.weather.gov/alerts/'+id};
}
const attributes={event_id:issue,event:'Winter Storm Watch',ugc:'MOZ001',effective:at(-20),valid_end:at(100)};
function board() {
  return {sources:{alerts:{status:'ok',retrieved_at:at(-1),events:[]}},
    impacts:{exposure:{calculated_at:at(-1),groups:{winter_alerts:[structuredClone(record)]}}},
    weather:{winter:{layers:[{id:'winter_alerts',status:'ok',fresh_until:at(30),source_url:'https://www.weather.gov/',
      event_count:1,events:[winterEvent()],features:[geographic(geometry,attributes)]}]},
    observations:{status:'ok',asOf:at(-1),features:[],leaders:{},unlocated:[],
      sources:{lsr:{status:'ok'},pns:{status:'ok'}},counts:{}}}};
}
function report(id,value,longitude=-94,latitude=40,fields={}) {
  return {id,sourceType:'LSR',measurementType:'snowfall',category:'snow',label:'Snowfall',
    observedAt:at(-120),issuedAt:at(-100),value,unit:'in',qualifier:'Measured',trace:false,
    place:'Town '+id,state:'MO',office:'EAX',url:'https://mesonet.agron.iastate.edu/'+id,longitude,latitude,...fields};
}

test('matches full forecast-zone membership and separates national and local measurement leaders',()=>{
  const b=board();
  b.weather.observations.features=[
    report('local',2),report('outside',12,-86,42),report('hole',22,-92.5,38.5),
    report('edge',3,-95,38.5),report('hole-edge',4,-92,38.5),
    report('rain',1.21,-94,40,{measurementType:'rainfall',category:'rain',sourceType:'PNS'}),
    report('wind',53,-94,40,{measurementType:'windGust',category:'wind',unit:'mph'}),
    report('snowDepth',145,-94,40,{measurementType:'snowDepth'}),
    report('estimated',41,-94,40,{qualifier:'Estimated'}),report('old',50,-94,40,{observedAt:at(-2900)}),
    report('future',52,-94,40,{observedAt:at(30)}),report('wrong unit',400,-94,40,{unit:'cm'}),
    report('no source',60,-94,40,{url:'javascript:bad'})];
  const v=briefingFocus(b,'',now);
  assert.equal(v.status,'ready');
  assert.equal(v.selected.recordId,record.id);
  assert.equal(v.selected.bandId,null);
  assert.deepEqual(v.selected.states,record.states);
  assert.equal(v.selected.population,125);
  assert.equal(v.selected.color,'#4682B4');
  assert.equal(v.evidence.status,'ok');
  assert.equal(v.evidence.localCount,5);
  assert.deepEqual(v.evidence.local.map(r=>r.id),['hole-edge','wind','rain']);
  assert.deepEqual(v.evidence.national.map(r=>r.id),['hole','wind','rain']);
});

test('joins active Day 1 ERO edition and exact category exposure, and labels forthcoming Day 2',()=>{
  const b=board();
  const day=(n,rank,name)=>({day:n,status:'current',issued:at(-100),retrieved_at:at(-1),
    valid_start:at(n===1?-240:100),valid_end:at(n===1?100:1020),fresh_until:at(60),source_url:'https://www.wpc.ncep.noaa.gov/',
    features:[geographic(geometry,{rank:1,risk:'Marginal'}),geographic(geometry,{rank,risk:name})]});
  const one=day(1,3,'Moderate'),two=day(2,2,'Slight');
  b.sources.ero={days:[one,two]};
  b.impacts.exposure.groups.ero=[one,two].map((d,i)=>({id:'ero-d'+d.day,label:'Day '+d.day+' excessive rainfall',day:d.day,family:'Flood',
    status:'current',population:1500000,as_of:at(-1),issued:d.issued,valid_start:d.valid_start,valid_end:d.valid_end,fresh_until:d.fresh_until,
    source_url:d.source_url,bands:[{id:i?'slight':'moderate',label:i?'Slight':'Moderate',rank:i?2:3,population:233,states:[{code:'MO',population:233}]}]}));
  const result=briefingFocus(b,'',now);
  assert.equal(result.selected.id,'ero-d1-moderate');
  assert.equal(result.selected.bandId,'moderate');
  assert.equal(result.selected.features.length,1);
  assert.equal(result.selected.population,233);
  const upcoming=briefingFocus(b,'ero-d2-slight',now).selected;
  assert.equal(upcoming.phase,'upcoming');
  assert.equal(upcoming.day,2);
  b.impacts.exposure.groups.ero[0].issued=at(-120);
  assert.ok(!briefingFocus(b,'',now).choices.some(c=>c.id==='ero-d1-moderate'));
});

test('an active MPD outranks a watch, links only to its own issuance and expires with its polygon',()=>{
  const b=board();
  const mpd={id:'mpd-0071',family:'Flood',label:'WPC MPD 0071',population:33,states:[{code:'MO',population:33}],
    status:'current',source_url:'https://www.wpc.ncep.noaa.gov/',...dateFields};
  b.impacts.exposure.groups.mpd=[mpd];
  b.weather.mpd={status:'current',fresh_until:at(20),features:[geographic(geometry,{
    number:'0071',valid_start:mpd.valid_start,valid_end:mpd.valid_end,source_url:'https://www.wpc.ncep.noaa.gov/metwatch/md0071.html'})]};
  assert.equal(briefingFocus(b,'',now).selected.id,'mpd-0071');
  b.weather.mpd.features[0].properties.valid_end=at(-1);
  assert.ok(!briefingFocus(b,'',now).choices.some(c=>c.kind==='mpd'));
  assert.equal(briefingFocus(b,'mpd-0071',now).selected.id,record.id);
});

test('the all-category WSSI estimate joins the matching WPC issuance and polygon inventory',()=>{
  const b=board();
  const aggregate={...record,id:'wssi-all-d1-3',map_product:'wssi_d1_3',issued:at(-100),label:'All WSSI categories',population:321};
  b.impacts.exposure.groups.winter=[aggregate];
  const layer={id:'wssi_d1_3',status:'ok',source_url:'https://www.wpc.ncep.noaa.gov/',issued:aggregate.issued,
    ...dateFields,expected_objectids:[1,2],features:[geographic(geometry,{objectid:1,impact:'Winter Weather Area'}),geographic(geometry,{objectid:2,impact:'Minor'})]};
  b.weather.winter.layers.push(layer);
  let r=briefingFocus(b,aggregate.id,now);
  assert.equal(r.selected.kind,'wssi');assert.equal(r.selected.population,321);
  assert.equal(r.selected.bandId,null);assert.equal(r.selected.geometryComplete,true);
  layer.features.pop();r=briefingFocus(b,aggregate.id,now);
  assert.equal(r.selected.geometryComplete,false);assert.equal(r.evidence.localCount,null);
  layer.issued=at(-110);
  assert.ok(!briefingFocus(b,aggregate.id,now).choices.some(c=>c.kind==='wssi'));
});

test('urgent matched warning leads and a warning with no published outline cannot relabel a state',()=>{
  const b=board();
  const make=(title,id,geos)=>({id,title,family:'Flood',ffe:title==='Flash Flood Warning',source_url:'https://api.weather.gov/alerts/'+id,
    effective:at(-30),expires:at(110),geometry:geos,geometry_status:'source polygon',states:['MO']});
  b.sources.alerts.events=[make('Flash Flood Warning','ffw',[geometry]),make('Coastal Flood Warning','coastal',[])];
  b.impacts.exposure.groups.alerts=b.sources.alerts.events.map(e=>({...record,id:'alert-'+e.id,label:e.title,family:'Flood',alert_ids:[e.id]}));
  const result=briefingFocus(b,'',now);
  assert.equal(result.selected.id,'alert-ffw');
  assert.equal(result.selected.label,'Flash Flood Warning');
  assert.equal(result.selected.color,'#8B0000');
  assert.ok(!result.choices.some(c=>c.id==='alert-coastal'));
  assert.equal(briefingFocus(b,record.id,now).selected.id,record.id);
});

test('flags incomplete zone geometry, unlocated or truncated measurements, and retired reports',()=>{
  const b=board(), l=b.weather.winter.layers[0], obs=b.weather.observations;
  l.events[0].ugc.push('MOZ002');
  obs.features=[report('known',4)];
  let e=briefingFocus(b,'',now).evidence;
  assert.equal(e.status,'partial');assert.equal(e.localCount,null);assert.equal(e.availableLocalCount,1);
  assert.match(e.note,/boundaries/);
  l.events[0].ugc.pop();
  obs.unlocated=[report('unknown',7,null,null)];
  e=briefingFocus(b,'',now).evidence;
  assert.equal(e.localCount,null);
  assert.match(e.note,/could not be placed/);
  obs.unlocated=[];obs.counts={availableLocated:28,located:1};
  assert.equal(briefingFocus(b,'',now).evidence.localCount,null);
  obs.asOf=at(-90);e=briefingFocus(b,'',now).evidence;
  assert.equal(e.status,'unavailable');assert.deepEqual(e.national,[]);assert.equal(e.localCount,null);
});

test('a multipolygon spanning the antimeridian keeps Pacific islands distinct from Greenwich',()=>{
  const b=board();
  b.weather.winter.layers[0].features[0]=geographic({type:'MultiPolygon',coordinates:[
    [square(179,40,-179,44)],[square(-163,40,-162,44)]]},attributes);
  b.weather.observations.features=[report('east',3,179.5,42),report('west',4,-179.5,42),
    report('island',6,-162.5,42),report('far',18,0,42)];
  const e=briefingFocus(b,'',now).evidence;
  assert.equal(e.localCount,3);assert.equal(e.local[0].id,'island');assert.equal(e.national[0].id,'far');
});

test('distinguishes verified absence from expired or missing inputs',()=>{
  const b=board();
  assert.equal(briefingFocus(undefined,'',now).status,'unavailable');
  assert.equal(briefingFocus(b,'',now+72*3600000).status,'unavailable');
  b.weather.winter.layers=[{id:'winter_alerts',status:'none',fresh_until:at(20),event_count:0,features:[],events:[]},
    {id:'wssi_d1_3',status:'none',fresh_until:at(20),features:[]}];
  b.weather.mpd={status:'current',fresh_until:at(15),count:0,explicit_no_mpd:true,features:[]};
  b.sources.ero={days:[{day:1,status:'current',retrieved_at:at(-1),fresh_until:at(30),valid_end:at(50),no_risk_area:true,features:[]}]};
  assert.equal(briefingFocus(b,'',now).status,'none');
  delete b.weather.mpd.explicit_no_mpd;
  assert.equal(briefingFocus(b,'',now).status,'unavailable');
});
