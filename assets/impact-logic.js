export const links = {
  power: 'https://poweroutmap.com/', powerTracker: 'https://poweroutage.us/',
  aviation: 'https://nasstatus.faa.gov/', flights: 'https://www.flightaware.com/live/cancelled/today/US',
  census: 'https://www.census.gov/geographies/reference-files/2020/geo/2020-centers-population.html',
  rivers: 'https://water.noaa.gov/', reports: 'https://mesonet.agron.iastate.edu/lsr/',
};
export const countText = n => Number.isFinite(n) ? n.toLocaleString('en-US') : 'Unavailable';
export const impactNames = {rescue:'Rescue', structuralDamage:'Structural damage', strandedVehicle:'Stranded vehicle', roadClosure:'Road closure'};
export const gaugeColors = {major:'#CC33FF', moderate:'#FF0000', minor:'#FF9900'};
const mins = 60000;
export function recent(time, now, minutes) {
  const age = now - Date.parse(time);
  return Number.isFinite(age) && age >= -2 * mins && age <= minutes * mins;
}
export function freshImpact(value, now = Date.now(), minutes = 45) {
  if (!value || !['ok','current','partial'].includes(value.status)) return false;
  return recent(value.as_of || value.asOf || value.calculated_at || value.checkedAt, now, minutes);
}
export const activeAirEvents = (a, now = Date.now()) => freshImpact(a, now, 30) ? (a.events || []).filter(e => (!e.start_utc || Date.parse(e.start_utc) <= now) && (!e.end_utc || Date.parse(e.end_utc) > now)) : [];
export const currentRivers = (r, now = Date.now()) => freshImpact(r,now,60) ? (r.sites || []).filter(s => recent(s.observedAt,now,60 * r.periodHours)) : [];
export const currentGroundReports = (r, now = Date.now()) => freshImpact(r,now,60) ? (r.items || []).filter(s => recent(s.observedAt,now,60 * r.periodHours)) : [];
export function exposureRecords(board, now = Date.now()) {
  const exposure = board?.impacts?.exposure;
  if (!exposure || !recent(exposure.calculated_at,now,50)) return [];
  const live=r=>(!r.valid_end || Date.parse(r.valid_end)>now) && (!r.fresh_until || Date.parse(r.fresh_until)>now);
  const groups=Object.entries(exposure.groups||{}).flatMap(([group,records])=>(Array.isArray(records)?records:[]).filter(live).map(r=>({...r,group})));
  const byId=new Map((board.sources?.alerts?.events||[]).map(a=>[a.id,a]));
  const events=Object.values(exposure.alert_events||{}).filter(live).map(r=>{
    const a=byId.get(r.id);const area=a?.area||a?.states?.join(', ')||a?.wfo||'';
    return {...r,group:'alerts',alert_ids:[r.id],isEvent:true,menuLabel:(r.label||a?.title||'Warning')+' · '+(area.length>86?area.slice(0,84)+'…':area)};
  });
  return [...groups,...events];
}
export function residentCount(record, states = [], band = null) {
  const source = band || record;
  if (!record || !Number.isFinite(source?.population)) return null;
  if (!states.length) return source.population;
  const rows = source.states;
  if (!Array.isArray(rows)) return null;
  const matched = rows.filter(x=>states.includes(x.code));
  // A missing jurisdiction in a partial footprint can have residents outside the available geometry.
  if (!matched.length && record.status !== 'ok' && record.status !== 'current') return null;
  return matched.reduce((sum,row)=>sum + row.population, 0);
}
const airportDetail = e => [e.label,e.delay,e.reason].filter(Boolean).join(' · ');
export function addImpactEvidence(board, scope, now, cite, time) {
  const impact=board.impacts;
  const lines=[], exposureLines=[];
  if (!impact) return {lines,exposureLines};
  const states=scope.states, local=states.length>0, offices=scope.wfos.length>0;
  const inArea = item => !local || states.includes(item.state);
  if (!offices && !scope.family) {
    const p=impact.power;
    if (freshImpact(p,now,35)) {
      if (local && p.states_status==='current' && recent(p.states_as_of,now,35)) {
        for (const s of (p.states||[]).filter(inArea).filter(s=>Number.isFinite(s.customers_out))) lines.push('Power Out Map reported '+countText(s.customers_out)+' electric customer accounts without power in '+s.name+' at '+time(p.states_as_of,true)+', across reporting utilities.'+cite('Power Out Map · utility outages',links.power));
      } else if (!local && Number.isFinite(p.customers_out)) lines.push('At '+time(p.as_of,true)+', reporting utilities listed '+countText(p.customers_out)+' U.S. electric customer accounts without power from all causes.'+cite('Power Out Map · utility outages',links.power));
    }
    const a=impact.aviation;
    for (const e of activeAirEvents(a,now).filter(inArea).filter(e=>e.delay||['ground_stop','airport_closure'].includes(e.kind)).slice(0,2)) lines.push('FAA listed '+airportDetail(e)+' at '+e.airport_name+' ('+e.airport+') as of '+time(a.as_of,true)+'.'+cite('FAA National Airspace System Status',links.aviation));
  }
  if (!offices && (!scope.family || scope.family==='flood')) {
    const r=currentRivers(impact.ground?.rivers,now).filter(inArea)[0];
    if(r) lines.push(r.name+', '+r.state+', reported '+r.category+' flooding at '+time(r.observedAt,true)+(Number.isFinite(r.value)?' with an observed gauge reading of '+r.value+' '+r.unit:'')+'.'+cite('NWPS gauge '+r.id,r.url));
  }
  if (!offices) {
    const records=exposureRecords(board,now).filter(r=>(scope.exposure_id?r.id===scope.exposure_id:!r.isEvent)&&['ok','current','partial'].includes(r.status)&&(scope.exposure_id||!scope.family || (r.group==='ero'&&scope.family==='flood') || (r.group==='winter'&&scope.family==='winter') || r.family?.toLowerCase()===scope.family));
    for (const r of records) {
      const band=scope.exposure_id&&scope.band_id?r.bands?.find(b=>b.id===scope.band_id):null;
      const n=residentCount(r,states,band);
      if(n==null || (n===0&&!scope.exposure_id)) continue;
      const geography=local?' in '+states.join(', '):'';
      exposureLines.push('An estimated '+countText(n)+' residents'+geography+' live inside the mapped '+r.label+' area'+(band?' in the '+band.label+' category':'')+(r.valid_end?', valid through '+time(r.valid_end,true):'')+'. '+(r.status==='partial'?'Only resolved geography is counted. ':'')+(r.basis&&/zone/i.test(r.basis)?'This count covers the full warning zone. ':'')+(n===0?'No populated Census center matched. ':'')+'Estimate uses 2020 Census block-group population centers.'+cite('2020 Census resident population centers',links.census)+(r.source_url?' '+cite(r.label,r.source_url):''));
      if(exposureLines.length>=2)break;
    }
  }
  return {lines,exposureLines};
}
