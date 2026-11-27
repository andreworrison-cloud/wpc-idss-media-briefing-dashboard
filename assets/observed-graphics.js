import {eligibleReport} from './report-evidence.js';
import {safeURL, isoTime} from './logic.js';

const NS = 'http://www.w3.org/2000/svg';
export const hazards = {
  all:'All reports', snow:'Snow', ice:'Ice', rain:'Rain', wind:'Wind', effect:'Weather impacts',
  hail:'Hail', cold:'Cold', heat:'Heat'
};
const measurements = [
  {key:'snow', name:'Snowfall', unit:'inches', icon:'snow', type:'snowfall'},
  {key:'ice', name:'Ice accretion', unit:'inches', icon:'ice', type:'iceAccretion'},
  {key:'rain', name:'Rainfall', unit:'inches', icon:'rain', type:'rainfall'},
  {key:'wind', name:'Wind gust', unit:'mph', icon:'wind', type:'windGust'}
];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const place = row => [row.place, row.state].filter(Boolean).join(', ') || 'Location unspecified';
const numeric = value => Number.isFinite(value) ? value.toLocaleString('en-US',{maximumFractionDigits:3}) : '';
const asDate = value => Number.isFinite(Date.parse(value)) ? isoTime(value,true) : '';
const when = row => asDate(row.observedAt) ? isoTime(row.observedAt,true)+' observed' : asDate(row.issuedAt) ? isoTime(row.issuedAt,true)+' issued' : 'Time unspecified';
const classOK = s => ['ok','current','partial'].includes(String(s || '').toLowerCase());
export function reportPeriod(row) {
  if(Number.isFinite(row.durationHours) && row.durationHours>0) return row.durationHours+' h accumulation';
  return row.periodLabel || '';
}
export function reportAmount(row) {
  if(row.trace) return 'Trace';
  if(!Number.isFinite(row.value)) return '';
  return numeric(row.value)+(row.unit?' '+row.unit:'');
}
export function amountDetail(row) {
  return [reportAmount(row), row.qualifier && !/^(reported|trace)$/i.test(row.qualifier)?row.qualifier.toLowerCase():null, reportPeriod(row)].filter(Boolean).join(' · ');
}
export function collectionState(observations, now) {
  if(!observations || !classOK(observations.status)) return 'unavailable';
  const t=Date.parse(observations.asOf||observations.checkedAt);
  if(!Number.isFinite(t) || now-t>75*60000 || t-now>5*60000) return 'stale';
  return observations.status;
}
export function availableRows(obs, now=Date.now()) {
  if(!classOK(collectionState(obs,now))) return [];
  const unique=new Map();
  for(const row of [...(obs.features||[]),...(obs.unlocated||[]),...Object.values(obs.leaders||{}).flat().filter(Boolean)]) {
    if(row?.id && !unique.has(row.id)) unique.set(row.id,row);
  }
  return [...unique.values()];
}
export function scopedReports(rows, scope={}, now=Date.now()) {
  const {source='',state='',category='all',term='',hours=48}=scope;
  const search=String(term).trim().toLowerCase(), since=now-hours*3600000;
  return rows.filter(r=>{
    const time=Date.parse(r.observedAt||r.issuedAt);
    if(!Number.isFinite(time) || time<since || time>now+2*60000) return false;
    if(source&&r.sourceType!==source || state&&r.state!==state || category!=='all'&&r.category!==category) return false;
    if(!search)return true;
    return [r.place,r.state,r.office,r.phenomenon,r.county,r.label,r.sourceType,...(r.impactFlags||[])].join(' ').toLowerCase().includes(search);
  }).sort((a,b)=>Date.parse(b.observedAt||b.issuedAt)-Date.parse(a.observedAt||a.issuedAt));
}
function isComparable(row, spec) {
  const t=String(row.measurementType||'').toLowerCase();
  return eligibleReport(row) && row.category===spec.key && Number.isFinite(row.value) && row.value>=0 && (t===spec.type.toLowerCase() || (spec.key==='ice'&&['iceaccretion','iceaccumulation'].includes(t)));
}
function localLeaders(rows, spec) {
  const seen=new Set();
  return rows.filter(r=>isComparable(r,spec)).sort((a,b)=>b.value-a.value).filter(r=>{
    const key=[r.place,r.state,r.observedAt,r.value,r.unit,r.durationHours,r.periodLabel].join('|');
    if(seen.has(key))return false;
    seen.add(key);return true;
  }).slice(0,3);
}
function chart(rows, spec, collection, hasFilter) {
  const qualified=localLeaders(rows, spec);
  const official = (collection?.leaders?.[spec.key]||[]).filter(r=>eligibleReport(r)&&rows.some(v=>v.id===r.id));
  const leaders = hasFilter || !official.length ? qualified : official.slice(0,3);
  const top=leaders[0], max=top?.value||0;
  const title='<figcaption class="measure-name"><svg aria-hidden="true"><use href="#i-'+spec.icon+'"/></svg><b>'+spec.name+'</b><small>'+spec.unit+'</small></figcaption>';
  if(!leaders.length) {
    const partial=collection?.status==='partial'||collection?.leaderStatus?.[spec.key]==='unknown';
    const label=partial?'No qualifying amount in available reports.':'No qualifying amount in this selection.';
    return '<figure class="measurement" data-measure="'+spec.key+'">'+title+'<p class="empty">'+label+'</p></figure>';
  }
  const points=leaders.map(r=>{
    const end=max?Math.max(0,Math.min(100,100*r.value/max)):0;
    const attrs=esc([place(r),r.label,amountDetail(r),r.sourceType,r.office,when(r)].filter(Boolean).join(', '));
    return '<li><button type="button" class="chart-row" data-report="'+esc(r.id)+'" title="'+attrs+'" aria-label="'+attrs+'"><span class="chart-place">'+esc(place(r))+'</span><svg xmlns="'+NS+'" class="plot-line" viewBox="-2 0 104 12" preserveAspectRatio="none" aria-hidden="true"><path d="M0 6H100" stroke="#cfdbdf" stroke-width="1"/><rect x="0" y="3.5" width="'+end.toFixed(2)+'" height="5" fill="currentColor"/><path d="M0 1v10" stroke="#849ba4" stroke-width="1"/></svg><strong>'+esc((/estimated/i.test(r.qualifier)?'~':'')+numeric(r.value))+'</strong></button></li>';
  }).join('');
  const provenance=[top.sourceType,top.office,when(top),reportPeriod(top),top.verificationNote].filter(Boolean).join(' · ');
  return '<figure class="measurement" data-measure="'+spec.key+'">'+title+'<ol>'+points+'</ol><small class="chart-provenance">Top report · '+esc(provenance)+'</small></figure>';
}
export function reportPresentation(row) {
  const amount=amountDetail(row);
  return {title: (row.label||row.phenomenon||'NWS report')+' · '+place(row),detail:[amount,row.phenomenon&&row.phenomenon!==row.label?row.phenomenon:null].filter(Boolean).join(' · '),lines:[amount,row.verificationNote,row.observedAt?'Observed '+asDate(row.observedAt):'Observation time unspecified',row.issuedAt?'Issued '+asDate(row.issuedAt):null,[row.sourceType,row.office].filter(Boolean).join(' · ')].filter(Boolean),url:safeURL(row.url),verificationUrl:safeURL(row.verificationUrl)};
}
export function appendObservedBrief(draft, observations, scope, now=Date.now()) {
  const rows=scopedReports(availableRows(observations,now),{hours:scope.hours},now).filter(r=>(!scope.states.length||scope.states.includes(r.state))&&(!scope.wfos.length||scope.wfos.includes(r.office)));
  const show={winter:['snow','ice'],flood:['rain'],wind:['wind'],severe:['wind'],tropical:['wind','rain']};
  const chosen=scope.family?(show[scope.family]||[]):measurements.map(m=>m.key);
  const lines=[];
  for(const spec of measurements.filter(m=>chosen.includes(m.key))) {
    const r=localLeaders(rows,spec)[0], link=r&&safeURL(r.url);
    if(!r||!link)continue;
    let id=draft.evidence.findIndex(v=>v.url===link);
    if(id<0){id=draft.evidence.length;draft.evidence.push({label:[r.sourceType,r.office,place(r)].filter(Boolean).join(' · '),url:link});}
    const units=r.unit==='in'?(r.value===1?'inch':'inches'):r.unit;
    const value=numeric(r.value)+' '+(units||'');
    const estimate=/estimated/i.test(r.qualifier||'');
    const quantity=spec.key==='wind'?(estimate?'an estimated ':'a ')+'wind gust of '+value:(estimate?'an estimated ':'')+value+' of '+spec.name.toLowerCase();
    const period=Number.isFinite(r.durationHours)&&r.durationHours>0?' over '+r.durationHours+' '+(r.durationHours===1?'hour':'hours'):r.periodLabel?' ('+r.periodLabel.toLowerCase()+')':'';
    lines.push('At '+place(r)+', the '+r.office+' '+r.sourceType+' reported '+quantity+period+'. '+(r.observedAt?'Observed '+asDate(r.observedAt):'Bulletin issued '+asDate(r.issuedAt))+'. '+(r.verificationNote?r.verificationNote+' ':'')+'['+(id+1)+']');
  }
  if(lines.length)draft.sections.splice(1,0,{title:'Measured weather in the selected area',lines});
  return draft;
}
export function timeBins(rows, end, hours) {
  const span = hours * 3600000, start = end - span, width = span / 12;
  const bins = Array.from({length:12}, (_, n) => ({
    start:start+n*width, end:start+(n+1)*width, LSR:0, PNS:0, rows:[]
  }));
  for (const row of rows) {
    const t = Date.parse(row.observedAt);
    if (!Number.isFinite(t) || t < start || t > end || !['LSR','PNS'].includes(row.sourceType)) continue;
    const bin = bins[Math.min(11, Math.floor((t-start)/width))];
    bin[row.sourceType]++; bin.rows.push(row);
  }
  return bins;
}
function drawReportTime(el, bins, selected) {
  const max=Math.max(1,...bins.map(b=>b.rows.length));
  const utc=n=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(n);
  const read=b=>utc(b.start)+' – '+utc(b.end)+' UTC · '+b.LSR+' LSR · '+b.PNS+' PNS';
  const bars=bins.map((b,i)=>'<button type="button" data-time-bin="'+i+'" aria-pressed="'+(i===selected)+'" aria-label="'+read(b)+'" title="'+read(b)+'"><span class="time-bars"><i class="time-lsr" style="height:'+100*b.LSR/max+'%"></i><i class="time-pns" style="height:'+100*b.PNS/max+'%"></i></span><small>'+b.rows.length+'</small></button>').join('');
  el.innerHTML='<div class="time-head"><h3>Reports by observation time</h3><span><i class="time-lsr"></i> LSR <i class="time-pns"></i> PNS</span></div>'+
    '<div class="time-strip">'+bars+'</div><div class="time-axis"><span>'+utc(bins[0].start)+' UTC</span><span>'+utc(bins[11].end)+' UTC</span></div>'+
    '<div class="time-caption"><span data-time-caption>'+ (selected>=0?read(bins[selected]):'Select an interval to filter the list.')+'</span>'+
    (selected>=0?'<button type="button" data-time-clear>Show all hours</button>':'')+'</div>';
}
export function mountObservationDesk(onSelect) {
  const get=id=>document.getElementById(id), pageSize=12;
  let data=null, rows=[], activeCategory='all', page=0, activeBin=-1;
  const tabs=get('hazard-tabs');
  tabs.innerHTML=Object.entries(hazards).map(([key,label])=>'<button type="button" data-hazard="'+key+'" aria-pressed="'+(key==='all')+'">'+label+'</button>').join('');
  const scope=()=>({source:get('report-source').value,state:get('report-state').value,hours:Number(get('report-hours').value)||48,term:get('report-search').value,category:activeCategory});
  function render() {
    const now=Date.now(), settings=scope(), state=collectionState(data,now);
    const available=classOK(state), scoped=scopedReports(rows,{...settings,category:'all'},now);
    const categoryRows = activeCategory==='all'?scoped:scoped.filter(r=>r.category===activeCategory);
    const timing=get('report-timing'), end=Math.min(now,Date.parse(data?.checkedAt)||now);
    const bins=timeBins(categoryRows,end,settings.hours);
    timing.hidden=!available || !categoryRows.length;
    if(!timing.hidden)drawReportTime(timing,bins,activeBin);
    const filtered=activeBin<0?categoryRows:bins[activeBin].rows;
    const custom=!!(settings.source||settings.state||settings.term||settings.hours!==48);
    const windowHours=Math.min(settings.hours,Number(data?.periodHours)||48);
    const scopeLabel=[settings.state,settings.source].filter(Boolean).join(' · ');
    const cap='Past '+windowHours+' h'+(scopeLabel?' · '+scopeLabel:'');
    get('measure-caption').textContent=available?cap+' · Highest reported values'+(state==='partial'?' · Partial bulletin coverage':'')+'.':state==='stale'?'Current measurement collection is stale.':'Current measurement collection unavailable.';
    get('measure-graphics').innerHTML=available?measurements.map(spec=>chart(scoped,spec,data,custom)).join(''):'<p class="empty">Current rankings unavailable. Check source health for collection times.</p>';
    get('report-summary').textContent=available?filtered.length.toLocaleString()+' available records · '+cap+(state==='partial'?' · Partial coverage':''):'Current bulletin records unavailable';
    const pages=Math.ceil(filtered.length/pageSize);
    page=Math.max(0,Math.min(page,pages-1));
    if(!filtered.length) {
      get('report-table').innerHTML='<p class="empty">'+(available?'No available records match these filters.':'The current bulletin collection is unavailable.')+'</p>';get('report-pager').replaceChildren();return;
    }
    const link=r=>safeURL(r.url)?'<a href="'+esc(safeURL(r.url))+'" target="_blank" rel="noopener">'+esc([r.sourceType,r.office].filter(Boolean).join(' · '))+'</a>':esc([r.sourceType,r.office].filter(Boolean).join(' · '));
    const review=r=>r.verificationNote?'<small class="report-verification">'+esc(r.verificationNote)+(safeURL(r.verificationUrl)?' <a href="'+esc(safeURL(r.verificationUrl))+'" target="_blank" rel="noopener">Supporting observation</a>':'')+'</small>':'';
    const lines=filtered.slice(page*pageSize,(page+1)*pageSize).map(r=>{
      const located=Number.isFinite(r.latitude)&&Number.isFinite(r.longitude);
      const loc=located?'<button type="button" class="locate" data-report="'+esc(r.id)+'">'+esc(place(r))+'</button>':esc(place(r))+'<small>Location text only</small>';
      return '<tr><td>'+loc+'</td><td>'+esc(r.label||r.phenomenon)+(r.phenomenon!==r.label&&r.phenomenon?'<small>'+esc(r.phenomenon)+'</small>':'')+'</td><td>'+esc(reportAmount(r)||'Event report')+'<small>'+esc([r.qualifier,reportPeriod(r)].filter(Boolean).join(' · '))+'</small>'+review(r)+'</td><td>'+esc(asDate(r.observedAt)||'Unspecified')+'<small>Issued '+esc(asDate(r.issuedAt)||'time unspecified')+'</small></td><td>'+link(r)+'</td></tr>';
    }).join('');
    get('report-table').innerHTML='<div class="scroll-table"><table><thead><tr><th scope="col">Location</th><th scope="col">Phenomenon</th><th scope="col">Measurement</th><th scope="col">Observed UTC</th><th scope="col">Bulletin / WFO</th></tr></thead><tbody>'+lines+'</tbody></table></div>';
    get('report-pager').innerHTML='<span>'+(page*pageSize+1)+'–'+Math.min((page+1)*pageSize,filtered.length)+' of '+filtered.length+'</span><button type="button" data-turn="-1" '+(!page?'disabled':'')+'>Previous</button><button type="button" data-turn="1" '+(page+1===pages?'disabled':'')+'>Next</button>';
  }
  const timing=get('report-timing');
  timing.addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b)return;
    activeBin=b.hasAttribute('data-time-clear')||+b.dataset.timeBin===activeBin?-1:+b.dataset.timeBin;
    page=0;render();
    if(activeBin>=0)timing.querySelector('[data-time-bin="'+activeBin+'"]')?.focus({preventScroll:true});
  });
  for(const event of ['pointerover','focusin'])timing.addEventListener(event,e=>{
    const b=e.target.closest('[data-time-bin]');if(b)timing.querySelector('[data-time-caption]').textContent=b.getAttribute('aria-label');
  });
  tabs.addEventListener('click',e=>{
    const button=e.target.closest('button[data-hazard]');if(!button)return;
    activeCategory=button.dataset.hazard;activeBin=-1;for(const b of tabs.querySelectorAll('button'))b.setAttribute('aria-pressed',String(b===button));page=0;render();
  });
  for(const id of ['report-source','report-state','report-hours','report-search'])get(id).addEventListener(id==='report-search'?'input':'change',()=>{page=0;activeBin=-1;render();});
  get('report-pager').addEventListener('click',e=>{const b=e.target.closest('button[data-turn]');if(b){page+=Number(b.dataset.turn);render();}});
  function pick(event){const button=event.target.closest('[data-report]');if(!button)return;const row=rows.find(r=>r.id===button.dataset.report);if(row)onSelect(row);}
  get('measure-graphics').addEventListener('click',pick);get('report-table').addEventListener('click',pick);
  return {update(observations) {
    data=observations;rows=availableRows(data);
    const field=get('report-state'), prev=field.value;
    field.innerHTML='<option value="">All areas</option>'+[...new Set(rows.map(r=>r.state).filter(Boolean))].sort().map(s=>'<option value="'+esc(s)+'">'+esc(s)+'</option>').join('');
    if([...field.options].some(o=>o.value===prev))field.value=prev;
    render();
  }};
}
