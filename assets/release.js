// GitHub's branch publisher and the Actions artifact share one viewer and current-data contract.
const current='https://raw.githubusercontent.com/andreworrison-cloud/wpc-idss-media-briefing-dashboard/idss-public-current/';
const valid=(name,v)=>name==='board'?v?.schema===1&&v.sources&&v.health&&v.impacts&&Number.isFinite(Date.parse(v.revision)):v&&Object.hasOwn(v,'edition');
export async function readRelease(name,fetcher=fetch,now=Date.now()){
  if(!['board','handoff'].includes(name))throw Error('Unknown briefing product');
  const file=name+'.json?t='+Math.floor(now/120000);
  async function read(root){try{const response=await fetcher(root+file,{cache:'no-store'});if(response.ok){const obj=await response.json();if(valid(name,obj))return obj;}}catch{}return null;}
  const local=await read('./data/');
  const hasLayers=b=>b?.weather?.radar && b.weather.mpd && b.weather.winter && b.weather.observations;
  if(local&&(name==='handoff'||(hasLayers(local)&&now-Date.parse(local.revision)<12*60000)))return local;
  const latest=await read(current);
  if(!local&&!latest)throw Error('Briefing data unavailable');
  if(name==='board' && !!hasLayers(local)!==!!hasLayers(latest))return hasLayers(local)?local:latest;
  if(local&&latest&&Date.parse(latest.revision)<Date.parse(local.revision))return local;
  return latest||local;
}
