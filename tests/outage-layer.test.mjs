import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {OUTAGE_LEGEND,outageBand,ctVintage,geometry,sectionStatus} from '../assets/outage-layer.js';

const here=new URL('../assets/',import.meta.url);
const load=n=>JSON.parse(fs.readFileSync(new URL('outage-geo-'+n+'.json',here),'utf8'));
const states=load('states'), chunks=['west','central','south','southeast','northeast','islands'].map(load);
function find(code) {
  for(const f of [states,...chunks]){
    const r=f.features.find(row=>row[0]===code);
    if(r)return {f,r};
  }
}
function inRing(r,h,w) {
  let hit=false;
  for(let i=0,j=r.length-1;i<r.length;j=i++){
    const [y,x]=r[i],[yy,xx]=r[j];
    if(((y>h)!==(yy>h))&&(w<(xx-x)*(h-y)/(yy-y)+x))hit=!hit;
  }
  return hit;
}
function inside(code,h,w) {
  const {f,r}=find(code);
  return geometry(f,r).some(poly=>inRing(poly[0],h,w)&&!poly.slice(1).some(hole=>inRing(hole,h,w)));
}
test('count bins and zero are separate from unknown',()=>{
  assert.equal(new Set(OUTAGE_LEGEND.map(d=>d.color)).size,8);
  assert.deepEqual([null,0,1,9,10,99,100,999,1000,10000,100000].map(v=>outageBand(v).id),
    ['missing','zero','ones','ones','tens','tens','hundreds','hundreds','thousands','large','largest']);
  for(const v of [false,NaN,-1,'0',1.5])assert.equal(outageBand(v).id,'missing');
});
test('expires actual section timestamp independently from national and local retrieval time',()=>{
  const now=Date.parse('2026-11-24T23:54:00Z');
  const data={status:'current',states_status:'current',counties_status:'current',states_as_of:'2026-11-24T23:25:00Z',counties_as_of:'2026-11-24T23:20:00Z',checked_at:'2026-11-24T23:53:00Z'};
  assert.equal(sectionStatus(data,'state',now).status,'current');
  assert.equal(sectionStatus(data,'county',now).status,'stale');
  assert.equal(sectionStatus({...data,states_as_of:null},'state',now).status,'unavailable');
  assert.equal(sectionStatus({...data,states_as_of:'2026-11-25T02:00:00Z'},'state',now).status,'unavailable');
  assert.equal(sectionStatus({...data,status:'stale'},'state',now).status,'stale');
});
test('Census atlas includes all reporting vintages and genuine US island locations',()=>{
  assert.equal(states.features.length,56);
  const records=chunks.flatMap(f=>f.features);
  assert.equal(records.length,3243);
  assert.equal(new Set(records.map(r=>r[0])).size,3243);
  assert.equal(records.filter(r=>r[1]==='CT').length,17);
  assert.equal(ctVintage([{fips:'09001'}]),'legacy');
  assert.equal(ctVintage([{fips:'09110'}]),'planning');
  assert.equal(ctVintage([{fips:'09001'},{fips:'09190'}]),'mixed');
  assert.ok(inside('24510',39.284,-76.612));assert.equal(inside('24005',39.284,-76.612),false);
  for(const [code,h,w] of [['36061',40.7484,-73.9855],['15003',21.3069,-157.8583],['02020',61.215,-149.896],
    ['02016',52.85,-186.83],['72127',18.431,-66.062],['11001',38.8977,-77.0365],['09001',41.184,-73.196],
    ['66010',13.445,144.7937],['78030',18.344,-64.92],['69110',15.1979,145.7509],['60010',-14.286,-170.677]]){
    assert.ok(inside(code,h,w),code);
  }
});
test('all rings close and contain no long seam along the date line',()=>{
  let rings=0;
  for(const f of [states,...chunks])for(const r of f.features)for(const p of geometry(f,r))for(const ring of p){
    assert.ok(ring.length>=4,r[0]);assert.deepEqual(ring.at(-1),ring[0],r[0]);
    for(let k=1;k<ring.length;k++)assert.ok(Math.abs(ring[k][1]-ring[k-1][1])<180,r[0]);
    rings++;
  }
  assert.equal(rings,[states,...chunks].flatMap(f=>f.features).reduce((sum,r)=>sum+r[4].reduce((n,p)=>n+p.length,0),0));
  assert.ok(rings>3243);
});
