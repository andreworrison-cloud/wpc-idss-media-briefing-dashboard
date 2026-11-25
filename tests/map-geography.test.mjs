import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import test from 'node:test';
const root=existsSync(new URL('./geographic-base.js',import.meta.url))?new URL('./',import.meta.url):new URL('../assets/',import.meta.url);
const {geometryNear,MAP_REGIONS}=await import(new URL('geographic-base.js',root));
const {reportPoint}=await import(new URL('map-points.js',root));

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
});
