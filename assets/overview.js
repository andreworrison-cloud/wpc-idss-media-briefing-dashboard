import {activeAirEvents, currentGroundReports, currentRivers, freshImpact, recent} from './impact-logic.js';
import {gaugeTally} from './impact-strip.js';
import {outageBand, OUTAGE_LEGEND, sectionStatus} from './outage-layer.js';
import {availableRows, timeBins} from './observed-graphics.js';
import {inkFor} from './hazard-palette.js';
import {mountForecastPreviews} from './forecast-previews.js';

const number = new Intl.NumberFormat('en-US');
const dateTime = new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const clock = new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const validCount = n => Number.isSafeInteger(n) && n >= 0;
const stamp = t => Number.isFinite(Date.parse(t)) ? dateTime.format(Date.parse(t))+' UTC' : '';
const names = new Intl.DisplayNames('en',{type:'region'});
const stateGrid = [
  'AK . . . . . . . . . . . ME',
  '. WA MT ND . MN WI MI . . VT NH MA',
  '. OR ID WY SD IA IL IN OH PA NY CT RI',
  '. CA NV UT CO NE MO KY WV MD NJ . .',
  '. . AZ NM KS AR TN VA NC DE . . .',
  '. . . . OK LA MS AL GA SC DC . .',
  'HI . . . TX . . . . FL . . .',
  'AS GU MP PR VI . . . . . . . .'
];
const stateNames = Object.fromEntries(('AK Alaska|AL Alabama|AR Arkansas|AZ Arizona|CA California|CO Colorado|CT Connecticut|DC District of Columbia|DE Delaware|FL Florida|GA Georgia|HI Hawaii|IA Iowa|ID Idaho|IL Illinois|IN Indiana|KS Kansas|KY Kentucky|LA Louisiana|MA Massachusetts|MD Maryland|ME Maine|MI Michigan|MN Minnesota|MO Missouri|MS Mississippi|MT Montana|NC North Carolina|ND North Dakota|NE Nebraska|NH New Hampshire|NJ New Jersey|NM New Mexico|NV Nevada|NY New York|OH Ohio|OK Oklahoma|OR Oregon|PA Pennsylvania|RI Rhode Island|SC South Carolina|SD South Dakota|TN Tennessee|TX Texas|UT Utah|VA Virginia|VT Vermont|WA Washington|WI Wisconsin|WV West Virginia|WY Wyoming').split('|').map(entry=>[entry.slice(0,2),entry.slice(3)]));
const byId = id => document.getElementById(id);
function node(tag,cls='',content) {
  const el=document.createElement(tag);
  if(cls)el.className=cls;
  if(content!=null)el.textContent=content;
  return el;
}
const muted = msg => node('p','monitor-empty',msg);
const sourceLine = msg => node('div','monitor-source',msg);
function chartNode(tag,attrs) {
  const el=document.createElementNS('http://www.w3.org/2000/svg',tag);
  for(const [key,v] of Object.entries(attrs))el.setAttribute(key,v);
  return el;
}
function outageHistory(el,history,now) {
  el.replaceChildren();
  const counts=history?.counts;
  const start=Date.parse(history?.start);
  if(history?.status!=='current'||!recent(history.as_of,now,30)||!Number.isFinite(start)||
     history.step_minutes!==15||!Array.isArray(counts)||counts.length<2||counts.length>97||counts.filter(validCount).length<2) {
    el.append(muted('National outage history unavailable.'));return;
  }
  const peak=Math.max(...counts.filter(validCount)), scale=peak||1;
  const step=history.step_minutes*60000, end=start+(counts.length-1)*step;
  const label=node('div','history-heading');
  label.append(node('strong','','U.S. customers out'),node('span','',Math.round((end-start+step)/3600000)+' h · 15-min readings'));
  const svg=chartNode('svg',{viewBox:'0 0 320 58',preserveAspectRatio:'none',role:'img','aria-label':'Reported national outage history. Peak '+number.format(peak)+' accounts at '+dateTime.format(start+counts.indexOf(peak)*step)+' UTC.'});
  [9,30,53].forEach(y=>svg.append(chartNode('path',{d:'M0 '+y+'H320',class:'history-grid'})));
  let points=[];
  function segment(){
    if(!points.length)return;
    const line=points.map(p=>p.join(',')).join(' ');
    svg.append(chartNode('polygon',{points:points[0][0]+',53 '+line+' '+points[points.length-1][0]+',53',class:'history-fill'}));
    svg.append(chartNode('polyline',{points:line,class:'history-trace'}));
    if(points.length===1)svg.append(chartNode('circle',{cx:points[0][0],cy:points[0][1],r:1.8,class:'history-dot'}));
    points=[];
  }
  counts.forEach((v,i)=>{if(validCount(v))points.push([+(2+316*i/(counts.length-1)).toFixed(2),+(53-46*v/scale).toFixed(2)]);else segment();});
  segment();
  const axis=node('div','chart-axis');
  axis.append(node('span','',dateTime.format(start)+' UTC'),node('strong','','Peak '+number.format(peak)),node('span','',dateTime.format(end)+' UTC'));
  el.append(label,svg,axis);
}
function mountPower(el) {
  const trend=node('div','outage-history'), grid=node('div','state-mosaic'), readout=node('div','state-readout'), legend=node('div','mosaic-legend'), source=sourceLine('');
  grid.setAttribute('role','group');grid.setAttribute('aria-label','Customers without power by state and territory');
  const tiles=new Map();let reports=new Map(),selected=null;
  for(const [y,row] of stateGrid.entries())for(const [x,code] of row.split(' ').entries()){
    if(code==='.')continue;
    const button=node('button','state-tile',code);button.type='button';button.dataset.code=code;
    button.style.gridArea=(y+1)+' / '+(x+1);button.tabIndex=-1;
    tiles.set(code,button);grid.append(button);
  }
  for(const b of OUTAGE_LEGEND.slice(1).concat(OUTAGE_LEGEND[0])){
    const cell=node('span');const swatch=node('i',b.id==='missing'?'unknown':'');
    swatch.style.backgroundColor=b.color;cell.append(swatch,document.createTextNode(b.id==='missing'?'No report':b.label));legend.append(cell);
  }
  function select(code){
    if(!tiles.has(code))return;
    if(selected){tiles.get(selected).classList.remove('is-selected');tiles.get(selected).tabIndex=-1;}
    selected=code;const button=tiles.get(code);button.classList.add('is-selected');button.tabIndex=0;
    const state=reports.get(code);const place=state?.name||stateNames[code]||names.of(code);
    readout.replaceChildren(node('strong','',place),node('span','',validCount(state?.customers_out)?number.format(state.customers_out)+' customers out':'No mapped report'));
  }
  for(const type of ['pointerover','focusin','click'])grid.addEventListener(type,e=>{const code=e.target.closest('button')?.dataset.code;if(code)select(code);});
  grid.addEventListener('keydown',e=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
    const keys=[...tiles.keys()],idx=keys.indexOf(e.target.dataset.code);if(idx<0)return;
    const dirs={ArrowLeft:-1,ArrowRight:1,ArrowUp:-1,ArrowDown:1}, button=tiles.get(keys[idx]);
    let next=keys[idx];
    if(e.key==='Home'||e.key==='End')next=keys[e.key==='Home'?0:keys.length-1];
    else if(['ArrowUp','ArrowDown'].includes(e.key)){
      const row=Number(button.style.gridRowStart), col=Number(button.style.gridColumnStart), dir=dirs[e.key];
      const candidates=[...tiles.values()].filter(b=>Number(b.style.gridRowStart)===row+dir);
      candidates.sort((a,b)=>Math.abs(Number(a.style.gridColumnStart)-col)-Math.abs(Number(b.style.gridColumnStart)-col));
      next=candidates[0]?.dataset.code||next;
    } else next=keys[Math.max(0,Math.min(keys.length-1,idx+dirs[e.key]))];
    e.preventDefault();tiles.get(next).focus();
  });
  el.replaceChildren(trend,grid,readout,legend,source);
  return (power,now)=>{
    const status=sectionStatus(power,'state',now);
    const rows=status.status==='current'&&Array.isArray(power.states)?power.states:[];
    reports=new Map(rows.map(r=>[r.state,r]));
    for(const [code,button] of tiles){
      const row=reports.get(code),band=outageBand(row?.customers_out), place=row?.name||stateNames[code]||names.of(code);
      button.classList.toggle('unknown',band.id==='missing');button.style.setProperty('--tile',band.color);
      button.style.setProperty('--tile-ink',inkFor(band.color));
      button.title=place+' · '+(validCount(row?.customers_out)?number.format(row.customers_out)+' customers out':'No mapped report');
      button.setAttribute('aria-label',button.title);
    }
    const highest=rows.filter(r=>validCount(r.customers_out)&&tiles.has(r.state)).sort((a,b)=>b.customers_out-a.customers_out)[0]?.state;
    select(selected&&reports.has(selected)?selected:highest||selected||'AK');
    outageHistory(trend,power?.history,now);
    source.textContent=['Power Out Map · All causes',status.status==='current'?stamp(status.as_of):'State readings '+status.status].join(' · ');
  };
}
const airOrder=['ground_stop','ground_delay','arrival_delay','departure_delay','airport_closure','deicing','airport_restriction'];
function airBoard(el,air,now){
  el.replaceChildren();
  const live=freshImpact(air,now,30);
  const events=live?activeAirEvents(air,now).slice():[];
  const rank=e=>{const r=airOrder.indexOf(e.kind);return r<0?airOrder.length:r;};
  events.sort((a,b)=>rank(a)-rank(b)||String(a.airport).localeCompare(String(b.airport)));
  if(events.length){
    const list=node('ol','airport-board');
    for(const e of events.slice(0,4)){
      const row=node('li');const code=node('strong','airport-code',e.airport||'—');
      const description=node('div','airport-info');
      description.append(node('strong','',e.label||'FAA notice'),node('small','',[e.city||e.airport_name,e.state].filter(Boolean).join(', ')));
      const detail=node('span','airport-delay',e.delay||'');if(!e.delay)detail.classList.add('no-delay');
      row.append(code,description,detail);list.append(row);
    }
    el.append(list);
    if(events.length>4)el.append(sourceLine('Showing 4 of '+number.format(events.length)+' active notices.'));
  }else el.append(muted(live&&air.status!=='partial'?'FAA lists no active airport notices.':live?'No active notices in the available FAA records.':'Current FAA airport notices unavailable.'));
  el.append(sourceLine(['FAA NAS Status',live&&air.status==='partial'?'Partial coverage':'',live?stamp(air.as_of):''].filter(Boolean).join(' · ')));
  const daily=node('a','daily-air-link','Today’s U.S. delays and cancellations ↗');
  daily.href='https://www.flightaware.com/live/cancelled/today/US';daily.target='_blank';daily.rel='noopener noreferrer';daily.setAttribute('aria-label','Today’s U.S. delays and cancellations on FlightAware');
  el.append(daily);
  const m=air?.monthly_context;
  if(m?.status==='historical'&&m.period_label&&validCount(m.delayed_arrivals)&&validCount(m.cancelled)){
    const box=node('div','monthly-air'), title=node('div','month-label','U.S. domestic flights · '+m.period_label);
    const figures=node('div','monthly-figures');
    for(const [label,n] of [['Arrivals delayed 15+ min',m.delayed_arrivals],['Flights cancelled',m.cancelled]]){
      const item=node('div');item.append(node('strong','',number.format(n)),node('span','',label));figures.append(item);
    }
    box.append(title,figures,sourceLine('Bureau of Transportation Statistics · Monthly carrier totals'));el.append(box);
  }
}
function riverBoard(el,river,now){
  el.replaceChildren();const g=gaugeTally(river,now);
  if(g.rows.length){
    const scale=node('div','river-scale');
    for(const r of g.rows){const cell=node('div');cell.style.setProperty('--level',r.color);cell.append(node('strong','',number.format(r.value)),node('span','',r.label));scale.append(cell);}
    el.append(scale);
  }else el.append(muted('Flood-stage breakdown unavailable.'));
  const rank={major:3,moderate:2,minor:1};
  const site=currentRivers(river,now).slice().sort((a,b)=>(rank[b.category]||0)-(rank[a.category]||0)||Date.parse(b.observedAt)-Date.parse(a.observedAt))[0];
  if(site){
    const line=node('p','gauge-lead');
    line.append(node('strong','',site.waterbody||site.name||site.id),document.createTextNode(' · '+[site.location||site.state,Number.isFinite(site.value)?site.value+' '+(site.unit||''):'',site.category+' flooding',stamp(site.observedAt)].filter(Boolean).join(' · ')));el.append(line);
  }
  el.append(sourceLine(['NOAA NWPS',g.minimum?'Partial gauge inventory':'Gauges at or above flood stage',stamp(river?.asOf)].filter(Boolean).join(' · ')));
}
const impactTypes=[['roadClosure','Road closures'],['strandedVehicle','Stranded vehicles'],['rescue','Rescues'],['structuralDamage','Structural damage']];
function groundBoard(el,reports,now){
  el.replaceChildren();
  if(!freshImpact(reports,now,60)){el.append(muted('Current NWS ground-impact reports unavailable.'));return;}
  const partial=reports.status==='partial', counts=partial?reports.availableCounts:reports.counts;
  const heading=node('p','ground-window','Preliminary NWS reports · Past '+reports.periodHours+' hours');
  const figures=node('div','ground-figures');
  for(const [key,label] of impactTypes){
    const cell=node('div'), n=counts?.[key];
    const value=validCount(n)&&(!partial||n>0)?(partial?'≥ ':'')+number.format(n):'—';
    cell.append(node('strong','',value),node('span','',label));
    cell.title=validCount(n)&&(!partial||n>0)?number.format(n)+' available reports mentioning '+label.toLowerCase():'Complete count unavailable';
    figures.append(cell);
  }
  el.append(heading,figures);
  const latest=currentGroundReports(reports,now).slice().sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt)).slice(0,2);
  for(const r of latest){
    const line=node('div','ground-report');
    const place=[r.location,r.location===r.state?'':r.state].filter(Boolean).join(', ');
    const title=node('strong','',place);
    const types=impactTypes.filter(([k])=>r.categories?.includes(k)).map(([,l])=>l);
    line.append(title,node('span','',[types.join(' · '),r.hazard].filter(Boolean).join(' · ')));
    const source=node('a','',stamp(r.observedAt)+(r.office?' · '+r.office:''));
    if(/^https:\/\/mesonet\.agron\.iastate\.edu\/p\//.test(r.url||'')){source.href=r.url;source.target='_blank';source.rel='noopener noreferrer';}
    line.append(source);el.append(line);
  }
  el.append(sourceLine([partial?'Partial report inventory':'One report can describe several impacts',stamp(reports.asOf)].filter(Boolean).join(' · ')));
}
function reportHistogram(el,obs,now){
  el.replaceChildren();const end=Date.parse(obs?.asOf||obs?.checkedAt);
  if(!recent(obs?.asOf||obs?.checkedAt,now,75)||!['current','ok','partial','none'].includes(obs?.status)){
    el.append(muted('National LSR/PNS reporting history unavailable.'));return;
  }
  const bins=timeBins(availableRows(obs,now),end,48), totals=bins.reduce((t,b)=>[t[0]+b.LSR,t[1]+b.PNS],[0,0]);
  const top=Math.max(1,...bins.map(b=>b.LSR+b.PNS));const label=node('div','pulse-label');
  label.append(node('h4','','Available U.S. reports · past 48 h'),node('span','lsr-label',number.format(totals[0])+' LSR'),node('span','pns-label',number.format(totals[1])+' PNS'));
  const bars=node('div','pulse-bars');
  for(const b of bins){
    const cell=node('div','pulse-bin');cell.title=dateTime.format(b.start)+'–'+clock.format(b.end)+' UTC · '+b.LSR+' LSR · '+b.PNS+' PNS';cell.setAttribute('aria-label',cell.title);
    for(const [kind,n] of [['lsr',b.LSR],['pns',b.PNS]]){const bar=node('i',kind);bar.style.height=(100*n/top)+'%';cell.append(bar);}bars.append(cell);
  }
  const axis=node('div','chart-axis');
  axis.append(node('span','',dateTime.format(bins[0].start)+' UTC'),node('span','','4-hour intervals'),node('span','',dateTime.format(end)+' UTC'));
  el.append(label,bars,axis);if(obs.status==='partial'||obs.truncated)el.append(sourceLine('Available reports · Partial inventory'));
}
export function mountOverview(onForecast){
  const power=mountPower(byId('overview-power'));
  const previews=mountForecastPreviews(byId('forecast-previews'),onForecast);
  function updateFocus(choice){
    byId('overview-population-label').textContent=choice?.label||'No selected hazard footprint';
    byId('overview-population-value').textContent=validCount(choice?.population)?number.format(choice.population):'—';
    byId('overview-population-method').textContent=validCount(choice?.population)?'Estimated residents · 2020 Census':'Resident estimate unavailable';
    byId('overview-exposure-map').disabled=!choice;
  }
  return {updateFocus,refreshTheme:previews.redraw,update(board,choice,now=Date.now()){
    power(board?.impacts?.power,now);airBoard(byId('overview-air'),board?.impacts?.aviation,now);
    riverBoard(byId('overview-rivers'),board?.impacts?.ground?.rivers,now);
    groundBoard(byId('overview-ground'),board?.impacts?.ground?.reports,now);
    reportHistogram(byId('overview-report-time'),board?.weather?.observations,now);updateFocus(choice);previews.update(board,now);
  }};
}
