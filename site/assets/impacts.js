import {isoTime, safeURL, readable, refs} from './logic.js';
import {links, countText, freshImpact, activeAirEvents, currentRivers, currentGroundReports, exposureRecords, residentCount, impactNames, recent} from './impact-logic.js';

const byId=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const url=(href,label)=>safeURL(href)?`<a href="${esc(safeURL(href))}" rel="noopener" target="_blank">${esc(label)}</a>`:'';
const note=s=>`<p class="impact-note">${esc(s)}</p>`;
const when=v=>isoTime(v,true);
const sourceLine=(items,asof='')=>`<div class="impact-links">${items.filter(Boolean).join(' · ')}${asof?' <span>· '+esc(when(asof))+'</span>':''}</div>`;
const summary=(n,label)=>`<div class="impact-summary"><strong class="impact-value">${esc(n)}</strong><span class="impact-unit">${esc(label)}</span></div>`;
const pct=n=>Number.isFinite(n)?n.toLocaleString('en-US',{maximumFractionDigits:1})+'%':null;
const short=n=>Number.isFinite(n)&&n>=1e6?(n/1e6).toLocaleString('en-US',{maximumFractionDigits:1})+'M':countText(n);
const stateName=code=>globalThis.WpcMap?.stateName(code)||code;
const formSelect=(id,label,items)=>`<label class="impact-field" for="${id}">${esc(label)}<select id="${id}">${items.map(([v,l,selected])=>`<option value="${esc(v)}"${selected?' selected':''}>${esc(l)}</option>`).join('')}</select></label>`;
function table(headers,rows) {
  return `<div class="scroll-table"><table><thead><tr>${headers.map(x=>`<th scope="col">${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>'<tr>'+r.map(x=>'<td>'+x+'</td>').join('')+'</tr>').join('')}</tbody></table></div>`;
}
function extendedList(title,content) {return `<details class="impact-more"><summary>${esc(title)}</summary>${content}</details>`;}
function unavailable(label,value) {return note((value?.status==='stale'||(value?.as_of&&!freshImpact(value)))?'The last '+label+' collection is stale. Current figures are unavailable.':'Current '+label+' figures are unavailable.');}
const metric=(label,value,detail,iconName,product)=>`<article class="metric metric-${product}"><div class="metric-label">${esc(label)}</div><div class="symbol"><svg aria-hidden="true"><use href="#i-${iconName}"/></svg></div><strong>${esc(value)}</strong><span class="context">${esc(detail)}</span></article>`;
const selected={record:'ero-d1',state:'',band:'',powerLevel:'county'};
export function selectedExposure(board,now=Date.now()) {
  const recs=exposureRecords(board,now), record=recs.find(r=>r.id===selected.record)||recs[0];
  const band=(record?.bands||[]).find(b=>b.id===selected.band)||null;
  return {record,band,state:selected.state,recs};
}
export const powerLevel=()=>selected.powerLevel;
function metrics(board) {
  const {aviation:a,power:p,ground:g}=board.impacts||{};
  const rivers=g?.rivers,eventCount=activeAirEvents(a).length;
  const airCount=freshImpact(a,Date.now(),30)&&a.event_count!==null?new Set(activeAirEvents(a).map(e=>e.airport)).size:null;
  const day=exposureRecords(board).find(r=>r.id==='ero-d1');
  const topBand=(day?.bands||[]).filter(b=>b.population>0).sort((x,y)=>y.rank-x.rank)[0];
  byId('impact-metrics').innerHTML=metric('Customers without power',short(freshImpact(p,Date.now(),35)?p.customers_out:null),'U.S. reporting utilities · all causes','power','power')+
   metric('Airports with FAA notices',countText(airCount),airCount===null?'Current FAA programs unavailable':`${eventCount} active ${eventCount===1?'notice':'notices'} · National Airspace System`,'plane','aviation')+
   metric(topBand?`Residents in ${topBand.label} Risk`:'Residents in Day 1 ERO',short(topBand?.population??day?.population),topBand?'Highest populated Day 1 category · 2020 Census':'2020 Census · forecast exposure','people','exposure')+
   metric('Gauges in flood',countText(freshImpact(rivers,Date.now(),60)&&rivers.total!==null?currentRivers(rivers).length:null),'Minor, moderate or major · observed','ground','ground');
}
function powerPanel(p,onMap) {
  const target=byId('power-panel');
  const live=freshImpact(p,Date.now(),35), states=live&&p.states_status==='current'&&recent(p.states_as_of,Date.now(),35)?p.states:[];
  const rows=states.filter(r=>r.customers_out>0).slice(0,5), max=rows[0]?.customers_out||1;
  const mapPick=formSelect('outage-level','Heatmap geography',[['county','Counties',selected.powerLevel==='county'],['state','States',selected.powerLevel==='state']]);
  const bars=rows.map(r=>`<li class="impact-rank"><span>${esc(r.name)}</span><span class="rank-bar" aria-hidden="true"><i style="width:${100*r.customers_out/max}%"></i></span><b>${countText(r.customers_out)}</b></li>`).join('');
  target.innerHTML=(live?summary(countText(p.customers_out),'electric customer accounts without power')+note([Number.isFinite(p.reporting_utilities)?countText(p.reporting_utilities)+' utilities reporting':null,Number.isFinite(p.coverage_percent)?pct(p.coverage_percent)+' estimated customer coverage':null].filter(Boolean).join(' · ')) :unavailable('utility',p))+
    (bars?`<h4>States with the most reported outages</h4><ol class="impact-ranks">${bars}</ol>`:'')+mapPick+note('An account may serve a home or business. Unreported counties appear hatched. The utility counts include outages from all causes.')+sourceLine([url(links.power,'Data from Power Out Map'),url(links.powerTracker,'PowerOutage.us map')],p?.as_of);
  byId('outage-level').onchange=e=>{selected.powerLevel=e.target.value;onMap('power',true);};
}
function airPanel(a) {
  const live=freshImpact(a,Date.now(),30), events=activeAirEvents(a), rank=e=>e.kind==='ground_stop'?0:e.delay?1:e.kind==='airport_closure'?2:3;
  const sorted=[...events].sort((x,y)=>rank(x)-rank(y));
  const row=e=>[`${esc(e.airport)}<span class="meta">${esc(e.airport_name)}</span>${e.flight_counts_url?'<span class="meta">'+url(e.flight_counts_url,'Airport flight totals')+'</span>':''}`,esc(e.label)+`<span class="meta">${esc(e.reason||e.scope)}</span>`,esc(e.delay||'See notice')+(e.end_utc?`<span class="meta">${esc(e.end_label||'Through')} ${esc(when(e.end_utc))}</span>`:'')];
  const total=new Set(events.map(e=>e.airport)).size;
  let html=live?summary(countText(total),'airports under active FAA notices')+(sorted.length?table(['Airport','FAA notice / cause','Reported delay'],sorted.slice(0,4).map(row)):note('FAA listed no active airport programs in this collection.')):unavailable('FAA',a);
  if(sorted.length>4)html+=extendedList('All '+sorted.length+' active notices',table(['Airport','FAA notice / cause','Reported delay'],sorted.map(row)));
  const planned=live?(a.scheduled_events||[]).filter(e=>Date.parse(e.start_utc)>Date.now()):[];
  if(planned.length)html+=extendedList('Upcoming issued notices ('+planned.length+')',table(['Airport','Notice','Starts UTC'],planned.map(e=>[esc(e.airport),esc(e.label),esc(when(e.start_utc))])));
  html+=`<div class="flight-totals"><strong>U.S. flight delays &amp; cancellations today</strong>${url(a?.flight_counts?.url||links.flights,'View live FlightAware totals')}</div>`;
  const monthly=a?.monthly_context;
  if(monthly?.status==='historical')html+=extendedList('Historical U.S. domestic flight totals · '+monthly.period_label,table(['BTS reporting month','Delayed arrivals (15+ min)','Cancellations'],[[esc(monthly.period_label),countText(monthly.delayed_arrivals),countText(monthly.cancelled)]])+note(monthly.coverage+'. '+countText(monthly.flight_operations)+' flight operations in the reporting month.')+sourceLine([url(monthly.source_url,'BTS monthly statistics')]));
  byId('aviation-panel').innerHTML=html+sourceLine([url(links.aviation,'FAA NAS Status')],a?.as_of);
}
function exposurePanel(board,onMap,openBrief) {
  const {recs,record,band,state}=selectedExposure(board);
  const container=byId('exposure-panel');
  if(!record){container.innerHTML=unavailable('hazard exposure',board.impacts?.exposure)+sourceLine([url(links.census,'U.S. Census Bureau')]);return;}
  selected.record=record.id;
  const options=recs.map(r=>[r.id,r.menuLabel||r.label,r.id===record.id]);
  const bands=record.bands||[], geography=band?.states||record.states||[];
  if(selected.state&&!geography.some(s=>s.code===selected.state))selected.state='';
  const region=selected.state;
  const amount=residentCount(record,region?[region]:[],band);
  const partial=record.status==='partial';
  let countLabel=region?'residents in '+stateName(region):'residents inside the mapped footprint';
  if(band)countLabel+=' · '+band.label+' only';
  const mapped=region||band?null:record.mapped_population;
  let html=`<div class="impact-controls">${formSelect('exposure-product','Hazard footprint',options)}${bands.length?formSelect('exposure-band','Category',[['','All mapped categories',!band],...bands.map(b=>[b.id,b.label,b.id===band?.id])]):''}${formSelect('exposure-state','Geography',[['','All covered states and territories',!region],...geography.slice().sort((a,b)=>stateName(a.code).localeCompare(stateName(b.code))).map(s=>[s.code,stateName(s.code),region===s.code])])}</div>`;
  html+=amount!==null?summary(countText(amount),countLabel):Number.isFinite(mapped)&&mapped>0?summary('At least '+countText(mapped),'residents in the resolved portions'):note('A complete population estimate is unavailable for this footprint.');
  if(record.valid_start||record.valid_end)html+=note('Valid '+when(record.valid_start)+' – '+when(record.valid_end));
  if((partial||record.group==='alerts'||amount===0)&&record.coverage)html+=note(record.coverage);
  if(amount===0&&record.zero_basis==='no_populated_center_in_footprint')html+=note('No populated Census center matched this footprint. Small or sparsely populated areas may still contain residents.');
  if(!region&&geography.length)html+=extendedList('Population by state or territory',table(['State or territory','Estimated residents'],[...geography].sort((a,b)=>b.population-a.population).map(s=>[esc(stateName(s.code)),countText(s.population)])));
  const source=record.source_url||refs[record.group];
  const method='Each 2020 Census block group contributes its residents once when its population center falls inside the selected footprint. Estimates describe forecast or warning exposure.';
  container.innerHTML=html+note(method)+sourceLine([url(links.census,'2020 U.S. Census'),source?url(source,'Issued hazard'):null],record.as_of||board.impacts.exposure.calculated_at);
  container.insertAdjacentHTML('beforeend','<button class="button small use-footprint" id="brief-with-footprint" type="button">Use this footprint in a media brief</button>');
  byId('brief-with-footprint').onclick=()=>openBrief(record,band,region);
  byId('exposure-product').onchange=e=>{selected.record=e.target.value;selected.band='';selected.state='';exposurePanel(board,onMap,openBrief);onMap('exposure',false);};
  const pick=byId('exposure-band');if(pick)pick.onchange=e=>{selected.band=e.target.value;exposurePanel(board,onMap,openBrief);onMap('exposure',false);};
  byId('exposure-state').onchange=e=>{selected.state=e.target.value;exposurePanel(board,onMap,openBrief);onMap('exposure',false);};
}
function groundPanel(g) {
  const rivers=g?.rivers, reports=g?.reports, gauges=currentRivers(rivers), rr=currentGroundReports(reports);
  let html='';
  if(freshImpact(reports,Date.now(),60)) {
    html+=summary(reports.total==null?'Partial':countText(rr.length),'preliminary reports of disruption · past '+reports.periodHours+' h');
    if(rr.length)html+=table(['Impact','Location','Observed UTC'],rr.slice(0,4).map(r=>[url(r.url,(r.categories||[]).map(k=>impactNames[k]||readable(k)).join(' · ')),esc(r.location+', '+r.state),esc(when(r.observedAt))]));
    else html+=note('No qualifying disruptions in the available NWS reports for this window.');
  } else html+=unavailable('ground-impact report',reports);
  if(freshImpact(rivers,Date.now(),60)){
    const cn=k=>gauges.filter(r=>r.category===k).length;
    html+=`<h4>Observed flooding at gauges</h4>`+note((rivers.total==null?'Available sites · ':'')+`${cn('major')} major · ${cn('moderate')} moderate · ${cn('minor')} minor`);
    if(gauges.length)html+=extendedList('View '+gauges.length+' gauge observations',table(['Gauge','Observed category','Reading UTC'],gauges.map(r=>[url(r.url,r.name+', '+r.state),esc(readable(r.category))+(Number.isFinite(r.value)?`<span class="meta">${esc(r.value)} ${esc(r.unit)}</span>`:''),esc(when(r.observedAt))])));
  }else html+=unavailable('river gauge',rivers);
  byId('ground-panel').innerHTML=html+sourceLine([url(links.reports,'Preliminary NWS reports via IEM')],reports?.asOf)+sourceLine([url(links.rivers,'NOAA river observations')],rivers?.asOf);
}
function sources(data){
  const nodes=[['Electric utility outages',data.power,'as_of',links.power,'Power Out Map'],['Airport programs and delays',data.aviation,'as_of',links.aviation,'FAA NAS Status'],['Resident exposure',data.exposure,'calculated_at',links.census,'U.S. Census Bureau'],['Observed river stages',data.ground?.rivers,'asOf',links.rivers,'NOAA NWPS'],['Reports of ground impacts',data.ground?.reports,'asOf',links.reports,'NWS via IEM']];
  byId('impact-source-rows').innerHTML=table(['Impact source','Status','Source or calculation time','Evidence'],nodes.map(([label,v,key,link,by])=>[esc(label),esc(v?(freshImpact(v,Date.now(),key==='asOf'?60:35)?readable(v.status):'Stale / unavailable'):'Unavailable'),esc(when(v?.[key])),url(link,by)]));
}
export function renderImpacts(board,onMap,openBrief){metrics(board);const d=board.impacts||{};powerPanel(d.power,onMap);airPanel(d.aviation);exposurePanel(board,onMap,openBrief);groundPanel(d.ground);sources(d);}
