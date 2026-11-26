import {activeAirEvents, gaugeColors, recent} from './impact-logic.js';

const number = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', {notation:'compact', maximumSignificantDigits:3});
const utc = new Intl.DateTimeFormat('en-GB', {
  day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', hourCycle:'h23', timeZone:'UTC'
});
const verified = new Set(['ok','current','partial']);
const count = value => Number.isSafeInteger(value) && value >= 0;
const svgNS = 'http://www.w3.org/2000/svg';

function sourceState(source, stamp, now, ageMinutes, deadline) {
  if (source?.status === 'stale') return 'stale';
  if (!verified.has(source?.status) || !Number.isFinite(Date.parse(stamp))) return 'unavailable';
  if (!recent(stamp, now, ageMinutes) || deadline && !(Date.parse(deadline) > now)) return 'stale';
  return source.status === 'partial' ? 'partial' : 'current';
}

function card(key, icon, label, source, stamp, status) {
  return {key, icon, label, source, stamp, status, n:null, minimum:false, chart:null,
    context:status === 'stale' ? 'Source update overdue' : 'Current figure unavailable', caption:''};
}

function stateRows(rows, key, code) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => count(row?.[key]) && row[key] > 0 && row[code])
    .map(row => ({label:row[code], value:row[key]}))
    .sort((a,b) => b.value-a.value || a.label.localeCompare(b.label));
}

function exposureCard(board, focus, now) {
  const source = board?.impacts?.exposure;
  const stamp = focus?.asOf || source?.calculated_at;
  let status = sourceState(source, source?.calculated_at, now, 50, focus?.freshUntil);
  if (focus?.validEnd && Date.parse(focus.validEnd) <= now) status = 'stale';
  const out = card('exposure','people','Residents in hazard area','Census estimate',stamp,status);
  if (status === 'stale' || status === 'unavailable') return out;
  if (!focus || !count(focus.population)) {
    out.status = 'unavailable';
    out.context = focus?.label || 'No selected hazard footprint';
    return out;
  }
  out.n = focus.population;
  out.context = focus.label;
  if (focus.geometryComplete === false) {
    out.status = 'partial';
    out.context += ' · Partial map coverage';
  }
  if (!out.n) {
    out.caption = 'No populated Census center inside';
    return out;
  }
  const rows = stateRows(focus.states,'population','code');
  if (!rows.length) return out;
  const top = rows.slice(0,3);
  const total = rows.reduce((n,r)=>n+r.value,0);
  // Use a share of the full estimate only when the jurisdiction counts reconcile.
  if (total === out.n) {
    const remainder = total-top.reduce((n,r)=>n+r.value,0);
    if (remainder) top.push({label:'Other states and territories',value:remainder});
    out.chart = {type:'stack', title:'Estimated residents by state or territory', rows:top};
    out.caption = top.slice(0,2).map(r => r.label+' '+number.format(r.value)).join(' · ');
  } else {
    out.chart = {type:'bars', title:'Largest available state population estimates', rows:top};
    out.caption = 'Largest estimate · '+top[0].label+' '+number.format(top[0].value);
  }
  return out;
}

function powerCard(power, now) {
  const status = sourceState(power,power?.as_of,now,35,power?.stale_after);
  const out = card('power','power','Customers without power','Power Out Map',power?.as_of,status);
  if (status === 'stale' || status === 'unavailable') return out;
  if (!count(power.customers_out) || (power.customers_out === 0 && !(power.customers_tracked > 0 && power.reporting_utilities > 0))) {
    out.status='unavailable';
    return out;
  }
  out.n=power.customers_out;
  out.context='U.S. electric accounts · all causes';
  if (!out.n) { out.caption='Reporting utilities show zero'; return out; }
  const statesAreAligned = power.states_status === 'current' && Date.parse(power.states_as_of) === Date.parse(power.as_of);
  const rows = statesAreAligned ? stateRows(power.states,'customers_out','state').slice(0,8) : [];
  if (rows.length) {
    out.chart = {type:'bars',title:'Largest state outage counts, descending',rows};
    out.caption='Most outages · '+rows[0].label+' '+number.format(rows[0].value);
  } else if (count(power.reporting_utilities)) {
    out.caption=number.format(power.reporting_utilities)+' reporting utilities';
  }
  return out;
}

const airKinds = new Map([
  ['ground_stop','Ground stop'], ['ground_delay','Ground delay program'],
  ['arrival_delay','Arrival delay'], ['departure_delay','Departure delay'],
  ['airport_closure','Closure'], ['deicing','Deicing'], ['airport_restriction','Restriction']
]);

function aviationCard(air, now) {
  const status = sourceState(air,air?.as_of,now,30);
  const out = card('aviation','plane','Airports with FAA notices','FAA NAS',air?.as_of,status);
  if (status === 'stale' || status === 'unavailable') return out;
  if (!Array.isArray(air.events)) { out.status='unavailable'; return out; }
  const usable = air.events.filter(r=>r && typeof r.airport==='string' && r.airport.trim());
  const active = activeAirEvents({...air,events:usable},now);
  const partial = status === 'partial' || air.event_count !== air.events.length ||
    usable.length !== air.events.length;
  if (partial) out.status='partial';
  if (!active.length && partial) {
    out.context='Incomplete airport inventory';
    return out;
  }
  out.n=new Set(active.map(e=>e.airport)).size;
  out.minimum=partial;
  out.context = active.length ? number.format(active.length)+' active '+(active.length===1?'notice':'notices') : 'No active FAA airport notice';
  const groups = new Map();
  for (const row of active) {
    const type = airKinds.get(row.kind) || 'Other notice';
    groups.set(type,(groups.get(type)||0)+1);
  }
  const rows = [...groups].map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value || a.label.localeCompare(b.label));
  if (rows.length) out.chart={type:'stack',title:'Active FAA notices by type',rows};
  const delay=active.find(e=>e.delay);
  if (delay) out.caption=delay.airport+' · '+delay.delay;
  else out.caption=rows.slice(0,2).map(r=>r.label+' '+r.value).join(' · ');
  return out;
}

// sites[] is capped for display; aggregate figures refer to the full checked edition.
export function gaugeTally(river, now=Date.now()) {
  const status=sourceState(river,river?.asOf,now,60);
  const tally={status,n:null,minimum:false,rows:[]};
  if (status==='stale' || status==='unavailable') return tally;
  const complete=status==='current' && count(river.total);
  const available=complete ? river.total : river.availableCount;
  if (!complete) tally.status='partial';
  if (!count(available) || !complete && !available) return tally;
  tally.n=available;
  tally.minimum=!complete;
  const categories=complete ? river.counts : river.availableCounts;
  const rows=['minor','moderate','major'].map(label=>({label,value:categories?.[label],color:gaugeColors[label]}));
  if (rows.every(r=>count(r.value)) && rows.reduce((n,r)=>n+r.value,0)===available) tally.rows=rows;
  return tally;
}

function riverCard(river, now) {
  const tally=gaugeTally(river,now);
  const out=card('ground','ground','Gauges in flood','NOAA NWPS',river?.asOf,tally.status);
  if (tally.status==='stale' || tally.status==='unavailable') return out;
  if (tally.n === null) {out.context='Complete gauge count unavailable';return out;}
  out.n=tally.n;
  out.minimum=tally.minimum;
  out.context=tally.minimum ? 'Verified gauges · partial network count' : 'Observed at minor flood stage or higher';
  if (!tally.n) {out.caption='No qualifying flood-stage observations';return out;}
  if (tally.rows.length) {
    out.chart={type:'stack',title:'Observed gauges by flood stage',rows:tally.rows};
    out.caption=tally.rows.map(r=>number.format(r.value)+' '+r.label).join(' · ');
  }
  return out;
}

export function impactStripData(board, focusChoice, now=Date.now()) {
  const impact=board?.impacts || {};
  return [exposureCard(board,focusChoice,now),powerCard(impact.power,now),
    aviationCard(impact.aviation,now),riverCard(impact.ground?.rivers,now)];
}

function svgElement(document, tag, attrs) {
  const el=document.createElementNS(svgNS,tag);
  for (const [name,value] of Object.entries(attrs)) el.setAttribute(name,String(value));
  return el;
}
function textSpan(document, name, value) {
  const span=document.createElement('span');
  span.className=name;
  span.textContent=value;
  return span;
}
function plotText(chart) {
  return chart.title+'. '+chart.rows.map(r=>r.label+' '+number.format(r.value)).join(', ')+'.';
}
function drawPlot(doc,chart) {
  const svg=svgElement(doc,'svg',{class:'kpi-plot','data-plot':chart.type,viewBox:'0 0 144 20',
    preserveAspectRatio:'none',role:'img','aria-label':plotText(chart),width:'100%',height:20});
  const title=svgElement(doc,'title',{});title.textContent=plotText(chart);svg.append(title);
  const rows=chart.rows;
  const max=Math.max(...rows.map(r=>r.value));
  const total=rows.reduce((n,r)=>n+r.value,0);
  let x=0;
  for (const [i,r] of rows.entries()) {
    if (!r.value) continue;
    let rect;
    if (chart.type==='bars') {
      const step=144/rows.length, height=18*r.value/max;
      rect={x:i*step+1,y:19-height,width:Math.max(1,step-3),height,rx:1.1};
    } else {
      const width=144*r.value/total;
      rect={x,y:7,width,height:7};
      x+=width;
    }
    const fill=r.color || 'var(--kpi-chart-color,currentColor)';
    const opacity=r.color ? 1 : Math.max(.28,1-(i/(rows.length||1))*.69);
    const pixel=svgElement(doc,'rect',{...rect,fill,'fill-opacity':opacity});
    const reading=svgElement(doc,'title',{});reading.textContent=r.label+' · '+number.format(r.value);
    pixel.append(reading);svg.append(pixel);
  }
  return svg;
}

function updateButton(button, data) {
  const doc=button.ownerDocument;
  const heading=textSpan(doc,'kpi-heading','');
  const icon=svgElement(doc,'svg',{class:'kpi-icon','aria-hidden':'true',width:18,height:18,fill:'none',stroke:'currentColor','stroke-width':1.7});
  icon.append(svgElement(doc,'use',{href:'#i-'+data.icon}));heading.append(icon,textSpan(doc,'kpi-label',data.label));
  const numeric=count(data.n);
  const shown=numeric ? (data.minimum?'≥':'')+compact.format(data.n) : '—';
  const value=textSpan(doc,'kpi-value',shown);
  if (numeric) value.title=(data.minimum?'At least ':'')+number.format(data.n);
  const context=textSpan(doc,'kpi-context',data.context);
  const stamp=doc.createElement('time');
  stamp.className='kpi-time';
  let date='';
  if (Number.isFinite(Date.parse(data.stamp))) {
    stamp.dateTime=data.stamp;
    date=utc.format(new Date(data.stamp)).replace(',','')+' UTC';
  }
  const stateLabel={partial:'Partial',stale:'Stale',unavailable:'Unavailable'}[data.status];
  stamp.textContent=[stateLabel,data.source,date].filter(Boolean).join(' · ');
  const caption=textSpan(doc,'kpi-caption',data.caption);
  const blocks=[heading,value,context];
  if (data.chart) blocks.push(drawPlot(doc,data.chart));
  if (data.caption) blocks.push(caption);
  blocks.push(stamp);
  button.replaceChildren(...blocks);
  button.dataset.status=data.status;
  const precise=numeric?(data.minimum?'at least ':'')+number.format(data.n):'current count unavailable';
  const detail=[data.label,precise,data.context,data.chart?plotText(data.chart):data.caption,stamp.textContent,'Open details'].filter(Boolean).join('. ');
  button.setAttribute('aria-label',detail);
}

export function mountImpactStrip(container, onSelect) {
  const doc=container.ownerDocument;
  let currentChoice=null;
  const buttons=new Map();
  const update=(board,focusChoice,now=Date.now())=>{
    currentChoice=focusChoice;
    for (const data of impactStripData(board,focusChoice,now)) {
      let button=buttons.get(data.key);
      if (!button) {
        button=doc.createElement('button');
        button.type='button';
        button.className='kpi-card';
        button.dataset.kpi=data.key;
        button.addEventListener('click',()=>onSelect(data.key,currentChoice));
        buttons.set(data.key,button);
        container.append(button);
      }
      updateButton(button,data);
    }
  };
  return {update};
}
