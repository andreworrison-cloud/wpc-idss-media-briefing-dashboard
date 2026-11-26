import {currentAlerts,moduleState} from './logic.js';
import {resolveAlertZones} from './alert-zones.js';
import {alertStyle} from './hazard-palette.js';
const minute=60000,hour=60*minute;
const iso=t=>new Date(t).toISOString();
const good=s=>['ok','current','partial'].includes(s);
const titles=['Blizzard Warning','Snow Squall Warning','Ice Storm Warning','Winter Storm Warning','Lake Effect Snow Warning','Winter Weather Advisory','Winter Storm Watch'];
const zonePattern=/^https:\/\/api\.weather\.gov\/zones\/(?:forecast|public)\/([A-Z]{2}Z\d{3})$/;
const activeProduct='https://api.weather.gov/products/types/FFG/locations/MPD';
const metwatch='https://www.wpc.ncep.noaa.gov/metwatch/metwatch_mpd.php';
const dateMin=(...times)=>Math.min(...times.filter(t=>Number.isFinite(Date.parse(t))).map(Date.parse));
const arrayGeometry=g=>Array.isArray(g)?g:g?[g]:[];
const zoneMemory=new Map(), failedZones=new Map(), bulletinMemory=new Map();

function savedZones(old,now) {
  const zones=new Map();
  for(const f of old?.features||[]) {
    const p=f.properties||{},code=zonePattern.exec(p.zone_url)?.[1];
    if(code&&code===p.ugc&&['Polygon','MultiPolygon'].includes(f.geometry?.type)&&
       Date.parse(p.zone_valid_from)<=now&&now<Date.parse(p.zone_valid_until)) {
      zones.set(p.zone_url,{geometry:f.geometry,info:{ugc:code,name:p.name,type:'public',source_url:p.zone_url,valid_from:p.zone_valid_from,valid_until:p.zone_valid_until}});
    }
  }
  return zones;
}
export async function recoverWinter(board,now,fetcher,loadMissing=true) {
  if(!good(moduleState(board,'alerts',now)))return null;
  const retrieved=board.health.alerts.retrieved_at, caps=currentAlerts(board,now).filter(a=>titles.includes(a.title));
  const oldWinter=board.weather?.winter,old=oldWinter?.layers?.find(l=>l.id==='winter_alerts');
  const zones=savedZones(old,now), requests=new Map();
  // Warnings receive the bounded request budget first. Reused public boundaries must cover this source time.
  const priority=caps.slice().sort((a,b)=>Number(/Advisory/i.test(a.title))-Number(/Advisory/i.test(b.title)));
  for(const a of priority) {
    if(arrayGeometry(a.geometry).length||a.unit!=='CAP message'||a.title==='Snow Squall Warning')continue;
    for(const u of a.zone_urls||[]) {
      const z=zonePattern.exec(u)?.[1];
      if(z&&a.ugc?.includes(z)&&!zones.has(u)&&!requests.has(u)) {
        const saved=zoneMemory.get(u);
        if(saved&&Date.parse(saved.info.valid_from)<=now&&now<Date.parse(saved.info.valid_until))zones.set(u,saved);
        else if(!failedZones.has(u)||now-failedZones.get(u)>30*minute)requests.set(u,a);
      }
    }
  }
  if(loadMissing) {
    const pending=[...requests].slice(0,10);
    for(let i=0;i<pending.length;i+=4)await Promise.all(pending.slice(i,i+4).map(async ([u,a])=>{
      const code=zonePattern.exec(u)[1], result=await resolveAlertZones({...a,zone_urls:[u],ugc:[code]},now,fetcher);
      if(result.status==='ok'&&result.zones.length===1&&result.geometry.length===1) {
        const data={geometry:result.geometry[0],info:result.zones[0]};zones.set(u,data);
        if(zoneMemory.size>=200)zoneMemory.delete(zoneMemory.keys().next().value);
        zoneMemory.set(u,data);failedZones.delete(u);
      }else{
        if(failedZones.size>=200)failedZones.delete(failedZones.keys().next().value);
        failedZones.set(u,now);
      }
    }));
  }
  const features=[],events=[],levels=new Map(),zoneEditions={};
  const lastVerified=board.impacts?.exposure?.coverage?.forecast_zones;
  if(lastVerified?.status==='verified'&&/^\d{4}-\d{2}-\d{2}$/.test(lastVerified.effective)) {
    // A zone geometry in effect both on the frozen edition and at collection has the same official version.
    const edition=Date.parse(lastVerified.effective+'T23:59:59Z');
    for(const z of zones.values()) {
      if(Date.parse(z.info.valid_from)<=edition&&Date.parse(z.info.valid_until)>edition)zoneEditions[z.info.ugc]=lastVerified.effective;
    }
  }
  let missingCount=0;
  for(const a of caps) {
    const property={event_id:a.id,event:a.title,issued:a.sent,effective:a.effective,onset:a.onset,valid_start:a.effective,
      valid_end:iso(dateMin(a.expires,a.ends)),source_url:a.source_url,area:a.area,office:a.office||a.wfo,family:'Winter',color:alertStyle(a.title).color,label:a.title,hazard:a.title};
    const g=arrayGeometry(a.geometry).filter(g=>['Polygon','MultiPolygon'].includes(g?.type)), missing=new Set(a.ugc||[]);
    if(g.length&&a.geometry_status==='source polygon') {
      for(const geometry of g)features.push({type:'Feature',geometry,properties:{...property,geometry_basis:'NWS CAP polygon'}});
      missing.clear();
    }else if(a.title!=='Snow Squall Warning'){
      for(const u of new Set(a.zone_urls||[])) {
        const z=zones.get(u);
        if(!z||!missing.has(z.info.ugc))continue;
        missing.delete(z.info.ugc);
        features.push({type:'Feature',geometry:z.geometry,properties:{...property,geometry_basis:'NWS forecast zone',ugc:z.info.ugc,
          name:z.info.name,zone_url:u,zone_valid_from:z.info.valid_from,zone_valid_until:z.info.valid_until}});
      }
    }
    const missingArea=missing.size||(!g.length&&!a.ugc?.length);
    if(missingArea)missingCount++;
    levels.set(a.title,(levels.get(a.title)||0)+1);
    events.push({...property,id:a.id,title:a.title,states:a.states,ugc:a.ugc,zone_urls:a.zone_urls,ends:a.ends,expires:a.expires,
      geometry:g.length&&a.geometry_status==='source polygon'?g:null,geometry_status:g.length&&a.geometry_status==='source polygon'?'source polygon':missingArea?'partial zone geometry':'verified NWS zones',missing_geometry_ugc:[...missing]});
  }
  const status=missingCount||moduleState(board,'alerts',now)==='partial'?'partial':events.length?'ok':'none';
  const layer={...old,id:'winter_alerts',title:'NWS winter warnings, watches and advisories',family:'Winter',kind:'geojson',source_url:'https://www.weather.gov/',
    source_gis_url:'https://api.weather.gov/alerts/active',scope:'National including Alaska, Hawaii and U.S. territories',product:'NWS active CAP messages',style:'fill',
    legend:titles.map(label=>({label,color:alertStyle(label).color})),status,features,events,feature_count:features.length,event_count:events.length,
    retrieved_at:retrieved,source_time:board.sources.alerts.source_time,issued:board.sources.alerts.source_time,valid_start:retrieved,
    valid_end:events.length?iso(Math.max(...events.map(e=>Date.parse(e.valid_end)))):iso(Date.parse(retrieved)+30*minute),fresh_until:iso(Date.parse(retrieved)+30*minute),
    zone_count:features.filter(f=>f.properties.ugc).length,levels:[...levels].map(([label,count])=>({label,count,color:alertStyle(label).color})),
    issues:missingCount?[missingCount+' current issuances have incomplete boundaries.']:[]};
  const wssi=board.sources.winter,currentIssued=good(moduleState(board,'winter',now))?Date.parse(wssi?.issued):NaN;
  const other=(oldWinter?.layers||[]).filter(l=>l.id!=='winter_alerts').map(l=>
    l.id==='wssi_d1_3'&&currentIssued>Date.parse(l.issued)?{...l,status:'stale',issues:['WPC has issued a newer overall WSSI.']} : l);
  return {winter:{...oldWinter,retrieved_at:retrieved,status:other.some(l=>!good(l.status)&&l.status!=='none')||status==='partial'?'partial':'ok',layers:[layer,...other]},layer,zoneEditions};
}

const monthTime=(ddhhmm,near)=>{
  const d=new Date(near), day=Number(ddhhmm.slice(0,2)), h=Number(ddhhmm.slice(2,4)), m=Number(ddhhmm.slice(4));
  if(day<1||day>31||h>23||m>59)throw Error('Invalid MPD time');
  const dates=[-1,0,1].map(offset=>Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+offset,day,h,m)).filter(t=>new Date(t).getUTCDate()===day);
  return dates.sort((a,b)=>Math.abs(a-near)-Math.abs(b-near))[0];
};
const distance=(a,b)=>{
  const radians=Math.PI/180, phi=a[1]*radians, psi=b[1]*radians;
  return 12742*Math.asin(Math.min(1,Math.sqrt(Math.sin((psi-phi)/2)**2+Math.cos(phi)*Math.cos(psi)*Math.sin((b[0]-a[0])*radians/2)**2)));
};
function bulletinFeature(data,row,now){
  if(data?.['@id']!==row['@id']||data.issuingOffice!=='KWNH'||data.productCode!=='FFG'||data.wmoCollectiveId!=='AWUS01'||
    Date.parse(data.issuanceTime)!==Date.parse(row.issuanceTime)||!/^FFGMPD\s*$/m.test(data.productText||''))throw Error('Unmatched MPD');
  const full=data.productText, h=[...full.matchAll(/^\s*Mesoscale Precipitation Discussion\s+(\d{1,4})\b/gim)].at(-1);
  if(!h)throw Error('Missing discussion number');
  const body=full.slice(h.index), when=/\bValid\s+(\d{6})Z?\s*[-–]\s*(\d{6})Z?\b/i.exec(body);
  if(!when)throw Error('Missing discussion validity');
  const issued=Date.parse(row.issuanceTime), start=monthTime(when[1],issued),end=monthTime(when[2],start);
  if(!(end>start&&end-start<=24*hour&&Math.abs(start-issued)<24*hour))throw Error('Invalid discussion validity');
  const num=h[1].padStart(4,'0'),year=new Date(issued).getUTCFullYear(), key=year+'-'+num;
  const cancelled=/\b(?:this\s+(?:MPD|discussion)\s+(?:is|has been)\s+cancel(?:l)?ed|cancel(?:l)?ed\s+(?:this\s+)?MPD)\b/i.test(body);
  if(now<start||now>=end||cancelled)return {key,issued,start,end,cancelled,feature:null};
  const clean=s=>s?.replace(/\s+/g,' ').trim().replace(/^[ .]+|[ .]+$/g,'');
  const areas=clean(/\bAreas affected\.{3}([\s\S]*?)(?=\s+Concerning\.{3})/i.exec(body)?.[1]);
  const tag=clean(/\bConcerning\.{3}([\s\S]*?)(?=\s+Valid\s+\d{6})/i.exec(body)?.[1]);
  const latlon=[...body.matchAll(/LAT\.{3}LON[ \t]+((?:\d{8,9}\b[ \t\r\n]*){3,})/gi)].at(-1);
  if(!areas||areas.length>650||!tag||tag.length>300||!latlon)throw Error('Unverified discussion fields');
  const ring=[];
  for(const code of latlon[1].trim().split(/\s+/)) {
    const lat=Number(code.slice(0,4))/100;
    let lon=Number(code.slice(4))/100;
    if(code.length===8&&(lon<40||lon<80&&(lat>=49||/\b(ALASKA|ALEUTIAN|KODIAK|KENAI|ANCHORAGE)\b/i.test(body))||lon>=50&&lon<70&&/\b(HAWAI[Iʻ’']*I?|KAUAI|OAHU|MAUI|MOLOKAI|LANAI|BIG ISLAND)\b/i.test(body)))lon+=100;
    if(!(lat>0&&lat<90&&lon>0&&lon<=180))throw Error('Invalid discussion coordinate');
    if(ring.at(-1)?.[0]!==-lon||ring.at(-1)?.[1]!==lat)ring.push([-lon,lat]);
  }
  if(ring[0]?.join()!==ring.at(-1)?.join())ring.push(ring[0]);
  const area=ring.slice(1).reduce((s,p,i)=>s+(ring[i][0]*p[1]-p[0]*ring[i][1]),0);
  if(ring.length<4||Math.abs(area)<1e-9||ring.slice(1).some((p,i)=>distance(p,ring[i])>1800))throw Error('Invalid discussion geometry');
  const officeRaw=/^\s*ATTN\.{3}\s*WFO\.{3}(.*(?:\r?\n(?:(?:[A-Z]{3}\.{2,})+).*)?)/im.exec(body)?.[1]||'';
  const wfos=[...new Set(officeRaw.match(/\b[A-Z]{3}\b/g)||[])];
  const before=full.slice(0,h.index).split(/^FFGMPD\s*$/m).at(-1), states=[...new Set(before.split(/\r?\n/).filter(l=>/^(?:[A-Z0-9>]+-)+$/.test(l.trim())).flatMap(l=>[...l.matchAll(/(?:^|-)([A-Z]{2})[CZ]\d{3}/g)].map(m=>m[1])))];
  const properties={number:num,year,tag,areas,issued:iso(issued),valid_start:iso(start),valid_end:iso(end),
    source_url:'https://www.wpc.ncep.noaa.gov/metwatch/metwatch_mpd_multi.php?md='+num+'&yr='+year,
    nws_product_url:row['@id'],geometry_source:'WPC bulletin LAT...LON',states,wfos};
  return {key,issued,start,end,feature:{type:'Feature',geometry:{type:'Polygon',coordinates:[ring]},properties}};
}
export async function recoverDiscussions(old,read,now) {
  const data=await read(activeProduct,1500000), list=data?.['@graph'];
  if(!Array.isArray(list)||data.pagination?.next||list.some(r=>r?.wmoCollectiveId!=='AWUS01'||r.issuingOffice!=='KWNH'||r.productCode!=='FFG'||
     !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(r.id)||r['@id']!=='https://api.weather.gov/products/'+r.id||
     !Number.isFinite(Date.parse(r.issuanceTime))||Date.parse(r.issuanceTime)>now+2*minute))return old;
  const sorted=list.slice().sort((a,b)=>Date.parse(b.issuanceTime)-Date.parse(a.issuanceTime));
  const window=sorted.filter(r=>Date.parse(r.issuanceTime)>=now-48*hour);
  let partial=window.length>8||(list.length>=50&&window.length===list.length);
  let lastUnread=0;
  const jobs=window.slice(0,8), current=new Map(), cached=new Map((old?.features||[]).map(f=>[f.properties?.nws_product_url,f]));
  // Each official NWS product ID denotes one immutable rendition, including corrections.
  for(let i=0;i<jobs.length;i+=4) {
    await Promise.all(jobs.slice(i,i+4).map(async row=>{
      try {
        const previous=cached.get(row['@id']), p=previous?.properties;
        let entry;
        if(p&&Date.parse(p.issued)===Date.parse(row.issuanceTime)&&Date.parse(p.valid_start)<=now&&now<Date.parse(p.valid_end))
          entry={key:p.year+'-'+p.number,issued:Date.parse(p.issued),feature:previous};
        else {
          const memo=bulletinMemory.get(row['@id']);
          if(memo&&memo.issued===Date.parse(row.issuanceTime)&&(memo.feature||memo.cancelled||now<memo.start||now>=memo.end))
            entry=now<memo.start||now>=memo.end?{...memo,feature:null}:memo;
          else {
            entry=bulletinFeature(await read(row['@id'],800000),row,now);
            if(bulletinMemory.size>=24)bulletinMemory.delete(bulletinMemory.keys().next().value);
            bulletinMemory.set(row['@id'],entry);
          }
        }
        if(!current.has(entry.key)||current.get(entry.key).issued<entry.issued)current.set(entry.key,entry);
      }catch{partial=true;lastUnread=Math.max(lastUnread,Date.parse(row.issuanceTime));}
    }));
  }
  const features=[...current.values()].filter(v=>v.feature&&v.issued>=lastUnread).sort((a,b)=>b.issued-a.issued).map(v=>v.feature);
  // A sole NWS distribution inventory can confirm an active bulletin. A quiet list alone cannot establish an all-clear.
  const quiet=!features.length;
  if(quiet&&!partial&&old?.explicit_no_mpd===true&&old.count===0&&Date.parse(old.fresh_until)>now)return old;
  return {...old,label:'Mesoscale Precipitation Discussions',source_url:metwatch,inventory_url:activeProduct,
    status:partial||quiet?'partial':'current',checked_at:iso(now),fresh_until:iso(Math.min(now+10*minute,...features.map(f=>Date.parse(f.properties.valid_end)))),
    count:partial||quiet?null:features.length,features,explicit_no_mpd:false,
    reason:quiet?'No current polygon was verified in the NWS distribution inventory. Check the WPC active discussion index.':
      partial?'Available WPC discussion polygons verified against NWS distribution. Inventory coverage is partial.':'Active WPC bulletins verified against NWS distribution.',
    latest_official_distribution:sorted[0]?.issuanceTime||null,source_notes:[]};
}
