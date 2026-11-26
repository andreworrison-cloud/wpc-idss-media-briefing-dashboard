import {indexAreas, contains} from './briefing-focus.js';

const CELL = 2;
const geographicCell = (x,y) => (Math.floor((y + 90) / CELL) * 181) + Math.floor((x + 180) / CELL);
const SCOPE = 'Estimated residents at 2020 Census block-group population centers. Overlapping areas are counted once.';
const RISK = ['Marginal', 'Slight', 'Moderate', 'High'];
const usable = s => ['current', 'ok', 'partial'].includes(s);
const zonal = new Set('blizzard warning|coastal flood warning|extreme cold warning|extreme heat warning|excessive heat warning|freeze warning|hard freeze warning|high surf warning|high wind warning|ice storm warning|lake effect snow warning|lakeshore flood warning|wind chill warning|winter storm warning|winter storm watch|winter weather advisory'.split('|'));
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-$/,'');
const iso = t => new Date(t).toISOString();
const end = (...times) => iso(Math.min(...times.filter(t=>t && Number.isFinite(Date.parse(t))).map(Date.parse)));
const until = (stamp,minutes) => iso(Date.parse(stamp)+minutes*60000);

export function readCenters(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 8 || view.getUint32(0) !== 0x49445343) throw Error('Unrecognized Census reference');
  const offset = 8 + view.getUint32(4,true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,8,offset-8)));
  if (meta.version !== 1 || meta.count !== 240942 || meta.residents !== 334735155 ||
      view.byteLength !== offset + meta.count*15) throw Error('Incomplete Census reference');
  const cells = new Map(), zones = new Map(), names = meta.codes;
  const points = new Array(meta.count);
  let residents = 0;
  for (let i=0;i<meta.count;i++) {
    const at=offset+i*15, longitude=view.getInt32(at,true)/1e6, latitude=view.getInt32(at+4,true)/1e6;
    const population=view.getUint32(at+8,true), state=meta.states[view.getUint8(at+12)];
    if (!population || !state) throw Error('Invalid Census jurisdiction');
    const p = {longitude,latitude,population,state,index:i};
    points[i]=p;
    const key=geographicCell(longitude,latitude);
    if (!cells.has(key)) cells.set(key,[]);
    cells.get(key).push(p);
    for (const z of meta.members[view.getUint16(at+13,true)]) {
      if (!zones.has(names[z])) zones.set(names[z],[]);
      zones.get(names[z]).push(i);
    }
    residents+=population;
  }
  if (residents!==meta.residents) throw Error('Census benchmark mismatch');
  // Unpopulated forecast zones are valid and contribute an empty set of centers.
  for (const z of names) if (!zones.has(z)) zones.set(z,[]);
  return {points,cells,zones,stateCodes:new Set(Object.values(meta.states)),effective:meta.effective};
}

function polygonIds(reference, features) {
  if (!features.length || features.some(f=>!['Polygon','MultiPolygon'].includes(f?.geometry?.type))) return null;
  const {areas,complete}=indexAreas(features);
  if (!complete) return null;
  const ids=new Set();
  for (const area of areas) {
    const outer=area[0];
    for (let y=Math.max(-90,Math.floor(outer.yMin/CELL)*CELL); y<=Math.min(90,outer.yMax); y+=CELL) {
      for (let x=Math.floor(outer.xMin/CELL)*CELL; x<=outer.xMax; x+=CELL) {
        const normalized=((x+180)%360+360)%360-180;
        for (const p of reference.cells.get(geographicCell(normalized,y)) || []) {
          if (!ids.has(p.index) && contains([area],p)) ids.add(p.index);
        }
      }
    }
  }
  return ids;
}
const union=(target,ids)=>{for(const id of ids) target.add(id);};
function totals(reference, ids) {
  const rows=new Map();
  let population=0;
  for (const id of ids) {
    const p=reference.points[id];
    rows.set(p.state,(rows.get(p.state)||0)+p.population);
    population+=p.population;
  }
  return {population,states:Array.from(rows,([code,population])=>({code,population})).sort((a,b)=>b.population-a.population||a.code.localeCompare(b.code))};
}
function rainfall(reference,days,now) {
  const result=[];
  for (const d of days) {
    if (d.status!=='current' || !Number.isInteger(d.day) || d.day<1 || d.day>5 || !Number.isFinite(Date.parse(d.issued)) ||
        !Number.isFinite(Date.parse(d.valid_start)) || Date.parse(d.valid_end)<=now || Date.parse(d.fresh_until)<=now ||
        !Array.isArray(d.features) || (!d.features.length)!==(d.no_risk_area===true)) continue;
    const ids=[0,1,2,3].map(()=>new Set());
    let complete=true;
    for (const f of d.features) {
      const rank=f?.properties?.rank;
      if (!Number.isInteger(rank) || rank<1 || rank>4 || RISK[rank-1]!==f.properties.risk) {complete=false;break;}
      const hits=polygonIds(reference,[f]);
      if (!hits) {complete=false;break;}
      union(ids[rank-1],hits);
    }
    if (!complete) continue;
    const seen=new Set(), bands=[];
    for (let i=3;i>=0;i--) {
      const exclusive=[...ids[i]].filter(v=>!seen.has(v));
      union(seen,exclusive);
      const threshold=totals(reference,seen);
      bands.unshift({id:RISK[i].toLowerCase(),label:RISK[i],rank:i+1,...totals(reference,exclusive),
        at_or_above:threshold.population,at_or_above_states:threshold.states});
    }
    result.push({id:'ero-d'+d.day,label:'Day '+d.day+' excessive rainfall',day:d.day,family:'Flood',issued:d.issued,as_of:d.retrieved_at,
      valid_start:d.valid_start,valid_end:d.valid_end,fresh_until:end(d.valid_end,d.fresh_until,until(d.retrieved_at,90)),
      source_url:d.source_url,feature_indices:d.features.map((_,i)=>i),status:'current',...totals(reference,seen),mapped_population:null,bands,
      coverage:'Contiguous U.S. WPC outlook. Each center is assigned to its highest mapped risk for the forecast day.'});
  }
  return result;
}

function alertGroups(reference, inventory, checked, zoneEditions, now, winter, verifiedInventory) {
  if (!Number.isFinite(Date.parse(checked))) return [];
  const groups=Map.groupBy ? Map.groupBy(inventory,e=>e.title) : inventory.reduce((m,e)=>m.set(e.title,[...(m.get(e.title)||[]),e]),new Map());
  const records=[];
  for (const [label,events] of groups) {
    if (!winter && (!/warning/i.test(label) || events.every(e=>/marine/i.test(e.family)))) continue;
    const ids=new Set(), alertIds=[], expirations=[];
    let complete=verifiedInventory!==false;
    for (const e of events) {
      if (!e?.id || alertIds.includes(e.id)) continue;
      const ends=[e.valid_end,e.expires,e.ends].filter(t=>Number.isFinite(Date.parse(t)));
      if (!ends.length || !(Date.parse(e.effective||e.valid_start)<=now) || ends.some(t=>Date.parse(t)<=now)) continue;
      alertIds.push(e.id); expirations.push(...ends);
      if((e.states||[]).some(s=>!reference.stateCodes.has(s)))complete=false;
      const g=Array.isArray(e.geometry)?e.geometry:e.geometry?[e.geometry]:[];
      if (g.length && /source polygon|cap polygon/i.test(e.geometry_status||'')) {
        const hits=polygonIds(reference,g.map(geometry=>({geometry})));
        if (hits) union(ids,hits); else complete=false;
      } else if (zonal.has(label.toLowerCase()) && e.ugc?.length && !g.length && (!e.unit || e.unit==='CAP message')) {
        const linked=new Set((e.zone_urls||[]).map(u=>/^https:\/\/api\.weather\.gov\/zones\/(?:forecast|public)\/([A-Z]{2}Z\d{3})$/.exec(u)?.[1]));
        for (const z of e.ugc) {
          if (!linked.has(z) || zoneEditions[z]!==reference.effective || !reference.zones.has(z)) {complete=false;continue;}
          union(ids,reference.zones.get(z));
        }
      } else complete=false;
    }
    if (!alertIds.length || (!complete && !ids.size)) continue;
    const stats=totals(reference,ids);
    records.push({id:(winter?'winter-zone-':'alert-')+slug(label),label,family:winter?'Winter':events[0].family,
      ...(winter?{map_product:'winter_alerts'}:{}),as_of:checked,basis:'NWS source polygons or verified public forecast zones',
      valid_start:checked,valid_end:end(...expirations),fresh_until:end(until(checked,30),...expirations),
      alert_ids:alertIds,source_url:'https://api.weather.gov/alerts/active',status:complete?'current':'partial',
      population:complete?stats.population:null,mapped_population:complete?null:stats.population,states:stats.states,bands:[],coverage:SCOPE});
  }
  return records;
}
export function calculate(reference, request) {
  const {now,days=[],winter,alerts,mpd}=request;
  const output={};
  if (days.length) output.ero=rainfall(reference,days,now);
  if (alerts) output.alerts=alertGroups(reference,alerts.events,alerts.as_of,request.zoneEditions||{},now,false,alerts.complete);
  if (winter) output.winter_alerts=alertGroups(reference,winter.events,winter.retrieved_at,request.zoneEditions||{},now,true,winter.complete);
  if (mpd && usable(mpd.status) && Date.parse(mpd.fresh_until)>now) {
    output.mpd=[];
    for (const f of mpd.features||[]) {
      const p=f.properties;
      if (!(Date.parse(p.valid_start)<=now && now<Date.parse(p.valid_end))) continue;
      const hit=polygonIds(reference,[f]);
      if (!hit) continue;
      output.mpd.push({id:'mpd-'+p.number,label:'WPC MPD '+p.number,family:'Flood',map_product:'mpd',
        basis:'WPC mesoscale precipitation discussion polygon',valid_start:p.valid_start,valid_end:p.valid_end,
        fresh_until:end(p.valid_end,mpd.fresh_until),as_of:mpd.checked_at,source_url:p.source_url,status:'current',
        ...totals(reference,hit),mapped_population:null,bands:[],coverage:'Residents within this WPC discussion area. Flash flooding may affect only part of the polygon.'});
    }
  }
  return output;
}

let loaded;
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage=async ({data})=>{
    try {
      loaded ||= (async ()=>{
        const res=await fetch(new URL('./recovery-centers.bin.gz',import.meta.url),{credentials:'omit',signal:AbortSignal.timeout(20000)});
        if (!res.ok) throw Error('Census reference unavailable');
        const bytes=await res.arrayBuffer();
        let raw=bytes;
        if (new Uint8Array(bytes)[0]===0x1f) raw=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
        return readCenters(raw);
      })();
      self.postMessage({id:data.id,groups:calculate(await loaded,data.request)});
    } catch {loaded=null;self.postMessage({id:data.id,groups:null});}
  };
}
