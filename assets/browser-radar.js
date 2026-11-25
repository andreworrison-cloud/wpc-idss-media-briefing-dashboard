/* Public radar recovery for the briefing board. Each source uses UTC image times. */
const HYDRO = 'https://andreworrison-cloud.github.io/wpc-hydro-dashboard/';
const REPO = 'andreworrison-cloud/wpc-hydro-dashboard';
const RAW = 'https://raw.githubusercontent.com/' + REPO + '/';
const REF = 'https://api.github.com/repos/' + REPO + '/git/ref/heads/mrms-rala-data';
const MANIFEST = 'mrms_rala_loop_manifest.json';
const IEM = 'https://mesonet.agron.iastate.edu';
const MINUTE = 60_000, MAX_AGE = 20 * MINUTE, RETRY = 2 * MINUTE;
const sessions = new WeakMap();
const iso = n => new Date(n).toISOString().replace('.000Z', 'Z');
const must = (valid, message) => { if (!valid) throw new Error(message); };

function fresh(radar, now) {
  if (radar?.status !== 'current' || !radar.image_url) return false;
  const time = Date.parse(radar.valid_time);
  return time <= now && now < Math.min(time + MAX_AGE, Date.parse(radar.fresh_until));
}

function failed(original, now) {
  const stale = Boolean(original?.valid_time);
  return { ...original, status: stale ? 'stale' : 'unavailable', image_url: null, frames: [],
    fresh_until: null, checked_at: iso(now), reason: stale
      ? 'Radar observation expired. A newer frame could not be verified.'
      : 'A current radar observation could not be verified.' };
}

async function read(fetcher, url, consume, headers = {}, cache = 'default') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetcher(url, { mode: 'cors', credentials: 'omit', cache, headers, signal: controller.signal });
    if (!r.ok || r.type === 'opaque') {
      const error = new Error('Radar source returned HTTP ' + r.status);
      const retry = r.headers?.get('Retry-After');
      const rateReset = Number(r.headers?.get('X-RateLimit-Reset')) * 1000;
      error.cooldown = [403, 429].includes(r.status) ? Math.max(
        Date.now() + RETRY, Number.isFinite(+retry) ? Date.now() + Number(retry)*1000 : Date.parse(retry) || 0,
        rateReset || 0) : 0;
      throw error;
    }
    return await consume(r);
  } finally { clearTimeout(timer); }
}

async function prefix(response) {
  // If a server ignores HTTP Range, stop reading after the image header.
  const reader = response.body.getReader();
  const header = new Uint8Array(32);
  let size = 0;
  try {
    while (size < header.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(header.length-size, value.length);
      header.set(value.subarray(0,take),size);
      size += take;
    }
  } finally { reader.cancel().catch(() => {}); }
  must(size >= 29, 'Short radar PNG header');
  return header;
}

function shape(bytes, width, height) {
  const signature = [137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82];
  const dv = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  must(bytes.length >= 29 && signature.every((x,i) => bytes[i] === x) &&
    dv.getUint32(16) === width && dv.getUint32(20) === height, 'Radar PNG dimensions disagree');
}
const headerAt = (fetcher,url) => read(fetcher,url,prefix,{Range:'bytes=0-31'});
const textStamp = n => iso(n).replace(/[-:]/g,'');
const NOAA_SOURCE_HOSTS = new Set(['mrms.ncep.noaa.gov','noaa-mrms-pds.s3.amazonaws.com','noaa-mrms-pds.s3.us-east-1.amazonaws.com','s3.amazonaws.com']);

async function hydro(now, fetcher, memo) {
  must(now >= memo.githubUntil, 'GitHub radar source cooling down');
  let ref;
  try {
    ref = await read(fetcher, REF+'?t='+Math.floor(now/RETRY), r=>r.json(),{},'no-cache');
  } catch (error) {
    if (error.cooldown) memo.githubUntil = error.cooldown;
    throw error;
  }
  const rev = ref.object?.sha;
  must(ref.ref === 'refs/heads/mrms-rala-data' && ref.object.type === 'commit' && /^[a-f0-9]{40}$/.test(rev),'Unexpected Hydro data branch');
  const root = RAW + rev + '/';
  const m = await read(fetcher,root+MANIFEST,r=>r.json());
  must(m.metadata_mode === 'mrms_rala_loop_manifest_v2' && m.product === 'ReflectivityAtLowestAltitude' &&
    m.region === 'CONUS' && m.units === 'dBZ' && m.target_frame_cadence_minutes === 10, 'Unexpected Hydro radar product');
  const date = Date.parse(m.latest_valid_time_utc), generated = Date.parse(m.generated_utc);
  const limit = Number(m.freshness_limit_minutes);
  must(limit > 0 && limit <= 20 && date <= now && now < date+limit*MINUTE && date <= generated && generated <= now+2*MINUTE,
    'Hydro observation is stale or in the future');
  const display = m.display, bounds = display.leaflet_bounds;
  must(display.projection === 'EPSG:3857' && display.resampling === 'nearest-neighbor' && display.smoothing === false &&
    display.visible_minimum_dbz === 5 && Array.isArray(bounds) && bounds.length === 2 &&
    bounds.every(a=>Array.isArray(a) && a.length===2 && a.every(Number.isFinite)) &&
    -85 <= bounds[0][0] && bounds[0][0] < bounds[1][0] && bounds[1][0] <= 85 &&
    -180 <= bounds[0][1] && bounds[0][1] < bounds[1][1] && bounds[1][1] <= 180, 'Hydro image bounds or rendering changed');
  const width=display.image_width_px, height=display.image_height_px;
  must(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width>0 && height>0 && Array.isArray(display.color_table) &&
    display.color_table.length>=2 && display.color_table.every((r,i,a)=>Number.isFinite(r.threshold_dbz) &&
      /^#[0-9a-f]{6}$/i.test(r.color) && (!i || r.threshold_dbz>a[i-1].threshold_dbz)), 'Hydro dimensions or palette changed');
  must(Array.isArray(m.frames) && m.frames.length>0 && m.frames.length===m.frame_count, 'Incomplete Hydro radar inventory');
  let prev=-Infinity;
  const frames=m.frames.map(row=>{
    const t=Date.parse(row.valid_time_utc);
    must(Number.isFinite(t) && t>prev && row.png==='frames/mrms_rala_'+textStamp(t)+'.png','Invalid Hydro frame timestamp or filename');
    prev=t;
    return {valid_time:iso(t),image_url:root+row.png};
  });
  const image=frames.at(-1), row=m.frames.at(-1);
  const s = new URL(row.source_url);
  const key = 'MRMS_ReflectivityAtLowestAltitude_00.50_'+textStamp(date).replace('T','-').replace('Z','')+'.grib2.gz';
  must(prev===date && s.protocol==='https:' && NOAA_SOURCE_HOSTS.has(s.hostname) && s.pathname.endsWith('/'+key) && row.source_key===key,'Upstream radar time disagrees');
  if (m.publication_validation) {
    const checked=Date.parse(m.publication_validation.checked_at_utc);
    must(Date.parse(m.publication_validation.latest_valid_time_utc)===date && date<=checked && checked<=date+limit*MINUTE,'Hydro publication receipt disagrees');
  }
  shape(await headerAt(fetcher,image.image_url),width,height);
  return {status:'current',label:'MRMS lowest-altitude reflectivity',provider:'NOAA MRMS via Hydro',domain:'CONUS',units:'dBZ',
    checked_at:iso(now),valid_time:iso(date),fresh_until:iso(date+limit*MINUTE),freshness_minutes:limit,cadence_minutes:10,generated_at:iso(generated),
    projection:'EPSG:3857',bounds,image_dimensions:[width,height],visible_minimum_dbz:5,color_table:display.color_table,frames,
    image_url:image.image_url,source_url:root+MANIFEST,source_data_url:s.href,revision:rev,dashboard_url:HYDRO,
    recovery:'browser',reason:'Verified timestamped Hydro image.'};
}

const IEM_COLORS=['#9098b4','#6376a8','#4568a6','#60b4d4','#43d67e','#0eb314','#0b840e','#327308','#ffe200',
  '#ffac00','#f80000','#aa0000','#ffeaff','#f960fa','#a400f7','#05eaf0','#04adb0'];
const iemUrl = (time,width,height) => IEM+'/cgi-bin/wms/nexrad/n0q-t.cgi?'+new URLSearchParams({
  service:'WMS',version:'1.1.1',request:'GetMap',layers:'nexrad-n0q-wmst',styles:'',format:'image/png',
  transparent:'TRUE',srs:'EPSG:3857',bbox:'-14026255.840,2632018.638,-7235766.902,6446275.841',width,height,time:iso(time)
});

async function hasEchoes(response, width, height) {
  // A missing WMS time can return HTTP 200 with a completely transparent image.
  // Probe a small map of the same bounds and observation time.
  const bytes=new Uint8Array(await response.arrayBuffer());
  shape(bytes,width,height);
  must(bytes.length<=600000 && bytes[24]===8 && bytes[25]===6 && bytes[28]===0, 'Unexpected WMS sample');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), data=[];
  let end=false;
  for(let p=8; p+12<=bytes.length;) {
    const n=view.getUint32(p),type=view.getUint32(p+4);
    must(p+n+12<=bytes.length, 'Truncated WMS image');
    if(type===0x49444154) data.push(bytes.subarray(p+8,p+8+n));
    if(type===0x49454e44) { end=true; break; }
    p+=n+12;
  }
  must(end && data.length, 'Incomplete WMS image');
  const stream=new Blob(data).stream().pipeThrough(new DecompressionStream('deflate'));
  const scan=new Uint8Array(await new Response(stream).arrayBuffer());
  const stride=1+width*4;
  must(scan.length===stride*height,'Incomplete WMS pixels');
  for(let y=0;y<height;y++) {
    // All standard PNG filters encode a wholly transparent alpha plane as zero residuals.
    for(let x=y*stride+4;x<(y+1)*stride;x+=4) if(scan[x]) return;
  }
  throw Error('IEM map contains no visible radar observation');
}

async function iem(now, fetcher) {
  const slot=Math.floor(now/(5*MINUTE))*5*MINUTE;
  const times=[0,1,2,3].map(k=>slot-5*k*MINUTE).filter(t=>now<t+MAX_AGE);
  const verified=await Promise.allSettled(times.map(async t=>{
    const day=iso(t).slice(0,10).replace(/-/g,'/');
    const name=iso(t).slice(0,16).replace(/[-T:]/g,'');
    const url=IEM+'/archive/data/'+day+'/GIS/uscomp/n0q_'+name+'.png';
    // Archive name and header establish that this exact nominal UTC time exists.
    shape(await headerAt(fetcher,url),12200,5400);
    return {t,url};
  }));
  for(const item of verified) {
    if(item.status!=='fulfilled') continue;
    const {t,url}=item.value;
    try {
      await read(fetcher,iemUrl(t,360,202),r=>hasEchoes(r,360,202));
      const image=iemUrl(t,2100,1180);
      return {status:'current',label:'NEXRAD base reflectivity',provider:'Iowa Environmental Mesonet (IEM)',domain:'CONUS',units:'dBZ',
        checked_at:iso(now),valid_time:iso(t),fresh_until:iso(t+MAX_AGE),freshness_minutes:20,cadence_minutes:5,
        projection:'EPSG:3857',bounds:[[23,-126],[50,-65]],image_dimensions:[2100,1180],
        color_table:IEM_COLORS.map((color,i)=>({threshold_dbz:i*5,color})),
        frames:[{valid_time:iso(t),image_url:image}],image_url:image,source_url:IEM+'/GIS/rasters.php?rid=2',source_data_url:url,
        dashboard_url:HYDRO,recovery:'browser',reason:'Verified dated NEXRAD archive and matching time-enabled radar image.'};
    } catch { /* Allow earlier verified slots within the 20-minute observation window. */ }
  }
  throw Error('No verified IEM radar frame');
}

function newState() { return { until:0, githubUntil:0, good:null, pending:null }; }

/** Return one verified radar module. A complete published board is also accepted. */
export async function currentRadar(snapshot, {now=Date.now(),fetcher=fetch}={}) {
  const time = typeof now === 'string' ? Date.parse(now) : Number(now);
  const suppliedModule = snapshot && ('image_url' in snapshot || 'valid_time' in snapshot || 'provider' in snapshot);
  const original = snapshot?.weather?.radar ?? snapshot?.radar ?? (suppliedModule ? snapshot : null);
  must(Number.isFinite(time),'Invalid radar evaluation time');
  if(fresh(original,time)) return original;
  let state=sessions.get(fetcher);
  if(!state) { state=newState(); sessions.set(fetcher,state); }
  if(!state.pending && time>=state.until) {
    state.until=time+RETRY;
    state.pending=(async()=>{
      try { return await hydro(time,fetcher,state); }
      catch {
        if (fresh(state.good,time) && state.good.provider === 'NOAA MRMS via Hydro') return state.good;
        try { return await iem(time,fetcher); } catch { return null; }
      }
    })().then(found=>{
      if (found && !(fresh(state.good,time) && state.good.provider === found.provider &&
          Date.parse(state.good.valid_time)>Date.parse(found.valid_time))) state.good=found;
    }).finally(()=>{state.pending=null;});
  }
  const began=Date.now();
  if(state.pending) await state.pending;
  const atReturn=time+Math.max(0,Date.now()-began);
  return fresh(state.good,atReturn)?state.good:failed(original,atReturn);
}
