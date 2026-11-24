import {activeDay,activeWinter,activeOutlook,currentAlerts,isoTime,refs,readable,safeURL} from './logic.js';
import {freshImpact,activeAirEvents,currentRivers,currentGroundReports,gaugeColors,impactNames,countText,recent,links} from './impact-logic.js';
import {selectedExposure,powerLevel} from './impacts.js';
import {ERO_COLORS,WSSI_COLORS,EXTENDED_COLORS,alertStyle} from './hazard-palette.js';
import {loadOutageAtlas,renderOutageOverlay,OUTAGE_LEGEND} from './outage-map.js';
const svgNS='http://www.w3.org/2000/svg';
let atlasPromise=null, countyAtlas=null, atlasFailed=false;
function node(name,attrs,parent){const el=parent.ownerDocument.createElementNS(svgNS,name);for(const [key,value] of Object.entries(attrs))el.setAttribute(key,value);parent.append(el);return el;}
function marker(map,lon,lat,shape,color,title,detail,url,popup) {
  const pos=globalThis.WpcMap.project(lon,lat);if(!pos)return;
  const group=node('g',{transform:`translate(${pos[0]} ${pos[1]})`,class:'impact-map-point','aria-label':title},map.overlays);
  const attrs={fill:color,stroke:'#0b182c','stroke-width':'1.6','vector-effect':'non-scaling-stroke'};
  if(shape==='diamond')node('path',{...attrs,d:'M0,-6 L6,0 L0,6 L-6,0 Z'},group);
  else if(shape==='plane')node('path',{...attrs,d:'M0,-8 L2,-3 L7,0.5 L7,2 L2,1 L1.4,5 L3.4,7 L3.4,8 L0,7 L-3.4,8 L-3.4,7 L-1.4,5 L-2,1 L-7,2 L-7,.5 L-2,-3 Z'},group);
  else node('circle',{...attrs,r:5},group);
  node('title',{},group).textContent=title+' · '+detail;group.onclick=e=>{e.stopPropagation();popup(title,detail,url);};
}
const noteTime=t=>isoTime(t,true);
const selectState=(el,fn)=>{el.onclick=e=>{e.stopPropagation();fn();};};
function exposureMap(board,map,legend,popup){
  const {record,band,state}=selectedExposure(board);
  if(!record)return {phase:'Exposure unavailable',keys:'',note:'A current footprint estimate is unavailable.'};
  const rows=(band||record).states||[], palette=['#425a76','#357da0','#36a7bf','#5cd3cb','#a6ede1'];
  const bins=[1,10000,100000,1000000,5000000], colors=[...bins].map((v,i)=>[v,palette[i]]);
  const states=new Map([...map.land.querySelectorAll('[data-state]')].map(el=>[el.dataset.state,el]));
  for(const r of rows){const base=states.get(r.code);if(!base||r.population<=0||state&&r.code!==state)continue;
    const c=colors.filter(([v])=>r.population>=v).at(-1)?.[1];
    const el=node('path',{d:base.getAttribute('d'),fill:c,stroke:state===r.code?'white':'#8fa4ba','stroke-width':state===r.code?2:.6,'vector-effect':'non-scaling-stroke','data-exposure-state':r.code},map.overlays);
    const name=globalThis.WpcMap.stateName(r.code)||r.code;const detail=`${countText(r.population)} estimated residents inside the selected footprint in ${name}.`;
    node('title',{},el).textContent=detail;selectState(el,()=>popup(record.label,detail,links.census));
  }
  const group=node('g',{'pointer-events':'none'},map.overlays);
  if(state&&states.has(state)){const clip=node('clipPath',{id:'selected-exposure-state'},map.overlays);node('path',{d:states.get(state).getAttribute('d')},clip);group.setAttribute('clip-path','url(#selected-exposure-state)');}
  const ids=new Set(record.feature_ids||[]), alertIds=new Set(record.alert_ids||[]);let features=[];
  if(record.group==='ero')features=(activeDay(board,record.day)?.features||[]).filter(f=>!band||f.properties.rank===band.rank).map(f=>[f.geometry,ERO_COLORS[f.properties.risk]]);
  if(record.group==='winter')features=(activeWinter(board)?.features||[]).filter(f=>!band||f.properties.impact===band.label).map(f=>[f.geometry,WSSI_COLORS[f.properties.impact]]);
  if(record.group==='outlook')features=(activeOutlook(board)?.features||[]).filter(f=>ids.has(f.id)||ids.has(f.properties?.id)).map(f=>[f.geometry,EXTENDED_COLORS[f.properties.hazard]]);
  if(record.group==='alerts')features=currentAlerts(board).filter(a=>alertIds.has(a.id)).flatMap(a=>(a.geometry||[]).map(g=>[g,alertStyle(a).color]));
  for(const [geo,color] of features){const d=globalThis.WpcMap.path(geo);if(d){node('path',{d,fill:'none',stroke:'#091628','stroke-width':3,'vector-effect':'non-scaling-stroke'},group);node('path',{d,fill:'none',stroke:color||'#ffffff','stroke-width':1.55,'vector-effect':'non-scaling-stroke'},group);}}
  const keys=['1–9,999','10,000–99,999','100,000–999,999','1–4.99M','5M+'].map((l,i)=>legend(l,palette[i])).join('');
  return {phase:'2020 Census estimate',keys,note:`${record.label}${band?' · '+band.label:''}. State shading shows estimated residents within the selected hazard. ${features.length?'Lines trace the published hazard boundaries.':'Issued polygons may be unavailable for zone-based alerts.'}`};
}
export function impactOverlay(product,board,map,legend,popup,redraw){
  const data=board.impacts||{};
  if(product==='exposure')return exposureMap(board,map,legend,popup);
  if(product==='aviation'){
    const a=data.aviation;
    for(const e of activeAirEvents(a).slice().reverse()){const operational=Boolean(e.delay||e.kind==='ground_stop'||e.kind==='airport_closure');marker(map,e.lon,e.lat,'plane',operational?'#ffd166':'#8acbff',e.airport+' · '+e.airport_name,[e.label,e.delay,e.reason||e.scope].filter(Boolean).join(' · '),e.source_url||links.aviation,popup);}
    return {phase:'FAA airport status',keys:legend('Delay, ground stop or closure','#ffd166','key-plane')+legend('Other operating notice','#8acbff','key-plane'),note:freshImpact(a,Date.now(),30)?'FAA notices in effect · '+noteTime(a.as_of)+'. A symbol represents an airport program. Select an airport for its cause and timing.':'Current FAA airport notices are unavailable.'};
  }
  if(product==='ground'){
    const g=data.ground||{};for(const r of [...currentRivers(g.rivers)].reverse())marker(map,r.longitude,r.latitude,'circle',gaugeColors[r.category],r.name+', '+r.state,readable(r.category)+' flooding · '+[r.value,r.unit].filter(v=>v!=null).join(' ')+' · '+noteTime(r.observedAt),r.url,popup);
    for(const r of currentGroundReports(g.reports))marker(map,r.longitude,r.latitude,'diamond','#71e0ca',r.location+', '+r.state,(r.categories||[]).map(k=>impactNames[k]||readable(k)).join(' · ')+' · '+noteTime(r.observedAt),r.url,popup);
    return {phase:'Observations',keys:Object.entries(gaugeColors).map(([k,c])=>legend(readable(k)+' flooding',c,'key-circle')).join('')+legend('Ground impact report','#71e0ca','key-diamond'),note:'Circles show NWPS flood-stage observations in the last six hours. Diamonds show preliminary NWS disruption reports in the last 24 hours. Select a marker for the original source.'};
  }
  if(product!=='power')return null;
  const p=data.power,level=powerLevel(),stamp=level==='state'?p?.states_as_of:p?.counties_as_of, status=level==='state'?p?.states_status:p?.counties_status;
  if(!freshImpact(p,Date.now(),35)||status!=='current'||!recent(stamp,Date.now(),35))return {phase:'Coverage unavailable',note:'Current '+level+' outage readings are unavailable. Data from Power Out Map.',keys:''};
  if(!countyAtlas&&!atlasFailed){if(!atlasPromise)atlasPromise=loadOutageAtlas().then(a=>{countyAtlas=a;redraw();}).catch(()=>{atlasFailed=true;redraw();});return {phase:'Loading county geography',note:'Loading Census outage-map boundaries.',keys:''};}
  if(!countyAtlas)return {phase:'Geography unavailable',keys:'',note:'The outage geography could not be loaded. The power panel lists current reported figures.'};
  renderOutageOverlay(map.overlays,countyAtlas,p,{level,onSelect:row=>{
    const name=row.name||row.label||row.fips||row.state||'Selected area';const n=row.customers_out;
    popup(name,Number.isFinite(n)?`${countText(n)} electric customer accounts reported without power · ${noteTime(stamp)}.`:'No outage figure is reported for this area.',links.power);
  }});
  const keys=OUTAGE_LEGEND.map(l=>legend(l.label,l.color,l.id==='missing'?'key-no-data':'key-square')).join('');
  return {phase:level==='county'?'County outages':'State outages',keys,note:`Reported electric customer accounts without power by ${level} · ${noteTime(stamp)}. Hatching indicates missing coverage.`,credit:true};
}
