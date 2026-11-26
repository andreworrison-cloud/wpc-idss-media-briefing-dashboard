import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {mergeImpactNow,readPublicJSON,refreshSnapshot,reviewedCollector} from '../assets/browser-recovery.js';
import {recoverRelease,readRelease} from '../assets/release.js';
import {calculate,readCenters} from '../assets/recovery-population.js';
import {recoverDiscussions,recoverWinter} from '../assets/recovery-hazards.js';
import {recoverReports,recoverRivers} from '../assets/recovery-observations.js';

const now=Date.parse('2026-11-26T18:00:00Z');
const min=n=>new Date(now+n*60000).toISOString();
const keys=['alerts','reports','ero','winter','outlook','messages'];
function collector(delta=0) {
  const revision=min(delta), fix={};
  for(const k of keys)fix[k]={status:'ok',retrieved_at:revision};
  const reports={...fix.reports,window_end:revision,window_start:min(delta-3*1440),query_complete:true,count:0,events:[],impact_flag_types:[],source_url:'https://mesonet.agron.iastate.edu/lsr/'};
  return {schema:1,mode:'collector',storage:'available',revision,captured_at:revision,
    sources:{...fix,reports,alerts:{...fix.alerts,source_time:revision,events:[]},ero:{days:[]}},
    health:structuredClone(fix),attempts:structuredClone(fix),comparison:null,collector_version:3};
}
const snapshot=(d=-15)=>({...collector(d),impacts:{exposure:{calculated_at:min(d),groups:{},alert_events:{}},power:{as_of:min(-120)}},weather:{winter:{layers:[]},mpd:{},observations:{},radar:{}}});
const alert=(title,ids=['MOZ001'])=>({id:'urn:example',unit:'CAP message',title,family:'Winter',ugc:ids,states:['MO'],zone_urls:ids.map(z=>'https://api.weather.gov/zones/forecast/'+z),geometry:[],geometry_status:'zone geometry unavailable',sent:min(-30),effective:min(-30),ends:min(120),expires:min(60),source_url:'https://api.weather.gov/alerts/example'});
const poly=(x0,y0,x1,y1)=>({type:'Polygon',coordinates:[[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]]]});
const fail=async()=>{throw Error('Source unavailable');};

test('recovery accepts only the six reviewed public streams and their own clocks',()=>{
  const core=collector();
  assert.ok(reviewedCollector(core,now));assert.equal(reviewedCollector(collector(-21),now),null);
  assert.equal(reviewedCollector(collector(3),now),null);
  core.sources.reports.events.push({id:'safe',reporter:'private'});assert.equal(reviewedCollector(core,now),null);
  core.sources.reports.events=[{id:'safe',source_url:'https://example.com/'}];assert.equal(reviewedCollector(core,now),null);
  core.sources.reports.events=[];core.sources.extra={};assert.equal(reviewedCollector(core,now),null);
});
test('new impacts retain the final usable county and historical travel editions with separate clocks',()=>{
  const old=snapshot();old.impacts.power={as_of:min(-20),customers_out:96,states:[{state:'MO',customers_out:20}],states_as_of:min(-22),states_status:'current',
    counties:[{fips:'12345',customers_out:30}],counties_as_of:min(-25),counties_status:'current'};
  old.impacts.aviation={as_of:min(-20),status:'ok',monthly_context:{status:'ok',period:'2026-09'},events:[]};
  const out=mergeImpactNow(old,{schema:1,checked_at:min(0),power:{status:'partial',as_of:min(-1),customers_out:100,states_status:'current',states_as_of:min(-2),states:[{state:'MO',customers_out:24}],counties_status:'unavailable',counties:[]},
    aviation:{status:'ok',as_of:min(-1),events:[],affected_airports:0}},now);
  assert.equal(out.impacts.power.customers_out,100);assert.equal(out.impacts.power.states[0].customers_out,24);
  assert.equal(out.impacts.power.counties[0].customers_out,30);assert.equal(out.impacts.power.counties_as_of,min(-25));
  assert.equal(out.impacts.aviation.monthly_context.period,'2026-09');assert.equal(out.impacts.aviation.affected_airports,0);
  assert.equal(mergeImpactNow(out,{schema:1,checked_at:min(-40),power:{customers_out:0}},now),out);
});
test('active source changes immediately detach a previous exposure and keep failed inputs dated',async()=>{
  const old=snapshot(), latest=collector(), a=alert('Winter Storm Warning');old.sources.alerts.events=[a];
  old.impacts.exposure.groups.alerts=[{label:a.title,alert_ids:[a.id],population:77,valid_end:min(100),fresh_until:min(20),status:'current'}];
  latest.sources.alerts.events=[{...a,id:'urn:reissued'}];
  latest.attempts.outlook.retained=true;latest.health.outlook.status='unavailable';
  let first;
  const result=await refreshSnapshot(old,{now,fetcher:async url=>url.includes('/api/board?')?Response.json(latest):fail(),populationWorker:async()=>null,
    onUpdate:b=>{first??=b;}});
  assert.equal(first.impacts.exposure.groups.alerts.length,0);assert.equal(result.health.outlook.retrieved_at,min(-15));
  assert.equal(result.attempts.outlook.retained,true);assert.equal(result.impacts.power.as_of,min(-120));assert.equal(result.recovery.publicationRevision,min(-15));
});
test('one on-open recovery is shared across short polling cycles and can start when both static copies are missing',async()=>{
  let count=0;
  const fetcher=async url=>{if(url.includes('/api/board?')){count++;return Response.json(collector());}throw Error('Missing');};
  const historical=snapshot();const a=await recoverRelease(historical,{now,fetcher,populationWorker:async()=>null});
  const b=await recoverRelease(historical,{now:now+60000,fetcher,populationWorker:async()=>null});
  assert.equal(a.revision,min(0));assert.equal(a,b);assert.equal(count,1);
  const only=await readRelease('board',fetcher,now);assert.equal(only.recovery.publicationUnavailable,true);assert.equal(only.revision,min(0));
  const result=await recoverRelease(only,{now,fetcher,populationWorker:async()=>null});
  assert.equal(result.weather.observations.sources.lsr.count,0);assert.equal(count,2);
});
test('a recent publication with a missing power feed repairs only the affected upstream service',async()=>{
  const saved=snapshot(-2);saved.impacts.aviation={status:'ok',as_of:min(-3),events:[]};saved.impacts.ground={rivers:{status:'ok',asOf:min(-3)}};
  const paths=[];
  const recovered=await recoverRelease(saved,{now,fetcher:async url=>{paths.push(url);
    return Response.json({schema:1,checked_at:min(-1),power:{status:'current',as_of:min(-3),customers_out:250}});}});
  assert.equal(recovered.impacts.power.customers_out,250);assert.equal(recovered.revision,saved.revision);
  assert.equal(paths.length,1);assert.match(paths[0],/impact-now/);
});
test('a cold collector waits for the status-backed revision before using a second board response',async()=>{
  const latest=collector(),saved=snapshot(-180),calls=[];
  const fetcher=async url=>{
    if(url.includes('/api/status?')){calls.push('status');return Response.json(latest);}
    if(url.includes('/api/board?')){calls.push('board');return Response.json(calls.length===1?collector(-240):latest);}
    throw Error('Other endpoint unavailable');
  };
  const updated=await refreshSnapshot(saved,{now,fetcher,populationWorker:async()=>null});
  assert.deepEqual(calls,['board','status','board']);assert.equal(updated.revision,min(0));
});
test('Census references are benchmarked, highest risk is exclusive, and zone unions count a resident center once',t=>{
  const dir=mkdtempSync(join(tmpdir(),'idss-census-test-')), path=join(dir,'centers.gz');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  execFileSync('python3',['-c','from pathlib import Path; import sys; from scripts.build_browser_centers import build; build(Path(sys.argv[1]))',path],{cwd:fileURLToPath(new URL('../',import.meta.url))});
  const raw=gunzipSync(readFileSync(path));
  const ref=readCenters(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength));
  const point=ref.points.find(s=>s.state==='MO'), e=.000001;
  const geometry=poly(point.longitude-e,point.latitude-e,point.longitude+e,point.latitude+e);
  const day={day:1,status:'current',no_risk_area:false,issued:min(-120),retrieved_at:min(0),valid_start:min(-60),valid_end:min(100),fresh_until:min(90),features:[1,2].map(rank=>({properties:{risk:rank===1?'Marginal':'Slight',rank},geometry}))};
  const zones=[...ref.zones.keys()].filter(k=>k.startsWith('MOZ')&&ref.zones.get(k).length).slice(0,2);
  const a=alert('Winter Storm Warning',zones), b={...alert('Winter Storm Warning',[zones[0]]),id:'urn:other'};
  const inventory={as_of:min(0),events:[a,b],complete:true}, zoneEditions=Object.fromEntries(zones.map(k=>[k,ref.effective]));
  const result=calculate(ref,{now,days:[day],alerts:inventory,zoneEditions});
  assert.equal(result.ero[0].population,point.population);assert.equal(result.ero[0].bands[0].population,0);assert.equal(result.ero[0].bands[1].population,point.population);
  const expected=[...new Set(zones.flatMap(z=>ref.zones.get(z)))].reduce((n,i)=>n+ref.points[i].population,0);
  assert.equal(result.alerts[0].population,expected);
  assert.equal(calculate(ref,{now,alerts:{...inventory,complete:false},zoneEditions}).alerts[0].population,null);
  assert.equal(calculate(ref,{now,alerts:{...inventory,events:[{...a,zone_urls:[]}]},zoneEditions}).alerts.length,0);
  assert.equal(calculate(ref,{now,alerts:{...inventory,events:[{...a,title:'Tornado Warning'}]},zoneEditions}).alerts.length,0);
  assert.equal(calculate(ref,{now,alerts:{...inventory,events:[{...a,states:['GU']}]},zoneEditions}).alerts[0].population,null);
});
test('snow squalls do not expand to forecast zones; stale zone editions cannot supply newer warning population',async()=>{
  const b=collector(), a=alert('Snow Squall Warning');b.sources.alerts.events=[a];
  b.impacts={exposure:{coverage:{forecast_zones:{status:'verified',effective:'2026-04-16'}}}};
  b.weather={winter:{layers:[{id:'winter_alerts',features:[{geometry:poly(-100,20,-70,40),properties:{zone_url:a.zone_urls[0],ugc:'MOZ001',zone_valid_from:min(-180),zone_valid_until:min(200)}}]}]}};
  const result=await recoverWinter(b,now,fail,false);
  assert.equal(result.layer.features.length,0);assert.equal(result.layer.status,'partial');assert.equal(result.zoneEditions.MOZ001,undefined);
});
test('rolling observations keep PNS evidence dates and separate types of wind and source-linked road reports',()=>{
  const b=collector(),r={id:'r',state:'MO',title:'Marine thunderstorm wind',valid:min(-55),issued:min(-40),city:'River Point',county:'Test',wfo:'LSX',lat:39,lon:-90,
    magnitude:55,unit:'mph',qualifier:'Measured',revision:'original',source_url:'https://mesonet.agron.iastate.edu/api/1/nwstext/202611261720-KLSX-NWUS53-LSRLSX',impact_flags:['Road closure reported']};
  b.sources.reports.events=[r];b.sources.reports.count=1;b.sources.reports.impact_flag_types=['Road closure reported'];
  b.weather={observations:{asOf:min(-200),sources:{pns:{asOf:min(-200),status:'ok'}},features:[{id:'p',sourceType:'PNS',observedAt:min(-260),issuedAt:min(-230)}]}};
  const result=recoverReports(b,now), o=result.weather.observations,g=result.impacts.ground.reports;
  assert.equal(o.sources.pns.asOf,min(-200));assert.equal(o.sources.pns.status,'stale');assert.equal(o.status,'partial');
  assert.equal(o.features[0].measurementType,'windSpeed');assert.deepEqual(o.leaders.wind,[]);
  assert.equal(g.asOf,min(0));assert.equal(g.total,1);assert.equal(g.counts.roadClosure,1);assert.equal(g.counts.rescue,null);
});
const meta=(seq,issued)=>{const id='00000000-1000-1000-1000-'+String(seq).padStart(12,'0');return {'@id':'https://api.weather.gov/products/'+id,id,wmoCollectiveId:'AWUS01',issuingOffice:'KWNH',productCode:'FFG',issuanceTime:issued};};
const bulletin='FFGMPD\nMOC001-261900-\nMesoscale Precipitation Discussion 0123\nAreas affected...Central Missouri\nConcerning...Heavy rain\nValid 261700Z - 261930Z\nATTN...WFO...LSX...\nLAT...LON 39109200 39009100 38209180 39109200';
test('MPD uses matching WPC distribution and avoids a false all-clear or superseded polygons',async()=>{
  const a=meta(1,min(-59)),c=meta(2,min(-25));
  const result=await recoverDiscussions(null,async url=>url.endsWith('/MPD')?{'@graph':[a]}:{...a,productText:bulletin},now);
  assert.equal(result.status,'current');assert.equal(result.count,1);assert.equal(result.features[0].properties.number,'0123');
  const quiet=await recoverDiscussions(null,async()=>({'@graph':[]}),now);assert.equal(quiet.count,null);assert.equal(quiet.explicit_no_mpd,false);
  const uncertain=await recoverDiscussions(result,async url=>url.endsWith('/MPD')?{'@graph':[a,c]}:fail(),now);
  assert.equal(uncertain.status,'partial');assert.equal(uncertain.features.length,0);
});
test('NWPS network clock and transferred site inventory must corroborate a national zero',async()=>{
  const t=now-60000;
  const stats={features:[{attributes:{status:'no_flooding',site_count:318,file_min:t,file_max:t,last_observation:min(-5)}}]};
  const run=(s,features,old={})=>recoverRivers(old,async url=>url.includes('outStatistics')?s:features,now);
  assert.equal((await run(stats,{features:[]})).total,0);
  const missing=structuredClone(stats);missing.features.push({attributes:{...stats.features[0].attributes,status:'minor',site_count:10}});
  const partial=await run(missing,{features:[]});assert.equal(partial.status,'partial');assert.equal(partial.total,null);
  const old={asOf:min(-10),total:4};assert.equal(await run({features:[]},{features:[]},old),old);
});
test('public response byte bounds also apply when content length is missing',async()=>{
  await assert.rejects(readPublicJSON('https://api.weather.gov/test',4,async()=>new Response('{"test":1}')));
});

test('a verified conflicting measurement stays in the report list and cannot become an automatic briefing maximum',async()=>{
  const {reportEvidence,eligibleReport}=await import('../assets/report-evidence.js');
  const {reportPresentation,appendObservedBrief}=await import('../assets/observed-graphics.js');
  const source='https://mesonet.agron.iastate.edu/api/1/nwstext/202611261456-KLSX-NWUS53-LSRLSX';
  const issue='2026-11-26T14:56:00Z',observed='2026-11-26T13:00:00Z';
  const event={id:'one',city:'Cuba',state:'MO',wfo:'LSX',valid:observed,issued:issue,source_url:source,
    magnitude:53,unit:'in',revision:'original'};
  const second={...event,id:'two',city:'Clarksville',magnitude:1};
  const original='https://api.weather.gov/products/6dc792a9-b877-4010-911a-9e33c19199f1';
  const statement='Original report 53 inches. The cooperative station reported 5.3 inches at the same time.';
  const row={id:'one',place:'Cuba',state:'MO',office:'LSX',sourceType:'LSR',measurementType:'snowfall',label:'Snowfall',category:'snow',
    observedAt:observed,issuedAt:'2026-11-26T14:57:00Z',value:53,unit:'in',url:original,evidenceStatus:'bulletinVerified',
    verificationStatus:'conflicting',eligibleForBrief:false,revision:'original',verificationNote:statement};
  const obs={status:'ok',checkedAt:min(-1),features:[row,{...row,id:'normal',place:'French Village',value:14,eligibleForBrief:true,
    verificationStatus:undefined,verificationNote:undefined,url:'https://api.weather.gov/products/another'}]};
  const retained=reportEvidence([event,second],obs);
  assert.equal(retained(event).url,original);
  assert.equal(eligibleReport(retained(event)),false);
  assert.equal(retained(second).evidenceStatus,'ambiguous');
  assert.equal(retained({...event,revision:'correction'}).evidenceStatus,'ambiguous');
  assert.equal(reportPresentation(row).lines.includes(statement),true);
  const draft=appendObservedBrief({evidence:[],sections:[]},obs,{states:[],wfos:[],family:'winter',hours:24},now);
  assert.match(draft.sections[0].lines.join(' '),/French Village.*14 inches/);
  assert.doesNotMatch(draft.sections[0].lines.join(' '),/Cuba|53 inches/);
});
