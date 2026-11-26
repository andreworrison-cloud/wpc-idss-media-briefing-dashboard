// The saved Pages edition is available immediately. A late publication can recover individual public feeds.
import {collectorOnly,missingLiveImpacts,refreshSnapshot} from './browser-recovery.js';
const current='https://raw.githubusercontent.com/andreworrison-cloud/wpc-idss-media-briefing-dashboard/idss-public-current/';
const valid=(name,v)=>name==='board'?v?.schema===1&&v.sources&&v.health&&v.impacts&&Number.isFinite(Date.parse(v.revision)):v&&Object.hasOwn(v,'edition');
const minute=60000;
export async function readRelease(name,fetcher=fetch,now=Date.now(),{onSaved}={}){
  if(!['board','handoff'].includes(name))throw Error('Unknown briefing product');
  const file=name+'.json?t='+Math.floor(now/(2*minute));
  async function read(root){
    try {
      const response=await fetcher(root+file,{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(10000)});
      if(response.ok){const obj=await response.json();if(valid(name,obj))return obj;}
    }catch{}
    return null;
  }
  const local=await read('./data/');
  const hasLayers=b=>b?.weather?.radar&&b.weather.mpd&&b.weather.winter&&b.weather.observations;
  if(name==='board'&&hasLayers(local))onSaved?.(local);
  const age=now-Date.parse(local?.revision);
  if(local&&(name==='handoff'||(hasLayers(local)&&age>=-2*minute&&age<12*minute)))return local;
  const latest=await read(current);
  if(!local&&!latest){
    if(name==='board')return collectorOnly(fetcher,now);
    throw Error('Briefing data unavailable');
  }
  if(name==='board'&&!!hasLayers(local)!==!!hasLayers(latest))return hasLayers(local)?local:latest;
  if(local&&latest&&Date.parse(latest.revision)<Date.parse(local.revision))return local;
  return latest||local;
}

const sessions=new WeakMap();
export async function recoverRelease(snapshot, options={}) {
  const now=options.now??Date.now(), fetcher=options.fetcher||fetch, saved=snapshot?.recovery?.publicationRevision||snapshot?.revision;
  const age=now-Date.parse(saved);
  if(!Number.isFinite(age)||age< -2*minute)return snapshot;
  const onlyMissing=!snapshot.recovery?.publicationUnavailable&&age<12*minute;
  if(onlyMissing&&!Object.values(missingLiveImpacts(snapshot,now)).some(Boolean))return snapshot;
  const last=sessions.get(fetcher);
  if(last?.edition===saved&&last.onlyMissing===onlyMissing&&now-last.started>=0&&now-last.started<5*minute) {
    if(last.board!==snapshot)options.onUpdate?.(last.board);
    return last.task;
  }
  const start=last?.edition===saved?last.board:snapshot;
  const session={edition:saved,started:now,board:start,onlyMissing};
  sessions.set(fetcher,session);
  session.task=refreshSnapshot(start,{...options,fetcher,now,onlyMissing,onUpdate:board=>{session.board=board;options.onUpdate?.(board);}})
    .catch(()=>session.board);
  return session.task;
}
