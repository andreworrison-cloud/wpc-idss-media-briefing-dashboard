import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { currentRadar } from '../assets/browser-radar.js';

const start = Date.parse('2026-11-24T23:48:00Z');
const observation='2026-11-24T23:40:38Z', hash='b'.repeat(40);
const reference={ref:'refs/heads/mrms-rala-data',object:{type:'commit',sha:hash}};
const file='MRMS_ReflectivityAtLowestAltitude_00.50_20261124-234038.grib2.gz';
const manifest={
  metadata_mode:'mrms_rala_loop_manifest_v2',product:'ReflectivityAtLowestAltitude',region:'CONUS',units:'dBZ',
  target_frame_cadence_minutes:10,freshness_limit_minutes:20,latest_valid_time_utc:observation,generated_utc:'2026-11-24T23:43:00Z',
  frame_count:1,frames:[{valid_time_utc:observation,png:'frames/mrms_rala_20261124T234038Z.png',source_key:file,
    source_url:'https://mrms.ncep.noaa.gov/2D/ReflectivityAtLowestAltitude/'+file}],
  display:{projection:'EPSG:3857',resampling:'nearest-neighbor',smoothing:false,visible_minimum_dbz:5,
    leaflet_bounds:[[20,-130],[55,-60]],image_width_px:7000,image_height_px:4571,
    color_table:[{threshold_dbz:5,color:'#74c7ec'},{threshold_dbz:10,color:'#4aa8df'}]}
};
function chunk(kind, contents) {
  const length=Buffer.alloc(4);length.writeUInt32BE(contents.length);
  return Buffer.concat([length,Buffer.from(kind,'ascii'),contents,Buffer.alloc(4)]);
}
function pngHeader(w,h) {
  const ihdr=Buffer.alloc(13);
  ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr)]);
}
function smallMap(echo) {
  const width=360,height=202,rowData=Buffer.alloc((width*4+1)*height);
  if(echo) rowData[4]=255;
  return Buffer.concat([pngHeader(width,height),chunk('IDAT',deflateSync(rowData)),chunk('IEND',Buffer.alloc(0))]);
}
function fake({ m=manifest, ref=reference, hydroDown=false, iem=false, echo=true, hydroPng=pngHeader(7000,4571), slow=false }={}) {
  const calls=[];
  let nextFail=false;
  const fetcher=async (url,opts) => {
    calls.push([url,opts]);
    assert.equal(opts.credentials,'omit');assert.equal(opts.mode,'cors');
    if(slow) await new Promise(resolve=>setTimeout(resolve,5));
    if(url.includes('api.github')) return (hydroDown || nextFail) ? new Response('error',{status:503}) : Response.json(ref);
    if(url.includes('raw.githubusercontent')) {
      assert.ok(url.includes(hash));
      if(url.endsWith('json')) return Response.json(m);
      assert.equal(opts.headers.Range,'bytes=0-31');
      return new Response(hydroPng.subarray(0,32),{status:206});
    }
    if(url.includes('/archive/')) return iem && url.includes('202611242345') ? new Response(pngHeader(12200,5400),{status:206}) : new Response('404',{status:404});
    if(url.includes('n0q-t.cgi')) {
      const u=new URL(url);assert.equal(u.searchParams.get('time'),'2026-11-24T23:45:00Z');
      assert.equal(u.searchParams.get('width'),'360');
      return new Response(smallMap(echo));
    }
    throw new Error(url);
  };
  return {fetcher,calls,fail:()=>{nextFail=true;}};
}
test('fresh published radar is an exact no-op; cutoff and time are assessed independently of published status',async()=>{
  const f=fake();
  const ready={status:'current',image_url:'https://image',valid_time:observation,fresh_until:'2026-11-25T00:00:38Z'};
  assert.equal(await currentRadar({weather:{radar:ready}},{now:start,fetcher:f.fetcher}),ready);
  assert.equal(f.calls.length,0);
  const expired=await currentRadar(ready,{now:'2026-11-25T00:00:38Z',fetcher:f.fetcher});
  assert.equal(expired.status,'stale');assert.equal(expired.image_url,null);
});
test('recover Hydro by immutable SHA, source key, dimensions and timestamp without downloading the full PNG',async()=>{
  const f=fake();const radar=await currentRadar(null,{now:start,fetcher:f.fetcher});
  assert.equal(f.calls.length,3);assert.equal(radar.provider,'NOAA MRMS via Hydro');
  assert.ok(radar.image_url.includes(hash));assert.equal(radar.valid_time,observation);assert.equal(radar.fresh_until,'2026-11-25T00:00:38Z');
  assert.equal(radar.frames[0].image_url,radar.image_url);
});
test('IEM recovery verifies an exact archive filename and a nonempty small WMS sample before returning the full-size URL',async()=>{
  const f=fake({hydroDown:true,iem:true});
  const radar=await currentRadar({status:'unavailable',valid_time:null},{now:start,fetcher:f.fetcher});
  assert.equal(radar.status,'current');assert.equal(radar.provider,'Iowa Environmental Mesonet (IEM)');
  assert.equal(radar.valid_time,'2026-11-24T23:45:00Z');assert.equal(radar.fresh_until,'2026-11-25T00:05:00Z');
  assert.equal(new URL(radar.image_url).searchParams.get('width'),'2100');
  assert.ok(radar.source_data_url.endsWith('n0q_202611242345.png'));
});
test('missing, empty, future and malformed replies do not count as imagery',async()=>{
  for(const f of [
    fake({hydroDown:true,iem:true,echo:false}),fake({hydroDown:true}),
    fake({ref:{...reference,object:{...reference.object,sha:'../wrong'}}}),
    fake({m:{...manifest,latest_valid_time_utc:'2026-11-25T00:31:00Z'}}),
    fake({hydroPng:pngHeader(1,4)}),fake({m:{...manifest,frames:[{...manifest.frames[0],source_key:'different'}]}})
  ]) {
    const result=await currentRadar({radar:null,metadata:{privateField:'unused'}},{now:start,fetcher:f.fetcher});
    assert.deepEqual(result.frames,[]);assert.equal(result.status,'unavailable');assert.equal(result.image_url,null);
    assert.equal(result.metadata,undefined);
  }
});
test('concurrent calls share one request and retain an earlier verified frame only until its exact expiry',async()=>{
  const f=fake({slow:true});
  const [r1,r2]=await Promise.all([currentRadar(null,{now:start,fetcher:f.fetcher}),currentRadar(null,{now:start,fetcher:f.fetcher})]);
  assert.equal(r1,r2);assert.equal(f.calls.length,3);
  const again=await currentRadar({}, {now:start+60_000,fetcher:f.fetcher});
  assert.equal(again,r1);assert.equal(f.calls.length,3);
  f.fail();
  const failure=await currentRadar({}, {now:start+121_000,fetcher:f.fetcher});
  assert.equal(failure,r1);assert.equal(f.calls.length,4);
  const later=await currentRadar({}, {now:Date.parse(r1.fresh_until),fetcher:f.fetcher});
  assert.equal(later.image_url,null);
});
test('a bad source is throttled across calls with no contradictory current flag',async()=>{
  const f=fake({hydroDown:true});
  const published={status:'current',valid_time:'2026-11-24T01:00:00Z',fresh_until:'2026-11-30T01:00:00Z',image_url:'expired',frames:['expired']};
  const a=await currentRadar(published,{now:start,fetcher:f.fetcher});const count=f.calls.length;
  const b=await currentRadar(published,{now:start+61_000,fetcher:f.fetcher});
  assert.equal(a.status,'stale');assert.equal(b.image_url,null);assert.equal(f.calls.length,count);
});
