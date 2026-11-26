import {activeDay,currentAlerts,moduleState} from './logic.js';
import {recoverReports,recoverRivers} from './recovery-observations.js';
import {recoverWinter,recoverDiscussions} from './recovery-hazards.js';

const origin='https://wpc-impact-briefing.aorrison.chatgpt.site';
const sourceKeys=['alerts','reports','ero','winter','outlook','messages'];
const fields=new Set('id observation_id title family state states wfo city county valid issued lat lon magnitude unit qualifier trace impact_flags height_ft_agl height_estimated accumulation_hours preliminary revision revision_match source_url'.split(' '));
const privateKeys=new Set('remarks reporter reporter_name reported_by email spreadsheetid private_key access_token raw_rows raw_text __proto__ constructor prototype'.split(' '));
const coreDomains=['weather.gov','noaa.gov','iastate.edu'];
const impactDomains=[...coreDomains,'poweroutmap.com','poweroutage.us','ornl.gov','census.gov','faa.gov','flightaware.com','dot.gov','bts.gov'];
const minute=60000, iso=t=>new Date(t).toISOString(), time=s=>Date.parse(s)||0;
const supported=s=>['partial','ok','current'].includes(s);
const recent=(s,now,minutes)=>time(s)>0&&now-time(s)>=-2*minute&&now-time(s)<=minutes*minute;
const identicalKeys=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));

function reviewed(value,domains,depth=0) {
  if(depth>30)return false;
  if(value&&typeof value==='object')return Object.entries(value).every(([k,v])=>!privateKeys.has(k.toLowerCase())&&reviewed(v,domains,depth+1));
  if(typeof value!=='string')return true;
  if(/docs\.google\.com\/spreadsheets|BEGIN PRIVATE KEY/i.test(value))return false;
  if(!/^https?:\/\//i.test(value))return true;
  try {
    const u=new URL(value);
    if(u.protocol!=='https:'||u.username||u.password)return false;
    return domains.some(d=>u.hostname===d||u.hostname.endsWith('.'+d))||
      domains===impactDomains&&u.hostname==='services.arcgis.com'&&u.pathname==='/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_Aviation_Facilities/FeatureServer/0';
  }catch{return false;}
}
export function reviewedCollector(doc,now) {
  if(doc?.schema!==1||doc.mode!=='collector'||doc.storage!=='available'||typeof doc.revision!=='string'||!doc.revision.endsWith('Z')||
    !recent(doc.revision,now,20)||time(doc.revision)!==time(doc.captured_at)||!sourceKeys.every(k=>doc.sources?.[k]&&doc.health?.[k]&&doc.attempts?.[k])||
    !['sources','health','attempts'].every(k=>identicalKeys(doc[k],sourceKeys))||
    !Array.isArray(doc.sources.reports.events)||!doc.sources.reports.events.every(r=>r&&Object.keys(r).every(k=>fields.has(k))))return null;
  const clean=Object.fromEntries('schema revision captured_at sources health attempts comparison storage mode'.split(' ').map(k=>[k,doc[k]]));
  return reviewed(clean,coreDomains)?clean:null;
}
function matchedExposure(before,after,now) {
  const old=before.impacts?.exposure;
  if(!old)return old;
  const past=new Map(currentAlerts(before,now).map(a=>[a.id,a]));
  const current=currentAlerts(after,now), ids=new Map(current.map(a=>[a.id,a]));
  const sameWarning=(id)=>{
    const a=past.get(id),b=ids.get(id);
    return a&&b&&a.title===b.title&&a.source_url===b.source_url&&a.expires===b.expires&&a.ends===b.ends&&
      a.geometry_status===b.geometry_status&&['geometry','ugc','segments','zone_urls'].every(k=>JSON.stringify(a[k])===JSON.stringify(b[k]));
  };
  const groups={};
  for(const [family,rows] of Object.entries(old.groups||{})){
    groups[family]=(rows||[]).filter(r=>{
      if(!recent(r.calculated_at||old.calculated_at,now,50)||time(r.fresh_until)<=now||time(r.valid_end)<=now)return false;
      if(family==='alerts'||family==='winter_alerts'){
        const members=current.filter(a=>a.title===r.label);
        return r.alert_ids?.length>0 && r.alert_ids.length===members.length && r.alert_ids.every(sameWarning);
      }
      if(family==='ero'){
        const d=after.sources.ero?.days?.find(x=>x.day===r.day),a=before.sources.ero?.days?.find(x=>x.day===r.day);
        return d&&a&&d.source_sha256===a.source_sha256&&time(r.issued)===time(d.issued)&&time(r.valid_start)===time(d.valid_start)&&time(r.valid_end)===time(d.valid_end);
      }
      if(family==='winter')return time(r.issued)===time(after.sources.winter?.issued);
      if(family==='outlook')return r.issued===after.sources.outlook?.issued_date&&JSON.stringify(before.sources.outlook?.features)===JSON.stringify(after.sources.outlook?.features);
      return family==='mpd';
    });
  }
  const events=Object.fromEntries(Object.entries(old.alert_events||{}).filter(([id,r])=>sameWarning(id)&&time(r.fresh_until)>now));
  return {...old,groups,alert_events:events};
}
async function currentCollector(fetcher,now) {
  const bucket=Math.floor(now/(5*minute)),url=origin+'/api/board?t='+bucket;
  const first=await safe(readPublicJSON(url,10000000,fetcher,18000));
  const ready=reviewedCollector(first,now);
  if(ready)return ready;
  // A cold collection can outlive the first request. Status waits for due inputs in the dedicated collector.
  const status=await safe(readPublicJSON(origin+'/api/status?t='+bucket,250000,fetcher,35000));
  if(status?.mode!=='collector'||status.storage!=='available'||!recent(status.revision,now,20))return null;
  const collected=reviewedCollector(await safe(readPublicJSON(url+'&revision='+encodeURIComponent(status.revision),10000000,fetcher,18000)),now);
  return collected&&time(collected.revision)>=time(status.revision)?collected:null;
}
export async function collectorOnly(fetcher,now) {
  const core=await currentCollector(fetcher,now);
  if(!core)throw Error('A current verified collector response is unavailable');
  return recoverReports({...core,weather:{},impacts:{},recovery:{publicationUnavailable:true,publicationRevision:null,collectorRevision:core.revision}},now);
}
function mergedCore(snapshot,core,now) {
  if(!core||time(core.revision)<=time(snapshot.revision))return snapshot;
  const sources={...snapshot.sources},health={...snapshot.health},attempts={...snapshot.attempts};
  for(const k of sourceKeys) {
    const incoming=core.health[k], prior=snapshot.health[k], attempt=core.attempts[k];
    if(time(incoming.retrieved_at)>=time(prior?.retrieved_at)&&supported(incoming.status)&&!incoming.retained&&!attempt.retained) {
      sources[k]=core.sources[k];health[k]=incoming;attempts[k]=attempt;
    } else {
      // An unsuccessful recheck does not advance the retained product's retrieval time.
      health[k]={...prior,status:prior?.status||'unavailable',checked_at:incoming.checked_at,retained:true};
      attempts[k]={...attempt,retained:true};
    }
  }
  const base={...snapshot,...core,sources,health,attempts,recovery:{...snapshot.recovery,
    publicationRevision:snapshot.recovery?.publicationRevision||snapshot.revision,collectorRevision:core.revision}};
  return recoverReports({...base,impacts:{...base.impacts,exposure:matchedExposure(snapshot,base,now)}},now);
}

function combinePower(old,next,now) {
  if(!next)return old;
  const timeAllowed=t=>time(t)>0&&time(t)<=now+2*minute;
  const newer=supported(next.status)&&Number.isFinite(next.customers_out)&&timeAllowed(next.as_of)&&time(next.as_of)>=time(old?.as_of);
  const hasGeography=['states','counties'].some(key=>supported(next[key+'_status'])&&timeAllowed(next[key+'_as_of'])&&Array.isArray(next[key])&&next[key].length);
  const root=newer?next:old||(hasGeography?{...next,customers_out:null,as_of:null,status:'partial'}:null);
  if(!root)return null;
  const power={...root};
  for(const key of ['states','counties']) {
    const timeKey=key+'_as_of',stateKey=key+'_status';
    const good=supported(next[stateKey])&&timeAllowed(next[timeKey])&&Array.isArray(next[key])&&
      (next[stateKey]!=='partial'||next[key].length);
    const retainComplete=next[stateKey]==='partial'&&['current','ok'].includes(old?.[stateKey])&&recent(old[timeKey],now,35);
    const own=good&&!retainComplete&&time(next[timeKey])>=time(old?.[timeKey])?next:old;
    if(own?.[key]){
      power[key]=own[key];power[timeKey]=own[timeKey];power[stateKey]=own[stateKey];
    }
  }
  return power;
}
function combineAir(old,next,now) {
  if(!next||!supported(next.status)||!time(next.as_of)||time(next.as_of)>now+2*minute||time(next.as_of)<time(old?.as_of)||!Array.isArray(next.events))return old;
  if(next.status==='partial'&&!next.events.length&&old?.events?.length&&supported(old.status)&&recent(old.as_of,now,30))return old;
  const air={...old,...next};
  if(!next.monthly_context||!supported(next.monthly_context.status))air.monthly_context=old?.monthly_context||next.monthly_context;
  if(!next.flight_counts||!supported(next.flight_counts.status))air.flight_counts=old?.flight_counts||next.flight_counts;
  return air;
}
export function mergeImpactNow(board,doc,now) {
  if(doc?.schema!==1||!recent(doc.checked_at,now,25))return board;
  const previous=board.impacts||{}, power=doc.power&&reviewed(doc.power,impactDomains)?combinePower(previous.power,doc.power,now):previous.power;
  const aviation=doc.aviation&&reviewed(doc.aviation,impactDomains)?combineAir(previous.aviation,doc.aviation,now):previous.aviation;
  if(power===previous.power&&aviation===previous.aviation)return board;
  return {...board,impacts:{...previous,power,aviation},recovery:{...board.recovery,impactCheck:doc.checked_at}};
}

export async function readPublicJSON(url,limit,fetcher=fetch,timeout=10000) {
  const response=await fetcher(url,{credentials:'omit',mode:'cors',redirect:'error',cache:'no-store',
    headers:{Accept:'application/geo+json,application/json;q=0.9'},signal:AbortSignal.timeout(timeout)});
  if(!response.ok||Number(response.headers.get('content-length'))>limit)throw Error('Public feed unavailable');
  const reader=response.body?.getReader();
  if(!reader)throw Error('Public response unavailable');
  const decoder=new TextDecoder(),chunks=[];let size=0;
  try {
    for(;;) {
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>limit){await reader.cancel();throw Error('Public response too large');}
      chunks.push(decoder.decode(value,{stream:true}));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(''));
  }finally{reader.releaseLock();}
}

let worker,sequence=0;
const awaiting=new Map();
function terminateWorker() {
  worker?.terminate();worker=null;
  for(const {resolve,timer} of awaiting.values()) {clearTimeout(timer);resolve(null);}
  awaiting.clear();
}
function geography(request) {
  if(typeof Worker==='undefined')return Promise.resolve(null);
  if(!worker) {
    worker=new Worker(new URL('./recovery-population.js',import.meta.url),{type:'module',name:'idss-population'});
    worker.onmessage=({data})=>{
      const job=awaiting.get(data?.id);
      if(job){clearTimeout(job.timer);awaiting.delete(data.id);job.resolve(data.groups);}
    };
    worker.onerror=terminateWorker;
  }
  return new Promise(resolve=>{
    const id=++sequence,timer=setTimeout(terminateWorker,40000);
    awaiting.set(id,{resolve,timer});worker.postMessage({id,request});
  });
}
function withExposure(board,groups,now) {
  if(!groups||!Object.keys(groups).length)return board;
  const last=board.impacts?.exposure||{},kept={}, oldFresh=recent(last.calculated_at,now,50);
  if(oldFresh) {
    for(const [key,values] of Object.entries(last.groups||{})) {
      if(Object.hasOwn(groups,key))continue;
      kept[key]=(values||[]).filter(r=>{
        if(!recent(r.calculated_at||last.calculated_at,now,50))return false;
        if(time(r.valid_end)<=now||time(r.fresh_until)<=now)return false;
        if(key==='winter')return time(r.issued)===time(board.sources?.winter?.issued);
        if(key==='outlook')return r.issued===board.sources?.outlook?.issued_date;
        if(key==='ero')return time(r.issued)===time(board.sources?.ero?.days?.find(d=>d.day===r.day)?.issued);
        return false;
      }).map(r=>({...r,calculated_at:r.calculated_at||last.calculated_at}));
    }
  }
  return {...board,impacts:{...board.impacts,exposure:{...last,source:last.source||{label:'U.S. Census Bureau',url:'https://www.census.gov/geographies/reference-files/2020/geo/2020-centers-population.html',vintage:'2020'},
    status:'partial',calculated_at:iso(now),groups:{...kept,...groups},alert_events:{}}}};
}
function updateGround(board, rivers) {
  if(!rivers||rivers===board.impacts?.ground?.rivers)return board;
  return {...board,impacts:{...board.impacts,ground:{...board.impacts?.ground,rivers}}};
}
const safe=p=>Promise.resolve(p).catch(()=>null);
export function missingLiveImpacts(board,now) {
  const {power,aviation,ground}=board.impacts||{};
  const powerOk=supported(power?.status)&&recent(power.as_of,now,35)&&Number.isFinite(power.customers_out);
  const airOk=supported(aviation?.status)&&recent(aviation.as_of,now,30)&&Array.isArray(aviation.events);
  const riverOk=supported(ground?.rivers?.status)&&recent(ground.rivers.asOf,now,60);
  return {impact:!powerOk||!airOk,rivers:!riverOk};
}
export async function refreshSnapshot(snapshot,{now=Date.now(),fetcher=fetch,onUpdate,populationWorker=geography,onlyMissing=false}={}) {
  const read=(url,limit)=>readPublicJSON(url,limit,fetcher), key='?t='+Math.floor(now/(5*minute));
  let board=snapshot;
  const emit=(next)=>{if(next&&next!==board){board=next;onUpdate?.(board);}};
  const targets=onlyMissing?missingLiveImpacts(snapshot,now):{impact:true,rivers:true};
  const impact=targets.impact?safe(read(origin+'/api/impact-now'+key,5000000)).then(value=>emit(mergeImpactNow(board,value,now))):null;
  const river=targets.rivers?safe(recoverRivers(snapshot.impacts?.ground?.rivers,read,now)).then(value=>emit(updateGround(board,value))):null;
  if(onlyMissing){await Promise.all([impact,river]);return board;}
  const core=(snapshot.recovery?.publicationUnavailable&&recent(snapshot.revision,now,5)?Promise.resolve(snapshot):currentCollector(fetcher,now)).then(value=>emit(mergedCore(board,value,now)));
  let mpd;
  const discussion=safe(recoverDiscussions(snapshot.weather?.mpd,read,now)).then(value=>{
    if(value&&value!==snapshot.weather?.mpd){
      mpd=value;
      const previous=board.weather?.mpd,exposure=board.impacts?.exposure;
      const sameArea=r=>{
        const match=f=>'mpd-'+f.properties?.number===r.id;
        const a=previous?.features?.find(match),b=mpd.features?.find(match);
        return a&&b&&time(a.properties.issued)===time(b.properties.issued)&&time(r.valid_start)===time(b.properties.valid_start)&&time(r.valid_end)===time(b.properties.valid_end)&&JSON.stringify(a.geometry)===JSON.stringify(b.geometry);
      };
      const valid=(exposure?.groups?.mpd||[]).filter(sameArea);
      const impacts=exposure?{...board.impacts,exposure:{...exposure,groups:{...exposure.groups,mpd:valid}}}:board.impacts;
      emit({...board,weather:{...board.weather,mpd},impacts});
    }
  });
  await core;
  let winter;
  if(goodAlerts(board,now)) {
    winter=await safe(recoverWinter(board,now,fetcher,false));
    if(winter)emit({...board,weather:{...board.weather,winter:winter.winter}});
  }
  const moreZones=winter?.layer?.status==='partial'?safe(recoverWinter(board,now,fetcher,true)):null;
  await discussion;
  const census=async()=>{
    const days=(board.sources?.ero?.days||[]).filter(d=>activeDay(board,d.day,now));
    const alerts=goodAlerts(board,now)?{events:currentAlerts(board,now),as_of:board.health.alerts.retrieved_at,complete:moduleState(board,'alerts',now)!=='partial'}:null;
    // Only the source CAP geometry is sent to the worker. Forecast zones use exact frozen memberships.
    const req={now,days,alerts,winter:winter&&{events:winter.layer.events,retrieved_at:winter.layer.retrieved_at,complete:moduleState(board,'alerts',now)!=='partial'},mpd,zoneEditions:winter?.zoneEditions||{}};
    const groups=await safe(Promise.resolve().then(()=>populationWorker(req)));
    emit(withExposure(board,groups,now));
  };
  await census();
  if(moreZones) {
    const augmented=await moreZones;
    if(augmented&&augmented.layer.feature_count>winter.layer.feature_count){
      const extraExposure=Object.keys(augmented.zoneEditions).length>Object.keys(winter.zoneEditions).length;
      winter=augmented;emit({...board,weather:{...board.weather,winter:winter.winter}});
      if(extraExposure)await census();
    }
  }
  await Promise.all([impact,river]);
  return board;
}
function goodAlerts(board,now) {return supported(moduleState(board,'alerts',now))&&!board.health?.alerts?.retained;}
