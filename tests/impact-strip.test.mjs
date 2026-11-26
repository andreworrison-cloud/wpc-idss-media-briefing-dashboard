import test from 'node:test';
import assert from 'node:assert/strict';
import {impactStripData} from '../assets/impact-strip.js';
import {selectedExposure, selectExposureFocus} from '../assets/impacts.js';

const now=Date.parse('2026-11-26T15:42Z');
const at=minutes=>new Date(now+minutes*60000).toISOString();
const watch={recordId:'watch',bandId:null,label:'Winter Storm Watch',population:1200,
  states:[{code:'IL',population:320},{code:'MO',population:880}],asOf:at(-5),freshUntil:at(20),validEnd:at(50)};
const fixture=()=>({impacts:{
  exposure:{status:'current',calculated_at:at(-1),groups:{
    ero:[{id:'ero-d1',label:'Day 1 excessive rainfall',population:2000,bands:[{id:'slight',label:'Slight',population:210}]}],
    winter_alerts:[{id:'watch',label:'Winter Storm Watch',population:1200}]}},
  power:{status:'current',as_of:at(-10),stale_after:at(20),customers_out:1000,states_status:'current',states_as_of:at(-10),
    states:[{state:'VA',customers_out:100},{state:'MO',customers_out:170}],reporting_utilities:300,customers_tracked:20000},
  aviation:{status:'ok',as_of:at(-2),event_count:3,events:[
    {airport:'SEA',kind:'ground_delay',delay:'Avg 45 min, max 70 min',end_utc:at(10)},
    {airport:'SEA',kind:'deicing',end_utc:at(30)},{airport:'SLC',kind:'deicing',end_utc:at(-1)}
  ]},
  ground:{rivers:{status:'partial',asOf:at(-4),total:null,availableCount:155,
    counts:{minor:null,moderate:null,major:null},availableCounts:{minor:57,moderate:48,major:50},
    sites:Array.from({length:100},()=>({category:'minor'}))}}
}});
const data=(b,choice=watch,clock=now)=>Object.fromEntries(impactStripData(b,choice,clock).map(x=>[x.key,x]));

test('Census chart follows the selected hazard, supports zero and refuses an expired footprint',()=>{
  const b=fixture(), exposure=data(b).exposure;
  assert.equal(exposure.n,1200);
  assert.equal(exposure.context,'Winter Storm Watch');
  assert.deepEqual(exposure.chart.rows.map(x=>x.label),['MO','IL']);
  const none=data(b,null).exposure;
  assert.equal(none.n,null); assert.equal(none.status,'unavailable');
  assert.equal(data(b,{...watch,population:0,states:[]}).exposure.n,0);
  const old=data(b,{...watch,validEnd:at(-1)}).exposure;
  assert.equal(old.n,null);assert.equal(old.status,'stale');assert.equal(old.stamp,watch.asOf);
});

test('incomplete map geometry is disclosed alongside the selected full Census estimate',()=>{
  const {exposure}=data(fixture(),{...watch,geometryComplete:false});
  assert.equal(exposure.status,'partial');assert.equal(exposure.n,1200);assert.equal(exposure.minimum,false);
  assert.match(exposure.context,/Partial map coverage/);
});

test('outage state rankings require the same edition as the utility figure; zero requires reporting coverage',()=>{
  const b=fixture();
  assert.deepEqual(data(b).power.chart.rows.map(r=>r.value),[170,100]);
  b.impacts.power.states_as_of=at(-25);
  assert.equal(data(b).power.chart,null);assert.equal(data(b).power.n,1000);
  b.impacts.power.customers_out=0;
  assert.equal(data(b).power.n,0);
  b.impacts.power.reporting_utilities=null;
  assert.equal(data(b).power.n,null);
  const late=data(fixture(),watch,now+21*60000).power;
  assert.equal(late.status,'stale');assert.equal(late.n,null);
});

test('FAA counts distinct airports, limits categories to active notices, and retains the published duration wording',()=>{
  const air=data(fixture()).aviation;
  assert.equal(air.n,1);assert.match(air.context,/2 active notices/);
  assert.deepEqual(air.chart.rows.map(r=>r.value),[1,1]);assert.match(air.caption,/SEA.*Avg 45 min, max 70 min/);
  const b=fixture();
  Object.assign(b.impacts.aviation,{events:[],event_count:0});
  assert.equal(data(b).aviation.n,0);
  Object.assign(b.impacts.aviation,{status:'partial',event_count:null});
  assert.equal(data(b).aviation.n,null);
  b.impacts.aviation.events=[null,{airport:'LGA',kind:'arrival_delay'}];
  assert.equal(data(b).aviation.n,1);assert.equal(data(b).aviation.minimum,true);
});

test('NWPS partial national totals use the published complete set of qualifying records rather than the 100 visible sites',()=>{
  const b=fixture();
  const partial=data(b).ground;
  assert.equal(partial.n,155);assert.equal(partial.minimum,true);assert.equal(partial.status,'partial');
  assert.deepEqual(partial.chart.rows.map(r=>r.value),[57,48,50]);
  Object.assign(b.impacts.ground.rivers,{status:'ok',total:155,counts:{minor:57,moderate:48,major:50}});
  assert.equal(data(b).ground.n,155);assert.equal(data(b).ground.minimum,false);
  Object.assign(b.impacts.ground.rivers,{total:0,counts:{minor:0,moderate:0,major:0},sites:[]});
  assert.equal(data(b).ground.n,0);
  Object.assign(b.impacts.ground.rivers,{status:'partial',total:null,availableCount:0});
  assert.equal(data(b).ground.n,null);
});

test('late editions suppress figures and preserve the actual provider timestamps',()=>{
  const stale=data(fixture(),watch,now+3*3600000);
  for (const value of Object.values(stale)) {
    assert.equal(value.n,null);
    assert.equal(value.status,'stale');
    assert.ok(Number.isFinite(Date.parse(value.stamp)));
  }
  for (const value of Object.values(data(null,null))) assert.equal(value.status,'unavailable');
});

test('a KPI drilldown resolves only its selected footprint and exact band, including missing live Census coverage',()=>{
  const b=fixture();
  assert.equal(selectExposureFocus(b,{recordId:'ero-d1',bandId:'slight',label:'Day 1 Slight Risk'},now),true);
  assert.equal(selectedExposure(b,now).band.population,210);
  assert.equal(selectExposureFocus(b,watch,now),true);
  assert.equal(selectedExposure(b,now).record.id,'watch');
  assert.equal(selectedExposure(b,now).band,null);
  assert.equal(selectedExposure(b,now).state,'');
  assert.equal(selectExposureFocus(b,{recordId:null,label:'New Flash Flood Warning'},now),false);
  assert.equal(selectedExposure(b,now).record,null);
  assert.equal(selectExposureFocus(b,{recordId:'ero-d1',bandId:'absent',label:'Day 1 Moderate Risk'},now),false);
  assert.equal(selectedExposure(b,now).record,null);
  assert.equal(selectExposureFocus(b,{recordId:'watch',label:'Newly issued watch',population:null},now),false);
  assert.equal(selectedExposure(b,now).record,null);
});
