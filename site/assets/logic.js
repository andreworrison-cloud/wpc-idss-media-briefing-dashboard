const hour=3600000, minute=60000;
export const labels={alerts:'NWS active alerts',reports:'NWS local storm reports via IEM',ero:'WPC Excessive Rainfall Outlook',winter:'WPC Winter Storm Severity Index',outlook:'WPC Days 3–7 Hazards Outlook',messages:'WPC and NWC Key Messages'};
export const refs={alerts:'https://www.weather.gov/documentation/services-web-alerts',reports:'https://mesonet.agron.iastate.edu/lsr/',ero:'https://origin-east-www-wpc.woc.noaa.gov/qpf/excess_rain.shtml',winter:'https://www.weather.gov/wssi/',outlook:'https://origin-east-www-wpc.woc.noaa.gov/threats/threats.php',messages:'https://www.wpc.ncep.noaa.gov/'};
export const families=['flood','coastal','winter','wind','severe','heat','cold','fire','tropical','marine','other'];
const codes=new Set('AL AK AS AZ AR CA CO CT DE DC FL GA GU HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND MP OH OK OR PA PR RI SC SD TN TX UT VT VA VI WA WV WI WY'.split(' '));
const age={alerts:30,reports:45,ero:90,winter:180,outlook:240,messages:90};
const flagLabels={'road_closure':'road closure','roads_closed':'road closure','road closure':'road closure','water_rescue':'water rescue','water rescue':'water rescue','rescue':'rescue','evacuation':'evacuation','structural_damage':'structural damage','debris_flow':'debris flow'};
export const isoTime=(v,full=false)=>{const d=new Date(v||'invalid');if(!Number.isFinite(+d))return 'Unknown';const time=String(d.getUTCHours()).padStart(2,'0')+String(d.getUTCMinutes()).padStart(2,'0')+'Z';return full?d.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'})+' '+time:time;};
export const dayName=v=>{const d=new Date(v?.length===10?v+'T12:00:00Z':v||'bad');return Number.isFinite(+d)?d.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}):'Unknown';};
export const total=n=>Number.isFinite(n)?n.toLocaleString('en-US'):'Unavailable';
export const readable=s=>String(s||'').replace(/[_-]/g,' ').replace(/^./,c=>c.toUpperCase());
export const flagText=s=>flagLabels[s]||String(s).replace(/[_-]/g,' ').replace(/ reported$/i,'').toLowerCase();
export function safeURL(value) {
  try{const u=new URL(value);return u.protocol==='https:'&&['weather.gov','noaa.gov','iastate.edu'].some(h=>u.hostname===h||u.hostname.endsWith('.'+h))?u.href:null;}catch{return null;}
}
export function moduleState(board,key,now=Date.now()){
  const val=board?.sources?.[key], h=board?.health?.[key];
  if(!val)return 'unavailable';
  const retrieved=h?.retrieved_at||val.retrieved_at||val.days?.[0]?.retrieved_at;
  const state=h?.status||val.status||(key==='ero'&&val.days?.some(x=>x.status==='current')?'ok':'unavailable');
  if(state==='unavailable'||!Number.isFinite(Date.parse(retrieved)))return 'unavailable';
  if(board.attempts?.[key]?.retained||now-Date.parse(retrieved)>age[key]*minute)return 'stale';
  return state;
}
export const usable=(board,key,now)=>['ok','current'].includes(moduleState(board,key,now));
export function activeDay(board,n,now=Date.now()){
  const day=board?.sources?.ero?.days?.find(d=>d.day===n);
  if(!day||!['ok','partial'].includes(moduleState(board,'ero',now))||day.status!=='current'||!(Date.parse(day.fresh_until)>now&&Date.parse(day.valid_end)>now))return null;
  return day;
}
export function population(board,now=Date.now()){
  const p=board?.sources?.ero?.population,d=activeDay(board,1,now);
  if(!d||p?.status!=='current'||!(Date.parse(p.fresh_until)>now)||p.issued!==d.issued||p.valid_start!==d.valid_start||p.valid_end!==d.valid_end)return null;
  return p;
}
export function currentAlerts(b,now=Date.now()){
  if(!usable(b,'alerts',now))return [];
  return (b.sources.alerts.events||[]).filter(a=>Date.parse(a.effective)<=now&&Date.parse(a.expires)>now&&(!a.ends||Date.parse(a.ends)>now)).map(a=>{
    if(!a.segments?.length)return a;
    const live=a.segments.filter(s=>Date.parse(s.expires)>now&&Date.parse(s.effective)<=now);
    if(live.length===a.segments.length)return a;
    const ugc=live.flatMap(s=>s.ugc), emergency=live.some(s=>s.ffe===true);
    return {...a,segments:live,ugc,states:[...new Set(ugc.map(z=>z.slice(0,2)))],ffe:emergency?true:live.some(s=>s.ffe===null)?null:false,ffe_ugc:live.filter(s=>s.ffe===true).flatMap(s=>s.ugc),area:live.map(s=>s.area).filter(Boolean).join('; '),geometry:[],geometry_status:'Active segment boundary unavailable'};
  }).filter(a=>!Array.isArray(a.segments)||a.segments.length);
}
export const currentReports=(b,hrs=24,now=Date.now())=>usable(b,'reports',now)?(b.sources.reports.events||[]).filter(r=>{const t=Date.parse(r.valid);return t>=now-hrs*hour&&t<=now&&Date.parse(r.issued)<=now;}):[];
export const activeWinter=(b,now=Date.now())=>usable(b,'winter',now)&&Date.parse(b.sources.winter.valid_end)>now&&now-Date.parse(b.sources.winter.issued)<=6*hour?b.sources.winter:null;
export const activeOutlook=(b,now=Date.now())=>usable(b,'outlook',now)&&Date.parse(b.sources.outlook.valid_end_date+'T00:00:00Z')+24*hour>now?b.sources.outlook:null;
export function messageState(b,m,now=Date.now()){
  if(!['ok','partial'].includes(moduleState(b,'messages',now)))return 'unverified';
  if(m.status==='active'&&!(Date.parse(m.valid_end)>now))return 'expired';
  return m.status;
}
export const signed=n=>n>0?'+'+n:String(n);
export function reportValue(r){
  if(r.trace)return 'Trace';
  if(r.magnitude===null||r.magnitude===undefined||!r.unit)return '—';
  let value=total(r.magnitude)+' '+r.unit;
  if(r.qualifier && !/unknown/i.test(r.qualifier))value+=' ('+r.qualifier.toLowerCase()+')';
  if(r.height_ft_agl!=null)value+=' at '+(r.height_estimated?'~':'')+r.height_ft_agl+' ft AGL';
  if(r.accumulation_hours!=null)value+=' in '+r.accumulation_hours+' h';
  return value;
}
export function classifyFamily(item){
  const f=String(item.family||'').toLowerCase(),h=String(item.title||'').toLowerCase();
  if(/extreme cold|cold weather|freeze|frost|wind chill/.test(h))return 'cold';
  if(['rain','hydrology','flood','flooding','precipitation'].includes(f))return 'flood';
  return families.includes(f)?f:'other';
}
export function parseScope(states,wfos){
  const split=s=>[...new Set(String(s||'').toUpperCase().split(/[\s,;]+/).filter(Boolean))];
  const ss=split(states), raw=split(wfos), ws=raw.map(w=>w.length===4&&/^[KPT][A-Z]{3}$/.test(w)?w.slice(1):w);
  if(ss.some(s=>!codes.has(s)))throw Error('Use two-letter state or territory codes. Check '+ss.filter(s=>!codes.has(s)).join(', ')+'.');
  if(ws.some(s=>!/^[A-Z]{3}$/.test(s)))throw Error('Use three-letter WFO identifiers, such as MTR or BOX.');
  return {states:ss,wfos:ws};
}
const matches=(item,scope)=> (!scope.states.length||item.states?.some(st=>scope.states.includes(st)))&&(!scope.wfos.length||scope.wfos.includes(String(item.wfo||'').toUpperCase()))&&(!scope.family||scope.family===classifyFamily(item));
export function priorities(b,now=Date.now()){
  const out=[], reports=currentReports(b,24,now), alerts=currentAlerts(b,now);
  const wpc=(b.sources.messages?.items||[]).find(m=>m.owner==='WPC'&&messageState(b,m,now)==='active');
  const emergency=alerts.find(a=>a.ffe===true), impact=reports.find(r=>r.impact_flags?.some(f=>/rescu|evacuat|debris|inundat|road.*clos|road.*impass|structure/i.test(f)));
  const warn=emergency||alerts.find(a=>a.severity==='Extreme'&&/Warning|Emergency/i.test(a.title))||
    alerts.find(a=>a.severity==='Severe'&&/Warning/i.test(a.title));
  if(emergency)out.push({tag:'Active warning',title:emergency.title,body:emergency.area,link:emergency.source_url,label:'Read NWS warning',color:'#a53a2c'});
  if(wpc)out.push({tag:'WPC Key Messages',title:wpc.title.replace(/^Key Messages (?:for|on) (?:the )?/i,''),body:wpc.summary||'WPC has issued Key Messages for this event.',link:wpc.source_url,label:'View official graphic',color:'#075f81'});
  if(impact)out.push({tag:'Observed impact',title:impact.title+' · '+[impact.city,impact.state].filter(Boolean).join(', '),body:'A preliminary NWS report mentions '+impact.impact_flags.map(flagText).join(' and ')+'. Observed '+isoTime(impact.valid,true)+'.',link:impact.source_url,label:'Read storm report',color:'#9a4a25'});
  if(!emergency&&warn)out.push({tag:'Active warning',title:warn.title+(warn.states?.length?' · '+warn.states.join(', '):''),body:warn.area||warn.headline,link:warn.source_url,label:'Read NWS alert',color:'#93501a'});
  const er=activeDay(b,1,now), wi=activeWinter(b,now);
  if(er?.highest_risk&&!er.no_risk_area)out.push({tag:'Rainfall forecast',title:er.highest_risk+' Risk of excessive rainfall',body:'Day 1 WPC outlook, valid '+isoTime(er.valid_start,true)+' to '+isoTime(er.valid_end,true)+'.',link:refs.ero,label:'Open WPC outlook',color:'#397233'});
  if(wi?.highest_impact)out.push({tag:'Winter forecast',title:wi.highest_impact+' winter impacts in the WSSI',body:'Days 1–3 overall index, valid through '+isoTime(wi.valid_end,true)+'.',link:refs.winter,label:'Open WSSI',color:'#6a428b'});
  if(!impact&&reports[0]){const r=reports[0];out.push({tag:'Latest observation',title:r.title+' · '+r.city+', '+r.state,body:'Preliminary NWS report at '+isoTime(r.valid,true)+'.',link:r.source_url,label:'Read storm report',color:'#08716e'});}
  return out.slice(0,3);
}
export function makeBrief(board,scope,now=Date.now()){
  const scoped=!!(scope.states.length||scope.wfos.length), hrs=scope.hours;
  const alerts=currentAlerts(board,now).filter(r=>matches(r,scope)).map(a=>{
    if(!scope.states.length||!a.segments?.length)return a;
    const regional=a.segments.filter(seg=>seg.ugc.some(z=>scope.states.includes(z.slice(0,2))));
    const emergency=regional.some(seg=>seg.ffe===true);
    const geography=regional.flatMap(seg=>seg.ugc.filter(z=>scope.states.includes(z.slice(0,2))));
    return {...a,ffe:emergency?true:regional.some(s=>s.ffe===null)?null:false,area:geography.join(', '),states:[...new Set(geography.map(z=>z.slice(0,2)))]};
  });
  const reports=currentReports(board,hrs,now).filter(r=>matches(r,scope));
  const who=[scope.states.join(', '),scope.wfos.map(s=>s+' WFO').join(', ')].filter(Boolean).join(' · ')||'United States';
  const sections=[], evidence=[],seen=new Map();
  const cite=(label,url)=>{const link=safeURL(url);if(!link)return '';if(!seen.has(link)){seen.set(link,evidence.length+1);evidence.push({label,url:link});}return ' ['+seen.get(link)+']';};
  const alertLines=[], obs=[], forecast=[], review=[];
  if(usable(board,'alerts',now)){
    const unique=alerts.filter(a=>a.unit==='VTEC warning');
    const cap=alerts.filter(a=>a.unit==='CAP message').length;
    if(scoped||scope.family)alertLines.push(cap+' matching CAP message'+(cap===1?'':'s')+' in the alert list. Distinct flash-flood warning events are listed separately where identified.'+cite('NWS alert feed',board.sources.alerts.source_url));
    else alertLines.push('At '+isoTime(board.sources.alerts.retrieved_at,true)+', the national NWS collection showed '+total(board.sources.alerts.ffw_count)+' active flash flood warnings'+(Number.isInteger(board.sources.alerts.ffe_count)?', including '+total(board.sources.alerts.ffe_count)+' flash flood emergencies.':'. The flash flood emergency count requires review.')+cite('NWS active alert feed',board.sources.alerts.source_url));
    if((scoped||scope.family)&&unique.length)alertLines.push(unique.length+' reconciled flash flood warning event'+(unique.length===1?'':'s')+' matched the selection.');
    for(const a of alerts.filter(a=>/warning|emergency/i.test(a.title)).slice(0,2))alertLines.push(a.title+' for '+(a.area||a.states.join(', ')||'the source area')+'. NWS message expires '+isoTime(a.expires,true)+'.'+cite(a.headline||a.title,a.source_url));
  }else alertLines.push('The current NWS alert count is unavailable for this brief.');
  const sound=[];
  const nationalMessage=(!scoped&&!scope.family)?(board.sources.messages?.items||[]).find(m=>m.owner==='WPC'&&messageState(board,m,now)==='active'&&m.summary):null;
  if(nationalMessage)sound.push('WPC’s '+nationalMessage.title.replace(/^Key Messages for (?:the )?/i,'')+' briefing highlights the following forecast. “'+nationalMessage.summary.replace(/[.\s]+$/,'')+'.”'+cite(nationalMessage.title,nationalMessage.source_url));
  if(!nationalMessage){
    const warn=alerts.find(a=>a.ffe===true)||alerts.find(a=>/Warning/i.test(a.title));
    if(warn)sound.push('The National Weather Service has a '+warn.title.toLowerCase()+' in effect for '+(warn.area||warn.states.join(', ')||'the area listed in the warning')+'.'+cite(warn.headline||warn.title,warn.source_url));
    const obs=reports.find(r=>r.impact_flags?.length)||reports[0];
    if(obs)sound.push('A preliminary NWS report places '+obs.title.toLowerCase()+' near '+obs.city+', '+obs.state+', at '+isoTime(obs.valid,true)+'.'+cite('NWS '+obs.wfo+' preliminary report',obs.source_url));
  }
  if(!sound.length)sound.push('Source coverage does not support an on-air statement for this selection yet.');
  sections.push({title:'On-air draft',lines:sound},{title:'Active warnings and alerts',lines:alertLines});
  if(usable(board,'reports',now)){
    obs.push(total(reports.length)+' preliminary storm report'+(reports.length===1?'':'s')+' matched the '+hrs+'-hour observation window ending '+isoTime(now,true)+' and the selected filters. Local offices may add or correct reports.'+cite('IEM public archive of NWS local storm reports',refs.reports));
    const sorted=[...reports].sort((a,b)=>Number(Boolean(b.impact_flags?.length))-Number(Boolean(a.impact_flags?.length))||Date.parse(b.valid)-Date.parse(a.valid));
    for(const r of sorted.slice(0,3)){
      let s=r.title+' was reported near '+[r.city,r.state].filter(Boolean).join(', ')+' at '+isoTime(r.valid,true)+'.';
      if(r.impact_flags?.length)s+=' The report mentions '+r.impact_flags.map(flagText).join(' and ')+'.';
      if(reportValue(r)!=='—')s+=' Reported value '+reportValue(r)+'.';
      obs.push(s+cite('NWS '+r.wfo+' · '+r.title+' · '+isoTime(r.issued,true),r.source_url));
    }
  }else obs.push('Recent local storm reports could not be verified for the selected window.');
  sections.push({title:'Reported impacts',lines:obs});
  const day=activeDay(board,1,now),p=population(board,now), w=activeWinter(board,now),o=activeOutlook(board,now);
  if(!scoped&&(!scope.family||scope.family==='flood')&&day){
    forecast.push((day.no_risk_area?'WPC delineates no Day 1 excessive rainfall risk area.':'The highest Day 1 excessive rainfall category is '+day.highest_risk+' Risk.')+' The outlook is valid '+isoTime(day.valid_start,true)+' to '+isoTime(day.valid_end,true)+'.'+cite('WPC Day 1 Excessive Rainfall Outlook',refs.ero));
    const band=p?.bands?.find(row=>row.risk===day.highest_risk);
    if(band)forecast.push('WPC estimates '+total(band.population)+' people across all '+band.risk+' Risk areas in the contiguous U.S. This is forecast exposure, using '+p.basis+'.'+cite('WPC national Day 1 exposure table',p.source_url));
  }
  if(!scoped&&(!scope.family||scope.family==='winter')&&w?.highest_impact)forecast.push('The highest Days 1–3 WSSI category in the issued forecast is '+w.highest_impact+' in the contiguous U.S. The forecast period ends '+isoTime(w.valid_end,true)+'.'+cite('WPC Winter Storm Severity Index',refs.winter));
  if(!scoped&&!scope.family&&o)forecast.push('The WPC medium-range hazards outlook covers '+dayName(o.valid_start_date)+' through '+dayName(o.valid_end_date)+'.'+cite('WPC Days 3–7 Hazards Outlook',o.source_url));
  if(scoped)forecast.push('Use the official outlook map to verify local overlap. An event-specific resident exposure estimate is unavailable for this selection.'+cite('WPC official forecast products',refs.messages));
  if(!forecast.length)forecast.push('Review the official forecast for the selected hazard and valid period.'+cite('WPC official forecast products',refs.messages));
  sections.push({title:'Forecast and population exposure',lines:forecast});
  if(!scoped&&!scope.family){const msg=(board.sources.messages?.items||[]).find(m=>m.owner==='WPC'&&messageState(board,m,now)==='active');if(msg)review.push('WPC’s “'+msg.title+'” was issued '+isoTime(msg.issued_at,true)+' and expires '+isoTime(msg.valid_end,true)+'.'+cite(msg.title,msg.source_url));}
  if(scoped||scope.family)review.push('Confirm which WPC or NWC Key Messages apply to this event before using them on air.'+cite('Weather Prediction Center',refs.messages));
  if(!review.length)review.push('Check the official WPC and NWC event material for messaging updates.'+cite('Weather Prediction Center',refs.messages));
  sections.push({title:'Messaging to review',lines:review});
  return {title:scope.name||'National weather briefing',area:who,scope:scope.family?readable(scope.family):'All hazards',window:hrs,asof:isoTime(now,true),snapshot:isoTime(board.captured_at,true),sections,evidence};
}
