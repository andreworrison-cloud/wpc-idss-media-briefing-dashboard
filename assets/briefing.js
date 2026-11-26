import {readRelease,recoverRelease} from './release.js';
import {mountOverview} from './overview.js';
import {mountImpactStrip} from './impact-strip.js';
import {mountFocusDesk} from './focus-desk.js';
import {currentRadar} from './browser-radar.js';
import {renderImpacts,selectedExposure,selectExposureFocus,powerLevel,setPowerLevel} from './impacts.js';
import {exposureRecords,currentGroundReports,impactNames} from './impact-logic.js';
import {inkFor} from './hazard-palette.js';
import {officeCodes} from './offices.js';
import {labels,refs,safeURL,isoTime,dayName,readable,moduleState,activeDay,activeOutlook,currentAlerts,priorities,messageState,population,makeBrief,parseScope} from './logic.js';
import {mountObservationDesk,appendObservedBrief,reportPresentation} from './observed-graphics.js';

const $ = id=>document.getElementById(id);
const esc = value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time = v=>Number.isFinite(Date.parse(v))?isoTime(v,true):'Unspecified';
const fmt = v=>Number.isFinite(v)?v.toLocaleString('en-US'):'Unavailable';
function publicURL(raw) {
  const normal=safeURL(raw); if(normal)return normal;
  try{
    const url=new URL(raw);
    if(url.protocol!=='https:'||url.username||url.password)return null;
    if(url.hostname==='andreworrison-cloud.github.io'&&url.pathname.startsWith('/wpc-hydro-dashboard/'))return url.href;
    if(url.hostname==='raw.githubusercontent.com'&&url.pathname.startsWith('/andreworrison-cloud/wpc-hydro-dashboard/'))return url.href;
    if(['noaa-mrms-pds.s3.amazonaws.com','noaa-mrms-pds.s3.us-east-1.amazonaws.com'].includes(url.hostname))return url.href;
  }catch{}
  return null;
}
const source=(href,label)=>publicURL(href)?'<a href="'+esc(publicURL(href))+'" target="_blank" rel="noopener">'+esc(label)+'</a>':esc(label);
const option=(val,label)=>'<option value="'+esc(val)+'">'+esc(label)+'</option>';
const table=(headers,lines)=>'<div class="scroll-table"><table><thead><tr>'+headers.map(x=>'<th scope="col">'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+lines.map(row=>'<tr>'+row.map(v=>'<td>'+v+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
const impactIDs=['exposure','power','aviation','ground'];
const blankScope=()=>({name:'',states:[],wfos:[],family:'',hours:24,exposure_id:'',band_id:''});
let board=null, handoff=null, map=null, mapModuleFailed=false, product='radar', currentImpact='exposure', loading=false;
let scope=blankScope(), briefText='', catalogPage=0, catalogRows=[], legend=null, loop=null, frame=null, frameStamp=null;
const notices=new Map();
const views = new Set([...document.querySelectorAll('[data-view]')].map(el=>el.dataset.view));
let visualOverview=null;
let appearance=document.documentElement.dataset.theme==='light'?'light':'dark';
function applyAppearance(theme,persist=false) {
  appearance=theme;
  document.documentElement.dataset.theme=theme;
  const target=theme==='dark'?'light':'dark';
  const label=target==='light'?'Light mode':'Dark mode';
  const button=$('theme-toggle');
  button.querySelector('span').textContent=label;
  button.querySelector('use').setAttribute('href','#i-'+(target==='light'?'sun':'moon'));
  button.setAttribute('aria-label','Switch to '+target+' mode');
  button.title='Switch to '+target+' mode';
  document.querySelector('meta[name="theme-color"]').content=theme==='dark'?'#0b1521':'#f3f4f1';
  $('base-style').value=theme;
  map?.setBasemap(theme);visualOverview?.refreshTheme();
  if(persist){try{localStorage.setItem('wpc-idss-appearance',theme);}catch{}}
}
$('theme-toggle').onclick=()=>applyAppearance(appearance==='dark'?'light':'dark',true);
$('base-style').onchange=e=>map?.setBasemap(e.target.value);
applyAppearance(appearance);
function writeDetail(info) {
  if(!info)return;
  const el=$('map-detail'), lines=info.lines?.length?info.lines:info.detail?[info.detail]:[];
  el.innerHTML='<button type="button" aria-label="Close map detail">×</button><b>'+esc(info.title||'Map detail')+'</b> '+lines.map(esc).join(' · ')+(publicURL(info.url)?' · '+source(info.url,'Open source'):'')+(publicURL(info.verificationUrl)?' · '+source(info.verificationUrl,'Supporting observation'):'');
  el.hidden=false;el.querySelector('button').onclick=()=>{el.hidden=true;};
}
function writeLegend(result) {
  if(result)legend=result;
  const data=legend;
  if(!data)return;
  const items=data.items||[];
  const radarBins=items.filter(x=>/^-?\d+(?:\.\d+)? dBZ$/i.test(x.label) && /^#[a-f0-9]{6}$/i.test(x.color))
    .map(x=>({value:parseFloat(x.label),color:x.color,item:x})).sort((a,b)=>a.value-b.value);
  // Use the provider's numeric bins. Keep a provider's categorical or irregular legend intact.
  const gap=radarBins.length>1 ? radarBins[1].value-radarBins[0].value : 0;
  const continuous=radarBins.length>=4 && gap>0 && radarBins.every((b,i)=>i===0||b.value-radarBins[i-1].value===gap);
  const hiddenItems=new Set(continuous?radarBins.map(b=>b.item):[]);
  const focusKey=$('map-focus-key');
  const symbols=items.filter(x=>!hiddenItems.has(x) && (focusKey.hidden||x.label!==focusKey.textContent));
  const binWidth=100/radarBins.length;
  const steps=continuous?radarBins.map((b,i)=>{
    const tick=i===0||i===radarBins.length-1||i%Math.ceil(radarBins.length/5)===0;
    return '<span class="radar-bin" title="'+b.value+' dBZ" style="width:'+binWidth+'%;--bin:'+b.color+'">'+(tick?'<small>'+b.value+'</small>':'')+'</span>';
  }).join(''):'';
  const strip=continuous?'<div class="radar-scale" role="img" aria-label="Radar reflectivity scale in dBZ: '+radarBins.map(b=>b.value).join(', ')+'"><b>Reflectivity <span>(dBZ)</span></b><div>'+steps+'</div></div>':'';
  $('map-legend').innerHTML=strip+symbols.map(x=>{
    const color=/^#[0-9a-f]{3,8}$/i.test(x.color||'')?x.color:'#69818a';
    const shape=String(x.shape||'square').toLowerCase().replace(/[^a-z-]/g,'');
    const icons={snow:'snow',ice:'ice',rain:'rain',wind:'wind',hail:'hail',cold:'cold',heat:'heat',effect:'alert',plane:'plane',gauge:'ground',impact:'ground'};
    const icon=icons[shape];
    const mark=icon?'<span class="legend-glyph" aria-hidden="true" style="--swatch:'+color+';--glyph-ink:'+inkFor(color)+'"><svg><use href="#i-'+icon+'"/></svg></span>':'<i class="'+shape+'" style="--swatch:'+color+'"></i>';
    return '<span class="legend-item">'+mark+esc(x.label||x.name||'')+'</span>';
  }).join('');
  const weather=board?.weather||{}, obj=product==='radar'?weather.radar:product==='mpd'?weather.mpd:product==='winter'?weather.winter?.layers?.find(l=>l.id===$('winter-layer').value):null;
  let href=obj?.source_url;
  $('map-phase').textContent=product==='radar'&&obj?[obj.domain,obj.units].filter(Boolean).join(' · '):data.phase||'';
  if(product==='radar')href=obj?.source_url||obj?.source_data_url||obj?.dashboard_url;
  const label=product==='radar'?(obj?.provider||'Radar source'):product==='mpd'?'WPC MetWatch':'Official product';
  $('map-foot').innerHTML=esc(data.note||'')+(publicURL(href)?' · '+source(href,label):'');
}
function mapNotice(update) {
  const key=update?.layer;if(!key)return;
  if(['unavailable','partial','error','stale','failed'].includes(update.status)&&update.message)notices.set(key,update.message);
  else notices.delete(key);
  $('map-notice').textContent=[...new Set(notices.values())].join(' ');
}
function stopLoop(){if(loop)clearInterval(loop);loop=null;$('radar-loop').textContent='Play loop';$('radar-loop').setAttribute('aria-pressed','false');}
const validRadar=()=>board?.weather?.radar?.status==='current'&&Date.parse(board.weather.radar.fresh_until)>Date.now();
function radarFrames(){return validRadar()?(board.weather.radar.frames||[]).filter(v=>v.image_url&&Number.isFinite(Date.parse(v.valid_time))):[];}
function syncControls() {
  $('power-control').hidden=product!=='power'; $('map-power-level').value=powerLevel();
  $('winter-control').hidden=product!=='winter'; $('observation-control').hidden=product!=='observations';
  const primary=product==='winter'&&$('winter-layer').value==='winter_alerts'?'winter_alerts':product;
  const enabled=new Set([primary]);
  for(const [id,layer] of Object.entries({'show-radar':'radar','show-alerts':'alerts','show-mpds':'mpd','show-reports':'observations','show-counties':'counties'})){
    if($(id).checked)enabled.add(layer);
  }
  $('layer-count').textContent=String(enabled.size);
  $('layer-count').setAttribute('aria-label',enabled.size+' active map '+(enabled.size===1?'layer':'layers'));
  const frames=radarFrames(), showFrames=(product==='radar'||$('show-radar').checked)&&frames.length>1;
  $('radar-controls').hidden=!showFrames;
  if(!showFrames)stopLoop();
  for(const b of document.querySelectorAll('[data-product]'))b.setAttribute('aria-pressed',String(b.dataset.product===product||b.dataset.product==='ero1'&&product.startsWith('ero')));
}
async function startMap() {
  try{
    const {mountCommandMap,MAP_REGIONS}=await import('./command-map.js?v=20261126');
    if(MAP_REGIONS)$('region').innerHTML=Object.entries(MAP_REGIONS).map(([key,rec])=>option(key,rec.label||key)).join('');
    $('region').value='CONUS';
    map=mountCommandMap($('atlas'),{basemap:$('base-style').value,basemapControl:false,
      onBasemapChange:key=>{$('base-style').value=key;},onLegend:writeLegend,onDetail:writeDetail,onStatus:mapNotice});
    updateMap(true);
  }catch{mapModuleFailed=true;$('map-foot').textContent='The geographic map could not be loaded. Source-linked measurements and impact details remain available below.';}
}
function updateMap(newBoard=false) {
  syncControls();focusDesk.syncMapKey(product);if(!map)return;
  const pick=board?selectedExposure(board):{};
  const query={product,powerMode:({auto:'auto',state:'states',county:'counties'})[powerLevel()],reportHours:Number($('report-hours').value)||48, layers:{reports:$('show-reports').checked,alerts:$('show-alerts').checked,mpds:$('show-mpds').checked,radar:$('show-radar').checked,counties:$('show-counties').checked},observation:$('map-observation').value,source:$('report-source').value||'all',winterLayer:$('winter-layer').value||'winter_alerts',radarFrame:frame,exposureRecord:pick.record||null,exposureBand:pick.band||null,exposureState:pick.state||''};
  query.briefingFocus=product==='radar'?focusDesk.mapContext():null;
  if(newBoard||!board)query.board=board;
  map.update(query);
}
function showMap(name, scroll=false) {
  if(![...$('product').options].some(o=>o.value===name))return;
  if(name!==product){stopLoop();$('map-detail').hidden=true;for(const key of [...notices.keys()])if(key!=='basemap')notices.delete(key);$('map-notice').textContent=[...notices.values()].join(' ');}
  if(scroll)navigate('board');
  product=name;$('product').value=name;updateMap();
  const titles={radar:'U.S. hazard map',winter:'Winter weather',mpd:'Mesoscale Precipitation Discussions',alerts:'NWS watches, warnings and advisories',observations:'Measured weather reports',outlook:'Days 3–7 hazards',power:'Utility outages',aviation:'Air travel',ground:'Ground impacts',exposure:'Resident exposure'};
  $('map-heading').textContent=titles[name]||('Day '+name.slice(3)+' excessive rainfall');
  if(scroll)requestAnimationFrame(()=>{$('map-stage').scrollIntoView({block:'start'});});
}
function showImpact(id) {
  if(!impactIDs.includes(id))return;
  currentImpact=id;
  for(const pane of document.querySelectorAll('[data-impact-pane]'))pane.hidden=pane.dataset.impactPane!==id;
  for(const b of document.querySelectorAll('[data-impact-layer]')){
    b.setAttribute('aria-pressed',String(b.dataset.impactLayer===id));b.setAttribute('aria-controls',b.dataset.impactLayer+'-panel');
    b.setAttribute('aria-label','Show '+b.querySelector('.metric-label').textContent+' details');
    b.onclick=()=>{showImpact(b.dataset.impactLayer);};
  }
}
function focusReport(row) {
  const info=reportPresentation(row),located=Number.isFinite(row.latitude)&&Number.isFinite(row.longitude);
  navigate('board');
  if(located){$('map-observation').value=row.category||'all';showMap('observations');map?.focus({...row,...info});}
  writeDetail(info);$('map-stage').scrollIntoView({block:'start'});
}
const kpiStrip=mountImpactStrip($('impact-strip'),(id,choice)=>{
  if(id==='exposure' && board){
    selectExposureFocus(board,choice);
    renderImpactDetails();
  }
  showImpact(id);navigate('impacts');
});
const focusDesk=mountFocusDesk({
  onChange() { visualOverview?.updateFocus(focusDesk.getSelection());kpiStrip.update(board,focusDesk.getSelection());showMap('radar');map?.fitBriefing(); },
  onScopeChange() { updateMap(); },
  onFit() {
    showMap('radar');
    if (map?.fitBriefing()) $('map-stage').scrollIntoView({block:'nearest'});
  },
  onLocate(row) {
    if (!map || !Number.isFinite(row.longitude) || !Number.isFinite(row.latitude)) {
      writeDetail(reportPresentation(row));
    } else {
      showMap('radar');
      map.focus({...row,...reportPresentation(row)});
    }
    $('map-stage').scrollIntoView({block:'nearest'});
  }
});
if($('forecast-previews'))visualOverview=mountOverview((id,region)=>{
  if(id==='winter'&&[...$('winter-layer').options].some(o=>o.value==='wssi_d1'))$('winter-layer').value='wssi_d1';
  showMap(id,true);
  if([...$('region').options].some(o=>o.value===region)){$('region').value=region;map?.region(region);}
});
$('overview-exposure-map')?.addEventListener('click',()=>{
  const selection=focusDesk.getSelection();
  if(!board||!selection)return;
  selectExposureFocus(board,selection);renderImpactDetails();showMap('exposure',true);
});
const settings=$('map-settings');
function closeLayers(){settings.open=false;settings.querySelector('summary').focus({preventScroll:true});}
$('close-layers').onclick=closeLayers;
document.addEventListener('pointerdown',e=>{if(settings.open&&!settings.contains(e.target))settings.open=false;});
settings.addEventListener('keydown',e=>{if(e.key==='Escape'){closeLayers();}});
const reports=mountObservationDesk(focusReport);
for(const b of document.querySelectorAll('[data-product]'))b.addEventListener('click',()=>{showMap(b.dataset.product);settings.open=false;});
for(const b of document.querySelectorAll('[data-map-product]'))b.onclick=()=>{
  if(b.id!=='overview-county-map'){showMap(b.dataset.mapProduct,true);return;}
  const state=document.querySelector('#overview-power .state-tile.is-selected')?.dataset.code;
  setPowerLevel('county');
  if($('outage-level'))$('outage-level').value='county';
  showMap('power',true);
  if(state&&map)map.focusOutage(state,{popup:false}).catch(()=>{
    if(product==='power')mapNotice({layer:'stateFocus',status:'partial',message:'State boundaries are unavailable. Use the region selector to reposition the map.'});
  });
};
$('product').onchange=e=>{showMap(e.target.value);closeLayers();};
$('region').onchange=e=>map?.region(e.target.value);
$('zoom-in').onclick=()=>map?.zoomBy(.5);$('zoom-out').onclick=()=>map?.zoomBy(-.5);
$('map-power-level').onchange=e=>{setPowerLevel(e.target.value);if($('outage-level'))$('outage-level').value=powerLevel();updateMap();};
for(const id of ['show-reports','show-alerts','show-mpds','show-radar','show-counties','winter-layer','map-observation','report-source','report-hours'])$(id).addEventListener('change',()=>updateMap());
$('radar-frame').onchange=e=>{stopLoop();frame=Number(e.target.value);frameStamp=radarFrames()[frame]?.valid_time||null;updateMap();};
$('radar-loop').onclick=()=>{
  if(loop){stopLoop();return;}const frames=radarFrames();if(frames.length<2)return;
  $('radar-loop').textContent='Pause loop';$('radar-loop').setAttribute('aria-pressed','true');
  loop=setInterval(()=>{if(document.hidden||!validRadar()){stopLoop();return;}frame=((frame??frames.length-1)+1)%frames.length;frameStamp=frames[frame].valid_time;$('radar-frame').value=String(frame);updateMap();},850);
};
function configureProducts() {
  const winter=board?.weather?.winter?.layers||[], selected=$('winter-layer').value||'winter_alerts';
  const standard=[['winter_alerts','NWS winter warnings, watches and advisories'],['wssi_d1_3','WSSI overall impacts · Days 1–3']];
  const available=winter.length?winter.map(l=>[l.id,l.title]):standard;
  $('winter-layer').innerHTML=available.map(([key,label])=>option(key,label)).join('');
  $('winter-layer').value=available.some(([id])=>id===selected)?selected:available[0][0];
  const radar=board?.weather?.radar;
  $('product').querySelector('option[value="radar"]').textContent=radar?.label?'Radar · '+radar.label:'Weather radar reflectivity';
  const frames=radarFrames(), wasLatest=frameStamp==null;
  $('radar-frame').innerHTML=frames.map((f,i)=>option(i,time(f.valid_time))).join('');
  const idx=frameStamp?frames.findIndex(f=>f.valid_time===frameStamp):-1;
  frame=!wasLatest&&idx>=0?idx:frames.length?frames.length-1:null;
  if(frame!=null)$('radar-frame').value=String(frame);
  if(wasLatest||idx<0)frameStamp=null;
}
function renderPriorities() {
  const rows=priorities(board), ground=currentGroundReports(board?.impacts?.ground?.reports)[0];
  if(ground?.url&&ground.categories?.length){
    const type=ground.categories.map(c=>impactNames[c]||readable(c)).join(' and ');
    rows.unshift({title:type+' · '+[ground.location,ground.state].filter(Boolean).join(', '),body:'A preliminary NWS report was observed '+time(ground.observedAt)+'.',link:ground.url,label:'Read bulletin'});
  }
  const used=new Set(), section=rows.filter(r=>{const k=r.link+'|'+r.title;if(used.has(k))return false;used.add(k);return true;}).slice(0,3);
  $('priorities').innerHTML=section.map(r=>'<article class="story"><b>'+esc(r.title)+'</b><p>'+esc(r.body||'')+'</p>'+source(r.link,r.label||'Open source')+'</article>').join('')||'<p class="empty">Current briefing priorities are unavailable.</p>';
}
function renderMessages() {
  const list=board.sources.messages?.items||[];
  $('messages-panel').innerHTML=list.map(m=>'<article><b>'+esc(m.title)+'</b><p>'+esc([m.owner,readable(messageState(board,m)),m.issued_at?'Issued '+time(m.issued_at):m.note].filter(Boolean).join(' · '))+'</p>'+source(m.source_url,'Open official product')+'</article>').join('')||'<p class="empty">Current messaging collection unavailable.</p>';
  const c=board.comparison, bits=[];
  if(c?.to&&c?.from)bits.push('Compared '+time(c.from)+' with '+time(c.to)+'.');
  if(Number.isFinite(c?.ffw_delta))bits.push('National flash flood warning change '+(c.ffw_delta>0?'+':'')+c.ffw_delta+'.');
  if(c?.new_report_ids)bits.push(fmt(c.new_report_ids.length)+' newly archived local storm report records.');
  const ed=handoff?.edition, archived=ed?.brief?.sections||[];
  $('changes').innerHTML=(bits.length?bits.map(s=>'<p>'+esc(s)+'</p>').join(''):'<p class="empty">Two comparable recent collections are needed for change counts.</p>')+(archived.length?'<details><summary>Archived shift brief · '+esc(ed.slot)+'</summary>'+archived.map(s=>'<h4>'+esc(s.title)+'</h4>'+s.lines.map(t=>'<p>'+esc(t)+'</p>').join('')).join('')+(ed.brief.evidence||[]).map(x=>source(x.url,x.label)).join(' · ')+'</details>':'');
}
function renderCatalog() {
  const q=$('catalog-search').value.trim().toLowerCase(), all=currentAlerts(board).map(a=>({title:a.title,area:a.area||a.states?.join(', '),period:'Expires '+time(a.expires),item:a,href:a.source_url,type:'NWS alert'}));
  for(const f of activeOutlook(board)?.features||[]){const a=f.properties||{};all.push({title:a.hazard,area:a.region,period:dayName(a.valid_start_date)+' – '+dayName(a.valid_end_date),item:{...a,geometry:f.geometry},href:a.source_url,type:'WPC outlook'});}
  catalogRows=all.filter(r=>!q||[r.title,r.area,r.item.wfo,r.type].join(' ').toLowerCase().includes(q));
  const n=10,pages=Math.ceil(catalogRows.length/n);catalogPage=Math.max(0,Math.min(catalogPage,pages-1));
  if(!catalogRows.length){$('catalog').innerHTML='<p class="empty">No verified issued products match this selection.</p>';$('catalog-pager').replaceChildren();return;}
  $('catalog').innerHTML=table(['Issued product','Area','Valid or expiry','Source'],catalogRows.slice(catalogPage*n,(catalogPage+1)*n).map((r,i)=>['<button type="button" class="locate" data-catalog="'+(catalogPage*n+i)+'">'+esc(r.title)+'</button><small>'+esc(r.type)+'</small>',esc(r.area||'See bulletin'),esc(r.period),source(r.href,'Source')]));
  $('catalog-pager').innerHTML='<span>Page '+(catalogPage+1)+' of '+pages+'</span><button data-move="-1" '+(!catalogPage?'disabled':'')+'>Previous</button><button data-move="1" '+(catalogPage+1===pages?'disabled':'')+'>Next</button>';
}
$('catalog-search').oninput=()=>{catalogPage=0;if(board)renderCatalog();};$('catalog-pager').onclick=e=>{const b=e.target.closest('[data-move]');if(b){catalogPage+=Number(b.dataset.move);renderCatalog();}};
$('catalog').onclick=e=>{const b=e.target.closest('[data-catalog]');if(!b)return;const row=catalogRows[Number(b.dataset.catalog)];showMap(row.type==='NWS alert'?'alerts':'outlook',true);map?.focus({...row.item,title:row.title,url:row.href});writeDetail({title:row.title,lines:[row.area,row.period].filter(Boolean),url:row.href});};
function renderSources() {
  const w=board.weather||{}, obs=w.observations||{}, src=obs.sources||{};
  const entries=[['Radar reflectivity',w.radar,w.radar?.valid_time,w.radar?.checked_at,w.radar?.source_url||w.radar?.source_data_url||w.radar?.dashboard_url],['WPC Mesoscale Precipitation Discussions',w.mpd,w.mpd?.features?.[0]?.properties?.issued,w.mpd?.checked_at,w.mpd?.source_url],['Winter products',w.winter,w.winter?.collected_at,w.winter?.retrieved_at,'https://www.weather.gov/wssi/'],['NWS Local Storm Reports',src.lsr,src.lsr?.latestIssuedAt,obs.checkedAt,src.lsr?.sourceUrl],['NWS Public Information Statements',src.pns,src.pns?.latestIssuedAt,obs.checkedAt,src.pns?.sourceUrl]];
  const health=v=>!v?'Unavailable':v.fresh_until&&Date.parse(v.fresh_until)<=Date.now()?'Stale':readable(v.status||'unavailable');
  $('weather-source-rows').innerHTML=table(['Product','Coverage','Product / latest issue','Collection','Evidence'],entries.map(([name,v,t,check,url])=>[esc(name)+(v?.note?'<small>'+esc(v.note)+'</small>':''),esc(health(v)),esc(time(t)),esc(time(check)),source(url,'Source')]));
  $('sources-table').innerHTML=table(['Source','Status','Collection','Evidence'],Object.entries(labels).map(([key,label])=>[esc(label),esc(readable(moduleState(board,key))),esc(time(board.attempts?.[key]?.checked_at||board.health?.[key]?.retrieved_at)),source(refs[key],'Source')]));
  const p=population(board);$('pop-source').innerHTML=p?'<details><summary>Published WPC Day 1 risk-category population</summary><p class="caption">'+esc(p.basis)+' · Issued '+esc(time(p.issued))+'</p>'+table(['WPC category','Population','Area (mi²)'],p.bands.map(r=>[esc(r.risk),fmt(r.population),fmt(r.area_sq_mi)]))+source(p.source_url,'Official WPC estimate')+'</details>':'';
}
function chooseBrief(recordId=$('brief-footprint').value,bandId=$('brief-band').value) {
  const records=exposureRecords(board), record=records.find(r=>r.id===recordId);
  $('brief-footprint').innerHTML=option('','Automatic for this hazard')+records.map(r=>option(r.id,r.menuLabel||r.label)).join('');
  $('brief-footprint').value=record?.id||'';
  const bands=record?.bands||[];$('brief-band-field').hidden=!bands.length;$('brief-band').innerHTML=option('','All mapped categories')+bands.map(b=>option(b.id,b.label)).join('');$('brief-band').value=bands.some(b=>b.id===bandId)?bandId:'';
}
function useFootprint(record,band,state) {
  $('brief-states').value=state||'';$('brief-wfos').value='';const f=String(record.family||'').toLowerCase();$('brief-family').value=[...$('brief-family').options].some(o=>o.value===f)?f:'';
  chooseBrief(record.id,band?.id||'');location.hash='brief';$('brief-form').requestSubmit();
}
function renderBrief() {
  if(!board)return;
  const b=appendObservedBrief(makeBrief(board,scope),board.weather?.observations,scope);
  const heading=b.area+' · '+b.scope+' · '+b.window+' h of reports', stamp='Generated '+b.asof+' · Collection '+b.snapshot;
  $('brief-output').innerHTML='<h2>'+esc(b.title)+'</h2><p>'+esc(heading)+'</p><p class="caption">'+esc(stamp)+' · Draft for forecaster review</p>'+b.sections.map(s=>'<section><h3>'+esc(s.title)+'</h3><ul>'+s.lines.map(v=>'<li>'+esc(v)+'</li>').join('')+'</ul></section>').join('')+'<h3>Source evidence</h3><ol>'+b.evidence.map(v=>'<li>'+source(v.url,v.label)+'</li>').join('')+'</ol>';
  briefText=b.title+'\n'+heading+'\n'+stamp+'\n\n'+b.sections.map(s=>s.title+'\n'+s.lines.map(t=>'• '+t).join('\n')).join('\n\n')+'\n\nSource evidence\n'+b.evidence.map((v,i)=>(i+1)+'. '+v.label+' '+v.url).join('\n');
}
$('brief-footprint').onchange=()=>chooseBrief($('brief-footprint').value,'');
$('brief-form').onsubmit=e=>{e.preventDefault();if(!board)return;try{
  const geo=parseScope($('brief-states').value,$('brief-wfos').value), known=new Set([...officeCodes,...(board.sources.alerts?.events||[]).map(r=>r.wfo),...(board.sources.reports?.events||[]).map(r=>r.wfo)]);
  if(geo.wfos.some(w=>!known.has(w)))throw Error('Check the three-letter forecast office identifier.');
  scope={...geo,name:$('brief-name').value.trim(),family:$('brief-family').value,hours:+$('brief-hours').value,exposure_id:$('brief-footprint').value,band_id:$('brief-band').value};
  $('form-error').textContent='';renderBrief();$('copy-note').textContent='Brief generated.';
}catch(err){$('form-error').textContent=err.message;}};
$('copy').onclick=async()=>{if(!board)return;renderBrief();try{await navigator.clipboard.writeText(briefText);$('copy-note').textContent='Brief and source links copied.';}catch{const range=document.createRange();range.selectNodeContents($('brief-output'));const s=getSelection();s.removeAllRanges();s.addRange(range);$('copy-note').textContent='Brief selected. Use your browser’s Copy command.';}};
$('print').onclick=()=>{if(board){renderBrief();window.print();}};
function route() {
  const hash=location.hash.slice(1), view=views.has(hash)?hash:hash==='issued'?'products':hash==='main'?document.querySelector('[data-view]:not([hidden])')?.dataset.view||'board':'board';
  for(const section of document.querySelectorAll('[data-view]'))section.hidden=section.dataset.view!==view;
  for(const a of document.querySelectorAll('[data-nav]')){
    if(a.dataset.nav===view)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
  }
  settings.open=false;
  if(view==='board')map?.invalidateSize();
  if(view==='brief')renderBrief();
  if(hash!=='main')window.scrollTo({top:0});
}
function navigate(view) {
  if(!views.has(view))return;
  if(location.hash!=='#'+view)history.pushState(null,'','#'+view);
  route();
}
document.querySelector('nav[aria-label="Dashboard"]').addEventListener('click',event=>{
  const link=event.target.closest('[data-nav]');
  if(!link||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
  event.preventDefault();navigate(link.dataset.nav);
});
window.addEventListener('hashchange',route);
function renderImpactDetails(){
  renderImpacts(board,(id,openMap)=>{showImpact(id);showMap(id,openMap);},useFootprint);
}
function render() {
  $('impact-strip').setAttribute('aria-busy','false');
  focusDesk.update(board);kpiStrip.update(board,focusDesk.getSelection());visualOverview?.update(board,focusDesk.getSelection());configureProducts();
  renderImpactDetails();showImpact(currentImpact);
  reports.update(board.weather?.observations);updateMap(true);renderPriorities();renderMessages();renderSources();renderCatalog();chooseBrief();renderBrief();
  const t=board.recovery?.collectorRevision||board.revision||board.captured_at;
  const stale=Date.now()-Date.parse(t)>30*60000;
  $('sync-status').textContent=board.recovery?.collectorRevision?'Live sources checked '+time(t)+' · Full edition '+time(board.recovery.publicationRevision):(stale?'Saved edition · ':'Collection · ')+time(t);
}

function moreRecentRadar(candidate,prior){
  if(!candidate)return prior;
  if(!prior)return candidate;
  const candidateTime=Date.parse(candidate.valid_time), priorTime=Date.parse(prior.valid_time);
  if(!Number.isFinite(priorTime))return candidate;
  if(!Number.isFinite(candidateTime))return prior;
  return candidateTime>priorTime || (candidateTime===priorTime && Date.parse(candidate.checked_at)>Date.parse(prior.checked_at)) ?candidate:prior;
}

async function refresh(){
  if(loading)return; loading=true;$('refresh').disabled=true;
  try{
    const saved=await readRelease('board',fetch,Date.now(),{onSaved:early=>{
      if(!board){board=early;render();}
    }});
    const publication=board?.recovery?.publicationRevision||board?.revision;
    const savedTime=Date.parse(saved.revision);
    let active=publication && Date.parse(publication)>=savedTime && board?.recovery?board:saved;
    let radar=moreRecentRadar(board?.weather?.radar,active.weather?.radar);
    const paint=next=>{
      active=next;
      radar=moreRecentRadar(next.weather?.radar,radar);
      board=radar && radar!==next.weather?.radar?{...next,weather:{...next.weather,radar}}:next;
      render();
    };
    paint(active);
    await Promise.allSettled([
      currentRadar(active).then(next=>{
        const best=moreRecentRadar(next,radar);
        if(best && best!==radar){
          radar=best;board={...active,weather:{...active.weather,radar}};
          configureProducts();updateMap(true);renderSources();
        }
      }),
      recoverRelease(active,{onUpdate:paint})
    ]);
  }
  catch{if(board){focusDesk.update(board);kpiStrip.update(board,focusDesk.getSelection());visualOverview?.update(board,focusDesk.getSelection());updateMap();$('sync-status').textContent='Refresh unavailable · Last collection '+time(board.revision);}else{focusDesk.update(null);kpiStrip.update(null,null);visualOverview?.update(null,null);$('impact-strip').setAttribute('aria-busy','false');$('sync-status').textContent='Current briefing collection unavailable';reports.update(null);for(const id of ['priorities','ground-panel','exposure-panel','weather-source-rows','impact-source-rows','sources-table'])$(id).textContent='Current collection unavailable.';
    $('brief-output').textContent='A current collection is required to generate a source-linked briefing.';
    $('power-panel').innerHTML='<p>Current utility figures are unavailable. '+source('https://poweroutage.us/','PowerOutage.us map')+' · '+source('https://poweroutmap.com/','Power Out Map')+'</p>';
    $('aviation-panel').innerHTML='<p>Current FAA notices are unavailable. '+source('https://nasstatus.faa.gov/','FAA status')+' · '+source('https://www.flightaware.com/live/cancelled/today/US','U.S. flight delays and cancellations on FlightAware')+'</p>';if(!mapModuleFailed)$('map-foot').textContent='Current weather layers unavailable.';}}
  finally{loading=false;$('refresh').disabled=false;}
}
async function loadShift(){try{handoff=await readRelease('handoff');if(board)renderMessages();}catch{}}
function clock(){$('clock').textContent=new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date())+' UTC';}
$('refresh').onclick=()=>{refresh();loadShift();};clock();setInterval(clock,15000);
setInterval(()=>{if(!document.hidden){refresh();loadShift();}},120000);document.addEventListener('visibilitychange',()=>{if(document.hidden)stopLoop();else refresh();});
kpiStrip.update(null,null);
for(const node of $('impact-strip').querySelectorAll('.kpi-context'))node.textContent='Loading source data…';
for(const node of $('impact-strip').querySelectorAll('.kpi-time'))node.textContent='';
showImpact(currentImpact);route();startMap();refresh();loadShift();
