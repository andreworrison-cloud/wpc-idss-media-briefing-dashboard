import {renderImpacts} from './impacts.js';
import {impactOverlay} from './impact-map.js';
import {links, freshImpact, exposureRecords} from './impact-logic.js';
import {ERO_COLORS as riskColors,WSSI_COLORS as winterColors,EXTENDED_COLORS as extendedColors,alertStyle,alertDrawOrder,appendAlertPath} from './hazard-palette.js';
import {labels,refs,total,isoTime,dayName,readable,flagText,safeURL,moduleState,usable,activeDay,activeWinter,activeOutlook,population,currentAlerts,currentReports,priorities,reportValue,messageState,parseScope,makeBrief,signed} from './logic.js';
import {officeCodes} from './offices.js';
import {resolveAlertZones} from './alert-zones.js';
const $=id=>document.getElementById(id), esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=id=>'<svg aria-hidden="true"><use href="#i-'+id+'"/></svg>';
const ext=(url,label)=>safeURL(url)?'<a href="'+esc(safeURL(url))+'" target="_blank" rel="noopener">'+esc(label)+'</a>':esc(label);
const pill=(label,state)=>'<span class="pill '+(['stale','partial','unavailable','unverified','expired'].includes(state)?'warn':state==='reference_only'?'muted':'')+'">'+esc(label)+'</span>';
const empty=t=>'<div class="blank">'+esc(t)+'</div>';
const NS='http://www.w3.org/2000/svg', atlas=$('atlas'), cart=globalThis.WpcMap, map=cart.mount(atlas);
const cacheZones=new Map();
let shiftEdition=null;
let board=null,tab='reports',page=0,loading=false,windowBox=[0,0,1000,590],counties=null,selection=null,scope={name:'',states:[],wfos:[],family:'',hours:24},briefText='';
const points=[], pageSize=8;
function node(name,attrs,parent){const n=document.createElementNS(NS,name);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);parent.append(n);return n;}
const sourceState=s=>({ok:'Current',current:'Current',partial:'Partial coverage',stale:'Last good snapshot',unavailable:'Unavailable',unverified:'Unverified',active:'Active',published:'Published · dates unconfirmed',reference_only:'Official reference',expired:'Expired',unknown:'Unverified'}[s]||readable(s));
function drawMetrics(){
 const a=board.sources.alerts, ok=usable(board,'alerts'), reportOk=usable(board,'reports'), d=activeDay(board,1), p=population(board), band=p?.bands.find(v=>v.risk===d?.highest_risk);
 const row=(label,value,note,ico,color,tint,missing=false)=>'<article class="metric '+(missing?'empty':'')+'" style="--color:'+color+';--tint:'+tint+'"><div class="metric-label">'+esc(label)+'</div><div class="symbol">'+icon(ico)+'</div><strong>'+esc(value)+'</strong><span class="context">'+esc(note)+'</span></article>';
 const compact=n=>n>=1e6?(n/1e6).toLocaleString('en-US',{maximumFractionDigits:2})+'M':total(n);
 $('metrics').innerHTML=row('Flash flood warnings',ok?total(a.ffw_count):'Unavailable',ok&&a.ffe_count!=null?total(a.ffe_count)+' flash flood emergencies':'National NWS feed','alert','#a55126','#fff1e5',!ok||a.ffw_count==null)+
 row('Local storm reports',reportOk?total(currentReports(board).length):'Unavailable','Past 24 hours · preliminary','pin','#0f716b','#e3f3ee',!reportOk)+
 row('Day 1 rainfall risk',d?(d.highest_risk||'None delineated'):'Unavailable','Highest WPC outlook category','cloud','#2f6c9b','#e8f2fb',!d)+
 row('WPC published population',band?compact(band.population):'Unavailable',band?band.risk+' Risk · all CONUS areas':'Day 1 WPC category estimate','people','#6b5394','#f1ecf8',!band);
}
function mapPopup(title,detail,link){
 $('map-pop').innerHTML='<button aria-label="Close map detail" id="close-pop">×</button><strong>'+esc(title)+'</strong>'+esc(detail)+(link?' &nbsp;'+ext(link,'Source'):'');$('map-pop').hidden=false;$('close-pop').onclick=()=>{$('map-pop').hidden=true};
}
function warningDetail(a){const record=board.impacts?.exposure?.alert_events?.[a.id];let note=a.area||a.states.join(', ');
 if(record&&Date.parse(record.fresh_until)>Date.now()&&Date.parse(record.valid_end)>Date.now()&&record.status==='current'&&Number.isFinite(record.population)){note+=' · '+total(record.population)+' estimated residents in the '+(/zone/i.test(record.basis)?'issued warning zones':'warning footprint')+' (2020 Census).';}return note;}
function drawPath(geometry,color,info,kind='forecast'){
 const d=cart.path(geometry);if(!d)return null;
 const el=node('path',{d,fill:color,'fill-opacity':kind==='alert'?'.15':'.91',stroke:color,'stroke-width':kind==='alert'?'1.7':'1.15','vector-effect':'non-scaling-stroke','fill-rule':'evenodd'},map.overlays);
 if(info){const name=node('title',{},el);name.textContent=info[0];el.onclick=e=>{if(dragged)return;e.stopPropagation();mapPopup(...info);};}
 return el;
}
function legendItem(name,color,cls='key-square'){return '<span><i class="'+cls+'"'+(color?' style="--swatch:'+color+'"':'')+'></i>'+esc(name)+'</span>';}
function drawMap(){
 if(!board)return;map.overlays.replaceChildren();points.length=0;
 const prod=$('product').value;let keys='',note='',phase='';
 if(prod.startsWith('ero')){
  const d=activeDay(board,+prod.slice(-1));
  if(d){for(const f of [...d.features].sort((a,b)=>a.properties.rank-b.properties.rank))drawPath(f.geometry,riskColors[f.properties.risk],[f.properties.risk+' Risk · Day '+d.day,'Valid '+isoTime(d.valid_start,true)+' – '+isoTime(d.valid_end,true),refs.ero]);
   phase=Date.parse(d.valid_start)>Date.now()?'Upcoming period':'In effect';note='WPC issued '+isoTime(d.issued,true)+' · Valid '+isoTime(d.valid_start,true)+' – '+isoTime(d.valid_end,true)+'.';if(d.no_risk_area)note+=' WPC delineated no area at or above Marginal Risk.';
  }else note='This WPC outlook is unavailable or outside its verified validity.';
  keys=Object.entries(riskColors).filter(([k])=>k!=='High'||+prod.slice(-1)<=3).map(([k,c])=>legendItem(k,c)).join('');
 }else if(prod==='winter'){
  const w=activeWinter(board);
  if(w){for(const f of w.features)drawPath(f.geometry,winterColors[f.properties.impact]||'#cc9eee',[f.properties.impact+' winter impacts','WSSI Days 1–3 · through '+isoTime(w.valid_end,true),refs.winter]);note='Overall WSSI · Moderate and higher categories · '+isoTime(w.valid_start,true)+' – '+isoTime(w.valid_end,true)+'.';phase='CONUS';}else note='A current winter impact layer is unavailable.';
  keys=Object.entries(winterColors).filter(([k])=>['Moderate','Major','Extreme'].includes(k)).map(([k,c])=>legendItem(k,c)).join('');
 }else if(prod==='outlook'){
  const o=activeOutlook(board);if(o){const shown=[...o.features].sort((a,b)=>Number(b.properties.group==='soils')-Number(a.properties.group==='soils'));const groups=new Map();
   for(const f of shown){const a=f.properties,c=extendedColors[a.hazard]||'#9eacbe';groups.set(a.hazard,c);drawPath(f.geometry,c,[a.hazard+' · '+a.region,dayName(a.valid_start_date)+' – '+dayName(a.valid_end_date),a.source_url]);}
   keys=[...groups].map(([n,c])=>legendItem(n,c)).join('');phase='Extended outlook';note='WPC issued '+dayName(o.issued_date)+' · Individual forecast periods appear on selection.';}else note='The current medium-range hazards outlook is unavailable.';
 }else if(['aviation','power','exposure','ground'].includes(prod)){const impact=impactOverlay(prod,board,map,legendItem,(...args)=>{if(!dragged)mapPopup(...args);},drawMap);({phase,keys,note}=impact);
 }else{phase='Current evidence';note='The map shows available alert polygons and preliminary storm report locations.';}
 if($('show-counties').checked&&counties)node('path',{d:counties,fill:'none',stroke:'#b9d2d6','stroke-width':'.35',opacity:'.58','vector-effect':'non-scaling-stroke','pointer-events':'none'},map.overlays);
 if($('show-alerts').checked){
  const types=new Map();
  for(const a of currentAlerts(board).slice().sort(alertDrawOrder))for(const g of a.geometry||[]){
   const path=appendAlertPath(map.overlays,cart.path(g),a,{fill:prod==='none'});if(!path)continue;
   path.onclick=e=>{if(dragged)return;e.stopPropagation();mapPopup(a.title,warningDetail(a),a.source_url);};
   types.set(a.title,alertStyle(a).color);
  }
  keys+=[...types].map(([name,color])=>legendItem(name,color)).join('');
 }
 if(selection){for(const g of selection.geometry||[])drawPath(g,'#ffe5ae',[selection.title,selection.role,selection.url],'alert');}
 if($('show-reports').checked){const rr=currentReports(board,24);for(const r of [...rr].reverse()){
  if(!Number.isFinite(r.lon)||!Number.isFinite(r.lat))continue;const xy=cart.project(r.lon,r.lat);if(!xy)continue;
  const el=node('circle',{cx:xy[0],cy:xy[1],r:r.impact_flags?.length?'4.5':'3.2',fill:r.impact_flags?.length?'#fff4a9':'#9af3e1',stroke:'#0f555a','stroke-width':'1.15','vector-effect':'non-scaling-stroke'},map.overlays);
  node('title',{},el).textContent=r.title+' · '+r.city+', '+r.state;el.onclick=e=>{if(dragged)return;e.stopPropagation();mapPopup(r.title+' · '+r.city+', '+r.state,isoTime(r.valid,true)+(r.impact_flags?.length?' · '+r.impact_flags.map(flagText).join(', '):''),r.source_url);};points.push(xy);
 }keys+=legendItem('24 h report',null,'key-dot');}
 $('map-phase').textContent=phase;$('map-legend').innerHTML=keys;$('map-foot').textContent=note+($('show-alerts').checked?' Zone-based alerts without a drawn boundary appear in the alert list.':'');if(prod==='power')$('map-foot').insertAdjacentHTML('beforeend',' '+ext(links.power,'Data from Power Out Map')+'.');
}
function pos(event){const rect=atlas.getBoundingClientRect();const p=atlas.createSVGPoint();p.x=event.clientX;p.y=event.clientY;const m=atlas.getScreenCTM();return m?p.matrixTransform(m.inverse()):{x:windowBox[0]+(event.clientX-rect.left)/rect.width*windowBox[2],y:windowBox[1]+(event.clientY-rect.top)/rect.height*windowBox[3]};}
function boundedView(x,y,w){
 const width=Math.max(95,Math.min(1000,w)),height=width*.59;
 windowBox=[Math.max(0,Math.min(1000-width,x)),Math.max(0,Math.min(590-height,y)),width,height];atlas.setAttribute('viewBox',windowBox.join(' '));
}
function zoom(factor,x=windowBox[0]+windowBox[2]/2,y=windowBox[1]+windowBox[3]/2){const [left,top,w]=windowBox, nw=Math.max(95,Math.min(1000,w*factor));boundedView(x-(x-left)*nw/w,y-(y-top)*nw/w,nw);}
let drag=null,dragged=false;
atlas.addEventListener('wheel',e=>{e.preventDefault();const p=pos(e),px=e.deltaMode===1?e.deltaY*13:e.deltaY;zoom(Math.exp(Math.max(-.13,Math.min(.13,px*.0017))),p.x,p.y);},{passive:false});
atlas.addEventListener('pointerdown',e=>{if(e.button!==0)return;dragged=false;drag={id:e.pointerId,x:e.clientX,y:e.clientY,box:[...windowBox]};});
atlas.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)<4&&!dragged)return;dragged=true;atlas.setPointerCapture(e.pointerId);const scale=1/(atlas.getScreenCTM()?.a||1);boundedView(drag.box[0]-dx*scale,drag.box[1]-dy*scale,drag.box[2]);});
const endDrag=()=>{drag=null;setTimeout(()=>dragged=false,30)};atlas.addEventListener('pointerup',endDrag);atlas.addEventListener('pointercancel',endDrag);
atlas.addEventListener('keydown',e=>{const [x,y,w]=windowBox;if(e.key==='+'||e.key==='=')zoom(.8);else if(e.key==='-')zoom(1.25);else if(e.key==='Home')boundedView(0,0,1000);else if(e.key.startsWith('Arrow'))boundedView(x+({ArrowLeft:-1,ArrowRight:1}[e.key]||0)*w*.09,y+({ArrowUp:-1,ArrowDown:1}[e.key]||0)*w*.09,w);else return;e.preventDefault()});
$('zoom-in').onclick=()=>zoom(.80);$('zoom-out').onclick=()=>zoom(1.25);$('zoom-reset').onclick=()=>{selection=null;boundedView(0,0,1000);$('map-pop').hidden=true;drawMap()};
$('layers-btn').onclick=()=>{const p=$('layers-pop');p.hidden=!p.hidden;$('layers-btn').setAttribute('aria-expanded',String(!p.hidden));};
document.addEventListener('click',e=>{if(!e.target.closest('.map-menu')){$('layers-pop').hidden=true;$('layers-btn').setAttribute('aria-expanded','false');}});
let savedHazardLayers=null;
function selectProduct(product,scroll=false){
 $('product').value=product;selection=null;$('map-pop').hidden=true;
 const impacts=['power','aviation','exposure','ground'].includes(product);
 if(impacts&&!savedHazardLayers){savedHazardLayers=[$('show-reports').checked,$('show-alerts').checked];$('show-reports').checked=false;$('show-alerts').checked=false;}
 if(!impacts&&savedHazardLayers){[$('show-reports').checked,$('show-alerts').checked]=savedHazardLayers;savedHazardLayers=null;}
 if(product==='none'){$('show-reports').checked=true;$('show-alerts').checked=true;}
 drawMap();if(scroll){$('map-stage').scrollIntoView?.({block:'center'});atlas.focus?.({preventScroll:true});}
}
$('product').onchange=()=>selectProduct($('product').value);
for(const btn of document.querySelectorAll('[data-map-product]'))btn.onclick=()=>selectProduct(btn.dataset.mapProduct,true);
for(const id of ['show-alerts','show-reports'])$(id).onchange=drawMap;
$('show-counties').onchange=async()=>{if(!counties&&$('show-counties').checked){try{const r=await fetch('./assets/map-counties.json');if(!r.ok)throw Error();counties=(await r.json()).d;}catch{$('show-counties').checked=false;mapPopup('County overlay unavailable','Try again after refreshing the board.');}}drawMap();};
atlas.addEventListener('click',e=>{if(dragged||!board)return;const st=e.target?.dataset?.state;if(st)mapPopup(cart.stateName(st),'Select a hazard polygon or report marker for source details.');});
function drawPriorities(){
 const cards=priorities(board);$('priorities').innerHTML=cards.length?cards.map(s=>'<article class="story" style="--accent:'+s.color+'"><div class="story-top">'+esc(s.tag)+'</div><h3>'+esc(s.title)+'</h3><p>'+esc(s.body.length>185?s.body.slice(0,182)+'…':s.body)+'</p><div class="story-action">'+ext(s.link,s.label)+'</div></article>').join(''):empty('No priority item can be verified from the current source collection.');
}
async function loadShift(){
 try{const r=await fetch('./data/handoff.json?t='+Math.floor(Date.now()/120000),{cache:'no-store'});if(r.ok){shiftEdition=(await r.json()).edition;if(board)drawMessages();}}catch{}
}
function drawMessages(){
 const list=board.sources.messages?.items||[];
 $('messages-panel').innerHTML=list.map(m=>{const status=messageState(board,m);return '<div class="item"><div>'+pill(m.owner+' · '+sourceState(status),status)+'</div><h3>'+esc(m.title)+'</h3><p>'+esc(status==='active'?'Issued '+isoTime(m.issued_at,true)+' · Expires '+isoTime(m.valid_end,true):m.note||'Check the official product.')+'</p>'+ext(m.source_url,'Open '+m.owner+' product')+'</div>';}).join('')||empty('The messaging collection is unavailable.');
 const c=board.comparison, bits=[];
 if(c&&usable(board,'alerts')&&Number.isFinite(c.ffw_delta))bits.push('National flash flood warning count '+(c.ffw_delta?'changed by '+signed(c.ffw_delta):'was unchanged')+'.');
 if(c&&usable(board,'reports')&&Array.isArray(c.new_report_ids))bits.push(total(c.new_report_ids.length)+' report record'+(c.new_report_ids.length===1?' was':'s were')+' added to the comparable rolling archive.');
 $('changes').innerHTML=bits.length?'<p class="smallprint">'+esc(isoTime(c.from,true)+' to '+isoTime(c.to,true))+'</p>'+bits.map(t=>'<p class="item">'+esc(t)+'</p>').join(''):'<p>A change summary requires two comparable, recent collections. The board will display the first verified comparison here.</p>';
 const box=document.createElement('div');box.className='item';box.innerHTML=shiftEdition?'<b>Archived '+esc(shiftEdition.slot.slice(11))+' handoff</b><p>'+esc(isoTime(shiftEdition.captured_at,true))+' collection · twelve-hour report window.</p><button class="text-btn" id="show-shift">Read shift brief</button>':'<span class="smallprint">Shift editions are saved from the first verified collection during the 00Z and 12Z handoff hours.</span>';
 $('changes').append(box);
 if($('show-shift'))$('show-shift').onclick=()=>{const ed=shiftEdition;const section=document.createElement('section');section.innerHTML='<h3>'+esc(ed.slot+' · archived brief')+'</h3>'+ed.brief.sections.map(s=>'<h4>'+esc(s.title)+'</h4>'+s.lines.map(l=>'<p>'+esc(l)+'</p>').join('')).join('')+'<ol>'+ed.brief.evidence.map(e=>'<li>'+ext(e.url,e.label)+'</li>').join('')+'</ol>';box.replaceChildren(section);};

}
function readableTable(head,rows){return '<div class="scroll-table"><table><thead><tr>'+head.map(h=>'<th scope="col">'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(cols=>'<tr>'+cols.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';}
const searchHaystack=row=>row.filter(x=>x!=null).join(' ').toLowerCase();
function drawTable(){
 let source,head,items,render,match,caption,title;
 if(tab==='reports'){source='reports';title='Preliminary storm reports';caption='Latest 24 hours by time observed. Each entry links to the issuing NWS office’s bulletin.';head=['Observed UTC','Reported hazard','Location','Measurement','Source'];items=currentReports(board,24).sort((a,b)=>Date.parse(b.valid)-Date.parse(a.valid));match=r=>searchHaystack([r.title,r.city,r.state,r.county,r.wfo,...r.impact_flags]);render=r=>['<span class="clocktime">'+esc(isoTime(r.valid,true))+'</span>',esc(r.title)+(r.impact_flags.length?'<span class="meta">'+esc(r.impact_flags.join(' · '))+'</span>':''),esc(r.city+', '+r.state),esc(reportValue(r)),ext(r.source_url,'NWS '+r.wfo)];}
 else if(tab==='alerts'){source='alerts';title='NWS active alerts';caption='Active CAP records and reconciled flash flood warning events. Select an alert to inspect its map coverage.';head=['NWS product','Affected area','Message expires','Geometry','Source'];items=currentAlerts(board).sort((a,b)=>{const rank=s=>({Extreme:4,Severe:3,Moderate:2,Minor:1}[s]||0);return rank(b.severity)-rank(a.severity)||Date.parse(b.sent)-Date.parse(a.sent)});match=r=>searchHaystack([r.title,r.area,...r.states,r.wfo]);render=r=>['<button class="text-btn find-alert" data-id="'+esc(r.id)+'">'+esc(r.title)+'</button><span class="meta">'+esc(r.states.join(', ')||r.wfo||'See source')+'</span>',esc(r.area?.length>120?r.area.slice(0,117)+'…':r.area||'See source'),esc(isoTime(r.expires,true)),esc(r.geometry?.length?'Issued polygon':r.zone_urls?.length?'NWS zones on select':'Source list only'),ext(r.source_url,'NWS '+(r.wfo||'alert'))];}
 else{source='outlook';title='WPC Days 3–7 hazards';caption='Individual forecast areas and inclusive valid dates from the issued medium-range outlook.';head=['Hazard','Region','Valid dates','Source'];items=activeOutlook(board)?.features||[];match=f=>searchHaystack(Object.values(f.properties));render=f=>{const r=f.properties;return [esc(r.hazard),esc(r.region),esc(dayName(r.valid_start_date)+' – '+dayName(r.valid_end_date)),ext(r.source_url,'WPC forecast')];};}
 const term=$('evidence-search').value.trim().toLowerCase();items=items.filter(row=>!term||match(row).includes(term));
 const pages=Math.ceil(items.length/pageSize);page=Math.max(0,Math.min(page,pages-1));$('table-title').textContent=title;$('table-caption').textContent=caption;
 $('evidence-table').innerHTML=items.length?readableTable(head,items.slice(page*pageSize,(page+1)*pageSize).map(render)):empty(!usable(board,source)?'Current source coverage is unavailable.':term?'No entries match this search.':'No matching entries in this verified selection.');
 $('table-pager').innerHTML=items.length?'<span>'+String(page*pageSize+1)+'–'+Math.min(items.length,(page+1)*pageSize)+' of '+items.length+'</span><button id="prev" '+(!page?'disabled':'')+'>Previous</button><button id="next" '+(page+1>=pages?'disabled':'')+'>Next</button>':'';
 if($('prev')){$('prev').onclick=()=>{page--;drawTable()};$('next').onclick=()=>{page++;drawTable()};}
}
let selectionEpoch=0;
$('evidence-table').onclick=async e=>{
 const btn=e.target.closest('.find-alert');if(!btn)return;const a=currentAlerts(board).find(x=>x.id===btn.dataset.id);if(!a)return;
 const epoch=++selectionEpoch;selection=null;const center=a.states.map(s=>cart.stateCenter(s)).find(Boolean);if(center)boundedView(center[0]-210,center[1]-124,420);
 if(a.geometry?.length)selection={title:a.title,geometry:a.geometry,role:'Issued NWS alert polygon.',url:a.source_url};
 drawMap();mapPopup(a.title,warningDetail(a),a.source_url);$('map-stage').scrollIntoView({block:'center'});
 if(!selection&&a.zone_urls?.length){const result=await resolveAlertZones(a,new Date(),fetch,cacheZones).catch(()=>null);if(epoch!==selectionEpoch)return;
  if(result?.geometry?.length){selection={title:a.title,geometry:result.geometry,role:result.role,url:a.source_url};drawMap();mapPopup(a.title,'NWS zone boundaries · '+(result.status==='ok'?'available':sourceState(result.status))+'. '+a.area,a.source_url);}
  else mapPopup(a.title,'The NWS zone footprint is unavailable. '+(a.area||''),a.source_url);
 }
};
for(const b of document.querySelectorAll('[data-evidence]'))b.onclick=()=>{tab=b.dataset.evidence;page=0;$('evidence-search').value='';for(const t of document.querySelectorAll('[data-evidence]'))t.setAttribute('aria-pressed',String(t===b));if(board)drawTable();};
$('evidence-search').oninput=()=>{page=0;if(board)drawTable()};
function drawSources(){
 const rows=Object.entries(labels).map(([key,label])=>{const s=board.sources[key],health=moduleState(board,key), checked=board.attempts?.[key]?.checked_at||board.health?.[key]?.retrieved_at;
 const st=key==='ero'?s?.days?.[0]?.issued:key==='outlook'?s?.issued_date:key==='winter'?s?.issued:s?.source_time;
 const why=board.attempts?.[key]?.issues?.[0]||(key==='ero'?s?.days?.[0]?.reason:s?.issues?.[0])||({alerts:'NWS nationwide CAP collection',reports:'Preliminary NWS bulletins archived by IEM',outlook:'WPC source issue date',winter:'Overall impact · Moderate and higher',messages:'WPC metadata and NWC product reference'}[key]||'');
 return ['<span class="sources-name">'+esc(label)+'</span><span class="meta">'+esc(typeof why==='string'?why:'See source bulletin')+'</span>',pill(sourceState(health),health),esc(st?.length===10?dayName(st):isoTime(st,true)),esc(isoTime(checked,true)),ext(refs[key],'Source')];});
 $('sources-table').innerHTML=readableTable(['Source','Status','Latest issue / source time','Collection attempt','Product'],rows);
 const p=population(board);$('pop-source').innerHTML=p?'<p class="smallprint" style="margin:12px 0">'+esc(p.basis)+' · Issued '+esc(isoTime(p.issued,true))+'</p>'+readableTable(['Published category','Population','Area (mi²)'],p.bands.map(v=>[esc(v.risk),total(v.population),total(v.area_sq_mi)]))+ext(p.source_url,'Official exposure table'):'<p class="smallprint">A population table matching the current Day 1 issuance is unavailable.</p>';
}
function briefChoices(recordId=$('brief-footprint').value||'',bandId=$('brief-band').value||''){
 const rows=exposureRecords(board);const choice=$('brief-footprint');
 const option=(v,label)=>'<option value="'+esc(v)+'">'+esc(label)+'</option>';
 choice.innerHTML=option('','Automatic for this hazard')+rows.map(r=>option(r.id,r.menuLabel||r.label)).join('');
 choice.value=rows.some(r=>r.id===recordId)?recordId:'';
 const bands=rows.find(r=>r.id===choice.value)?.bands||[];
 $('brief-band-field').hidden=!bands.length;$('brief-band').innerHTML=option('','All mapped categories')+bands.map(b=>option(b.id,b.label)).join('');
 $('brief-band').value=bands.some(b=>b.id===bandId)?bandId:'';
}
$('brief-footprint').onchange=()=>briefChoices($('brief-footprint').value,'');
function useFootprint(record,band,state){
 const family=String(record.family||'').toLowerCase();
 $('brief-states').value=state||'';$('brief-wfos').value='';$('brief-family').value=[...$('brief-family').querySelectorAll('option')].some(o=>o.value===family)?family:'';
 briefChoices(record.id,band?.id||'');location.hash='brief';$('brief-form').requestSubmit();
}
function drawBrief(){
 if(!board)return;const b=makeBrief(board,scope);const head='Draft for forecaster review · '+b.area+' · '+b.scope+' · '+b.window+' h of reports';
 const sections=b.sections.map(s=>'<section><h3>'+esc(s.title)+'</h3><ul>'+s.lines.map(t=>'<li>'+esc(t)+'</li>').join('')+'</ul></section>').join('');
 $('brief-output').innerHTML='<div class="kicker">Briefing draft</div><h2>'+esc(b.title)+'</h2><p>'+esc(head)+'</p><p class="draft-meta">Generated '+esc(b.asof)+' &nbsp;·&nbsp; Collection '+esc(b.snapshot)+'</p>'+sections+'<h3>Source evidence</h3><ol>'+b.evidence.map(e=>'<li>'+ext(e.url,e.label)+'</li>').join('')+'</ol>';
 briefText=b.title+'\n'+head+'\nGenerated '+b.asof+' · Collection '+b.snapshot+'\n\n'+b.sections.map(s=>s.title+'\n'+s.lines.map(l=>'• '+l).join('\n')).join('\n\n')+'\n\nSource evidence\n'+b.evidence.map((e,i)=>(i+1)+'. '+e.label+' '+e.url).join('\n');
}
$('brief-form').onsubmit=e=>{e.preventDefault();if(!board)return;try{const location=parseScope($('brief-states').value,$('brief-wfos').value);
 const supported=new Set([...officeCodes,...[...(board.sources.alerts?.events||[]),...(board.sources.reports?.events||[])].map(r=>r.wfo).filter(Boolean)]);
 if(location.wfos.some(w=>!supported.has(w)))throw Error('This code does not match the NWS forecast office directory. Check the identifier or use a state selection.');
 scope={...location,name:$('brief-name').value.trim(),family:$('brief-family').value,hours:Number($('brief-hours').value),exposure_id:$('brief-footprint').value||'',band_id:$('brief-band').value||''};$('form-error').textContent='';drawBrief();$('copy-note').textContent='Brief generated.';}catch(err){$('form-error').textContent=err.message;}};
$('copy').onclick=async()=>{if(!board)return;drawBrief();try{await navigator.clipboard.writeText(briefText);$('copy-note').textContent='Brief and source links copied.';}catch{const r=document.createRange();r.selectNodeContents($('brief-output'));const s=getSelection();s.removeAllRanges();s.addRange(r);$('copy-note').textContent='The brief is selected. Use your browser’s Copy command.';}};
$('print').onclick=()=>{if(board){drawBrief();print();}};
function route(){const view=['brief','sources'].includes(location.hash.slice(1))?location.hash.slice(1):'board';for(const n of ['board','brief','sources'])$(n+'-view').hidden=n!==view;for(const a of document.querySelectorAll('[data-nav]')){if(a.dataset.nav===view)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}if(board){if(view==='brief')drawBrief();if(view==='sources')drawSources();}window.scrollTo(0,0);}
window.addEventListener('hashchange',route);
function render(){renderImpacts(board,selectProduct,useFootprint);briefChoices();drawMetrics();drawMap();drawPriorities();drawTable();drawMessages();drawSources();drawBrief();const stale=Object.keys(labels).filter(k=>!['ok','partial'].includes(moduleState(board,k)));
 const status=$('sync-status');const impacts=board.impacts||{};const limited=stale.length||!freshImpact(impacts.power,Date.now(),35)||!freshImpact(impacts.aviation,Date.now(),30)||!freshImpact(impacts.ground?.rivers,Date.now(),60);status.style.setProperty('--status',board.storage==='unavailable'||limited?'#e9ac4a':'#56cfb0');status.textContent=(board.mode==='reviewed_snapshot'?'Saved collection ':'Collection ')+isoTime(board.captured_at,true)+(limited?' · limited feeds':'');}
async function refresh(){if(loading)return;loading=true;const b=$('refresh');b.disabled=true;try{const r=await fetch('./data/board.json?t='+Math.floor(Date.now()/120000),{cache:'no-store'});if(!r.ok)throw Error();const v=await r.json();if(v.schema!==1||!v.sources)throw Error();board=v;render();}catch{if(board)render();$('sync-status').textContent=board?'Refresh unavailable · saved '+isoTime(board.captured_at,true):'Unable to load briefing data';}finally{loading=false;b.disabled=false;}}
$('refresh').onclick=refresh;
function tick(){$('clock').textContent=new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}).toUpperCase()+'  /  '+isoTime(new Date());}
route();tick();refresh();loadShift();setInterval(tick,15000);setInterval(()=>{if(!document.hidden){if(board)render();refresh();loadShift();}},120000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
