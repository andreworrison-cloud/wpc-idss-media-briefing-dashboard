import {ASSET_ROOT,MAP_REGIONS,geometryNear,mountBase,BASEMAP_CHOICES} from './geographic-base.js';
import {utc,detailNode,decorate,observationsOnMap,reportPoint,POINT_COLORS,POINT_LABELS} from './map-points.js';
import {activeDay,activeWinter,activeOutlook,currentAlerts,currentReports,moduleState,refs} from './logic.js';
import {activeAirEvents,currentRivers,currentGroundReports,exposureRecords,gaugeColors,impactNames,links} from './impact-logic.js';
import {ERO_COLORS,ERO_OUTLINES,WSSI_COLORS,EXTENDED_COLORS,alertStyle,inkFor} from './hazard-palette.js';
import {resolveAlertZones} from './alert-zones.js';
import {alertOutline,indexWinterShapes,loadAlertGIS} from './active-alert-shapes.js';
export {MAP_REGIONS,BASEMAP_CHOICES};

const GOOD=new Set(['ok','current','partial','active','published','none']);
const fmt=n=>Number.isFinite(n)?n.toLocaleString('en-US'):'';
const cleanColor=s=>/^#[0-9a-f]{6}$/i.test(s||'')?s:'#617C8C';
const period=(a,b)=>[utc(a),utc(b)].filter(Boolean).join(' – ');
const key=(label,color,shape='square')=>({label,color,shape});
const safeSource=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}};
const nowValue=x=>typeof x==='function'?Number(x()):Number.isFinite(x)?x:Date.now();
const validUntil=(val,now)=>!val||Date.parse(val)>now;
const fresh=(row,now)=>Boolean(row&&GOOD.has(String(row.status||'current').toLowerCase())&&validUntil(row.fresh_until,now));
const asFeatures=source=>Array.isArray(source)?source:source?.features||[];
const imageBounds=b=>Array.isArray(b)&&b.length===2&&b.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite))&&b[0][0]<b[1][0]&&b[0][1]<b[1][1]&&b[0][0]>=-85.0512&&b[1][0]<=85.0512;
function imageURL(value,allowEmbedded) {
  if(allowEmbedded&&typeof value==='string'&&value.startsWith('data:image/png;base64,'))return value;
  return safeSource(value);
}
export function localRadarImage(radar,frame,assetRoot,pageOrigin){
  if(!radar?.local_image||!/^[a-f0-9]{64}$/.test(radar.image_sha256||''))return null;
  const time=Date.parse(radar.valid_time);
  if(!Number.isFinite(time)||frame&&(Date.parse(frame.valid_time)!==time||frame.image_url!==radar.image_url))return null;
  const stamp=new Date(time).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const path='radar/'+stamp+'-'+radar.image_sha256+'.png';
  if(radar.local_image!==path)return null;
  const url=new URL(path,assetRoot);
  return url.origin===pageOrigin?url.href:null;
}
// Only current issued geometry belongs to the briefing outline. Forecast windows can start later.
export function briefingFeatures(input,now=Date.now()){
  if(!input||!validUntil(input.valid_end,now)||!validUntil(input.fresh_until,now))return [];
  const features=[];
  function add(entry,properties={}){
    if(!entry)return;
    if(Array.isArray(entry)){entry.forEach(f=>add(f,properties));return;}
    const p=entry.properties||properties,g=entry.geometry||entry;
    if(!validUntil(p.valid_end||p.expires,now))return;
    if(g.type==='FeatureCollection'){add(g.features,p);return;}
    if(g.type==='GeometryCollection'){add(g.geometries,p);return;}
    if(['Polygon','MultiPolygon','LineString','MultiLineString'].includes(g.type)&&g.coordinates?.length){
      features.push(entry.type==='Feature'?entry:{type:'Feature',geometry:g,properties:p});
    }
  }
  add(input.features||input.geometry);
  return features;
}
function briefingStyle(f,selection) {
  const p=f.properties||{}, hazard=p.event||p.hazard;
  const title=p.event||p.hazard||(p.risk?p.risk+' Risk':p.impact||p.label)||selection.label||'Selected hazard';
  const color=p.color||ERO_COLORS[p.risk]||WSSI_COLORS[p.impact]||EXTENDED_COLORS[p.hazard]
    ||(hazard&&alertStyle(hazard).known?alertStyle(hazard).color:null)||selection.color;
  return {title,color:cleanColor(color)};
}
export function outageMapReading(status) {
  const level=status.level==='county'?'County':'State';
  const time=utc(status.as_of);
  const period=time?' · '+time:'';
  let reading;
  if(status.status==='current')reading=level+' readings'+period+'. Reported electric customer accounts without power.';
  else if(status.status==='stale')reading=level+' outage readings have expired'+period+'. Current counts are unavailable.';
  else if(status.status==='inconsistent')reading=level+' outage reporting geography is inconsistent'+period+'.';
  else reading=level+' outage readings are unavailable'+period+'.';
  if(status.geometry_status==='unavailable')reading+=' The geographic boundaries could not be loaded.';
  else if(status.geometry_status==='partial')reading+=' Some geographic boundaries could not be loaded.';
  return reading;
}
function makePanes(map) {
  // Leaflet tilePane is 200, tooltipPane is 650 and popupPane is 700.
  for(const [name,z] of Object.entries({land:155,backdrop:170,hydrography:180,outages:340,raster:348,forecast:370,counties:399,borders:410,alerts:430,mpds:445,briefing:447,labels:450,points:510,callouts:525,selected:535})) {
    const pane=map.createPane('idss-'+name);pane.style.zIndex=z;
    if(['backdrop','land','hydrography','labels','borders','raster','counties'].includes(name))pane.style.pointerEvents='none';
  }
}
export function mountCommandMap(container,options={}) {
  const L=options.L||globalThis.L;
  if(!L?.map)throw Error('Leaflet 1.9.4 is required');
  if(!container||container.namespaceURI==='http://www.w3.org/2000/svg')throw Error('The map needs an HTML container');
  const doc=container.ownerDocument,root=new URL(options.assetBase||ASSET_ROOT,document.baseURI).href;
  container.classList.add('idss-map');container.setAttribute('data-testid','idss-map');
  container.setAttribute('role','region');if(!container.hasAttribute('aria-label'))container.setAttribute('aria-label','Interactive U.S. weather and impacts map');
  const map=L.map(container,{crs:L.CRS.EPSG3857,minZoom:2,maxZoom:16,worldCopyJump:false,zoomSnap:.125,zoomDelta:.25,wheelPxPerZoomLevel:350,
    wheelDebounceTime:35,scrollWheelZoom:true,touchZoom:true,dragging:true,keyboard:true,boxZoom:true,doubleClickZoom:true,
    zoomControl:options.zoomControl??!doc.getElementById('zoom-in'),preferCanvas:false,attributionControl:true,zoomAnimation:true});
  makePanes(map);
  const scene=L.layerGroup().addTo(map), reportsLayer=L.layerGroup().addTo(map), selectedLayer=L.layerGroup().addTo(map);
  const briefingLayer=L.layerGroup().addTo(map),warningsLayer=L.layerGroup().addTo(map);
  const state={board:null,briefingFocus:null,product:'ero1',reportHours:48,observation:'all',source:'all',winterLayer:'wssi_d1_3',radarFrame:null,
    layers:{alerts:false,reports:true,radar:false,winter:false,mpds:true,counties:false}};
  let dead=false,ref=null,points=[],pointIndex=new Map(),pointTimer,autopanning=false,selectionEpoch=0,legendSerial='',lastLegend=null;
  let countyLayer=null,countyEpoch=0,countyRenderer=null;
  let powerLayer=null,powerImport=null,powerSignature=null,powerStatus=null,powerLayers=null,previousPowerMode=null,previousPowerActive=null;
  const zoneCache=new Map();
  let gisShapes=null,gisPending=false,gisAfter=0,gisFailed=false,warningCache=null;
  let briefingCache=null;
  let radarKey='',radarImage=null,radarInfo=null;
  const base=mountBase(L,map,{root,style:options.basemap,tiles:options.tiles??true,showControl:options.basemapControl!==false,onStyleChange:options.onBasemapChange,onStatus:emitStatus,onReference:g=>{ref=g;if(state.product==='exposure')render();}});
  function emitStatus(info){if(!dead)options.onStatus?.(info);}
  function emitLegend(items,note,phase='') {
    const unique=items.filter((v,i)=>v?.label&&items.findIndex(t=>t?.label===v.label&&t?.color===v.color&&t?.shape===v.shape)===i);
    const value={product:state.product,items:unique,note,phase};const serial=JSON.stringify(value);
    if(serial!==legendSerial){legendSerial=serial;lastLegend=value;options.onLegend?.(value);}
  }
  function region(code='CONUS') {
    const id=String(code).toUpperCase(), choice=MAP_REGIONS[id];
    if(choice){map.fitBounds(choice.bounds,{padding:[10,10],animate:false});return true;}
    const st=ref?.states.find(s=>s.code===id);if(!st)return false;
    const geometry=geometryNear(st.geometry,st.code==='AK'?-154:st.center[1]);
    map.fitBounds(L.geoJSON(geometry).getBounds(),{padding:[15,15],maxZoom:9,animate:false});return true;
  }
  region(options.region||'CONUS');
  L.control.scale({position:'bottomleft',maxWidth:76,imperial:true,metric:false,updateWhenIdle:true}).addTo(map);
  if(map.zoomControl){map.zoomControl.getContainer()?.setAttribute('data-testid','idss-map-zoom');}
  function attach(geometry,sty,info,kind='forecast',dest=scene) {
    if(!geometry||!['Polygon','MultiPolygon','LineString','MultiLineString'].includes(geometry.type))return null;
    const out=L.geoJSON(geometryNear(geometry,map.getCenter().lng),{pane:'idss-'+kind,style:sty,interactive:sty.interactive!==false}).addTo(dest);
    out.eachLayer(l=>{
      const el=l.getElement?.();if(el){el.setAttribute('data-testid',info?.testId||'idss-'+(kind==='mpds'?'mpd':kind));el.setAttribute('data-layer',kind);if(info?.title)el.setAttribute('aria-label',info.title);}
      if(info)decorate(L,l,info,{document:doc,onDetail:options.onDetail});
    });
    return out;
  }
  function addFeature(f,color,title,lines,url,extra={}) {
    const info={kind:extra.kind||'WPC forecast',testId:extra.testId,title,lines:lines.filter(Boolean),url:safeSource(url)};info.detail=info.lines.join(' · ');
    return attach(f.geometry||f,{color:extra.outline||color,fillColor:color,weight:extra.weight||1.8,
      fill:!extra.outlineOnly,fillOpacity:extra.opacity??.31,opacity:.98,dashArray:extra.dash||undefined},info,extra.pane||'forecast');
  }
  function alertArea(g,a,info,coverage,dest=scene,filled) {
    const spec=alertStyle(a);if(!spec.visible)return;
    const color=spec.color,prog=filled??(state.product==='alerts'||state.product==='warnings'||state.winterLayer==='winter_alerts'&&state.product==='winter');
    const national=dest===warningsLayer;
    attach(g,{color:inkFor(color),weight:national?2.2:3.7,fill:false,opacity:national?.7:.85,interactive:false},null,'alerts',dest);
    attach(g,{color,fillColor:color,weight:national?1.3:2.1,fill:prog,fillOpacity:national?.49:.28,dashArray:spec.known?null:'5 3'},
      info||{kind:'NWS alert',title:a.title,lines:[a.area,coverage,'Expires '+utc(a.expires)].filter(Boolean),url:safeSource(a.source_url)},'alerts',dest);
  }
  function wantsWarnings(){
    return state.product==='alerts'||state.product==='warnings'||state.layers.alerts;
  }
  function requestWarningShapes(){
    if(gisPending||Date.now()<gisAfter)return;
    gisPending=true;
    loadAlertGIS(options.fetcher||globalThis.fetch).then(result=>{
      gisShapes=result;gisFailed=false;gisAfter=Date.now()+300000;
    }).catch(()=>{
      gisFailed=true;gisAfter=Date.now()+120000;
    }).finally(()=>{
      gisPending=false;
      if(!dead&&wantsWarnings())render();
    });
  }
  function generalWarnings(board,w,now,items,notes){
    const warnings=currentAlerts(board,now).filter(a=>alertStyle(a).visible);
    const rawWinter=w?.layers?.find(l=>l.id==='winter_alerts');
    const winterZones=fresh(rawWinter,now)&&validUntil(rawWinter.valid_end,now)?rawWinter:null;
    const filled=state.product==='alerts'||state.product==='warnings';
    const signature=warnings.map(a=>a.id+'/'+(a.ugc?.length||0)).join('|');
    const center=map.getCenter().lng;
    if(!warningCache||warningCache.source!==board?.sources?.alerts||warningCache.signature!==signature||
      warningCache.winter!==winterZones||warningCache.gis!==gisShapes||warningCache.filled!==filled||
      Math.abs(warningCache.center-center)>75||now>=warningCache.until){
      warningsLayer.clearLayers();
      const winterIndex=indexWinterShapes(winterZones?.features);
      const shown=new Map(),byId=new Map();
      let missing=0,partial=0,zoneOnly=0,until=Infinity;
      for(const feature of winterZones?.features||[]){
        for(const val of [feature.properties?.valid_start,feature.properties?.valid_end]){
          const t=Date.parse(val);if(t>now&&t<until)until=t;
        }
      }
      for(const alert of warnings.sort((a,b)=>alertStyle(b).priority-alertStyle(a).priority)){
        const layer=alertOutline(alert,winterIndex,gisShapes,now);
        if(!alert.geometry?.length)zoneOnly++;
        if(!layer){missing++;continue;}
        if(layer.partial)partial++;
        byId.set(alert.id,layer);shown.set(alert.title,alertStyle(alert).color);
        for(const geometry of layer.geometry)alertArea(geometry,alert,null,layer.basis,warningsLayer,filled);
      }
      warningCache={source:board?.sources?.alerts,signature,winter:winterZones,gis:gisShapes,filled,center,
        until,byId,missing,partial,zoneOnly,legend:Array.from(shown,([title,color])=>key(title,color,'line'))};
    }
    const {byId,missing,partial,zoneOnly,legend}=warningCache;
    container.dataset.mappedAlerts=String(byId.size);
    items.push(...legend);
    if(warnings.length){
      notes.push(byId.size+' of '+warnings.length+' active alert bulletins mapped.');
      if(partial)notes.push(partial+' with partial zone coverage.');
      if(zoneOnly&&(missing||partial||gisShapes))requestWarningShapes();
      if(missing)notes.push(gisPending?'Loading NWS zone boundaries.':gisFailed?'Some zone boundaries are unavailable.':'Select an unmapped alert to look up its official NWS zones.');
    }else if(filled){
      const status=moduleState(board,'alerts',now);
      notes.push(['ok','current'].includes(status)?'No active NWS bulletins with a map color.':
        status==='partial'?'NWS alert coverage is partial.':'Current NWS alerts are unavailable.');
    }
  }
  function winter(w,now,items,notes) {
    const selected=w?.layers?.find(l=>l.id===state.winterLayer);
    if(!fresh(selected,now)||!validUntil(selected?.valid_end,now)) {
      if(state.winterLayer!=='wssi_d1_3'){notes.push(selected?selected.title+' · current layer unavailable.':'This winter product is unavailable.');return;}
      const active=activeWinter(state.board,now);
      if(!active){notes.push('The winter impact forecast is unavailable.');return;}
      const used=new Set();
      const levels=['Moderate','Major','Extreme'];
      const features=[...(active.features||[])].sort((a,b)=>levels.indexOf(a.properties?.impact)-levels.indexOf(b.properties?.impact));
      for(const f of features){const p=f.properties||{},c=WSSI_COLORS[p.impact];if(!levels.includes(p.impact)||!c)continue;
        used.add(p.impact);addFeature(f,c,p.impact+' winter impacts',[period(active.valid_start,active.valid_end)],p.source_url||active.source_url||refs.winter,{testId:'idss-wssi'});}
      for(const [name,c] of Object.entries(WSSI_COLORS))if(used.has(name))items.push(key(name,c));
      notes.push('WPC Days 1–3 WSSI · Moderate, Major and Extreme · '+period(active.valid_start,active.valid_end));return;
    }
    if(selected.kind==='raster'){
      const url=imageURL(selected.image_url,true);
      if(selected.projection==='EPSG:3857'&&imageBounds(selected.bounds)&&url) {
        const im=L.imageOverlay(url,selected.bounds,{opacity:.77,pane:'idss-raster',interactive:false,className:'idss-winter-raster'}).addTo(scene);
        im.getElement()?.setAttribute('data-testid','idss-winter-raster');im.getElement()?.setAttribute('data-winter-product',selected.id);
        im.on('error',()=>emitStatus({layer:'winter',status:'unavailable',message:'Winter raster could not be loaded.'}));
      }else{notes.push('Winter raster georeferencing is unavailable.');return;}
    }else if(selected.id==='winter_alerts'){
      for(const f of [...asFeatures(selected)].sort((a,b)=>alertStyle(b.properties?.event).priority-alertStyle(a.properties?.event).priority)){
        const p=f.properties||{};if(!validUntil(p.valid_end,now))continue;
        alertArea(f.geometry,p.event||p.label,{kind:'NWS winter alert',testId:'idss-winter-zone',title:p.event||p.label,
          lines:[p.name||p.area,p.ugc&&'NWS zone '+p.ugc,p.office,period(p.valid_start,p.valid_end)].filter(Boolean),url:safeSource(p.source_url)});
      }
    }else{
      const features=[...asFeatures(selected)];
      const ranks=new Map((selected.legend||[]).map((v,i)=>[v.label,i]));
      features.sort((a,b)=>(ranks.get(a.properties?.label)||0)-(ranks.get(b.properties?.label)||0));
      for(const f of features){const p=f.properties||{};addFeature(f,cleanColor(p.color),p.label||selected.title,
        [selected.title,period(p.valid_start||selected.valid_start,p.valid_end||selected.valid_end)],p.source_url||selected.source_url,
        {testId:selected.id.startsWith('wssi_')?'idss-wssi':'idss-pwpf',outlineOnly:selected.style==='outline'||p.style==='outline',weight:selected.style==='outline'?2.15:1.4});}
    }
    for(const l of selected.legend||[])if(l.label)items.push(key(l.label,cleanColor(l.color),selected.style==='outline'?'line':'square'));
    notes.push(selected.title+' · '+(selected.status==='none'?(selected.note||'No contours meet this threshold for this period.'):(period(selected.valid_start,selected.valid_end)||utc(selected.issued))));
  }
  function radar(active,r,now,items,notes) {
    const frames=Array.isArray(r?.frames)?r.frames:[], frame=Number.isInteger(state.radarFrame)?frames[state.radarFrame]:null;
    const url=imageURL(frame?.image_url||r?.image_url,false);
    const ok=active&&fresh(r,now)&&r?.projection==='EPSG:3857'&&imageBounds(r?.bounds)&&url;
    const local=ok?localRadarImage(r,frame,root,doc.location.origin):null;
    const id=ok?JSON.stringify([url,local,r.bounds]):'';
    if(id!==radarKey){
      if(radarImage)map.removeLayer(radarImage);radarImage=null;radarKey=id;
      if(id){
        let tryingLocal=Boolean(local);
        const overlay=L.imageOverlay(local||url,r.bounds,{pane:'idss-raster',opacity:.78,interactive:false,className:'idss-radar-raster'});
        radarImage=overlay;
        overlay.on('error',()=>{
          if(dead||radarKey!==id||radarImage!==overlay)return;
          overlay.setOpacity(0);
          if(tryingLocal){
            tryingLocal=false;overlay.getElement()?.setAttribute('data-radar-source','upstream');
            overlay.setUrl(url);
          }else emitStatus({layer:'radar',status:'unavailable',message:'Radar image could not be loaded.'});
        });
        overlay.on('load',()=>{
          if(!dead&&radarKey===id&&radarImage===overlay){overlay.setOpacity(.78);emitStatus({layer:'radar',status:'current'});}
        });
        overlay.addTo(map);
        const element=overlay.getElement();
        element?.setAttribute('data-testid','idss-radar-raster');element?.setAttribute('data-valid-time',frame?.valid_time||r.valid_time||'');
        element?.setAttribute('data-radar-source',tryingLocal?'pages':'upstream');
      }
    }
    radarInfo=ok?{url,valid_time:frame?.valid_time||r.valid_time}:null;
    if(active){if(!ok){notes.push('Current radar imagery is unavailable.');return;}
      const radarLabel=r.label||r.provider||'Radar reflectivity';
      const table=Array.isArray(r.color_table)?r.color_table:[];
      for(const s of table)if(s.color&&Number.isFinite(s.threshold_dbz))items.push(key(s.threshold_dbz+' dBZ',cleanColor(s.color),'square'));
      for(const swatch of r.legend||[])if(swatch?.label&&swatch?.color)items.push(key(swatch.label,cleanColor(swatch.color),'square'));
      if(!table.length&&!(r.legend||[]).length)items.push(key(radarLabel+' · dBZ','#269551','radar'));notes.push(radarLabel+' · '+utc(radarInfo.valid_time)+'.');}
  }
  function mpd(module,now,items,notes) {
    if(!fresh(module,now)){notes.push('Current MPD coverage is unavailable.');return;}
    const live=asFeatures(module).filter(f=>validUntil(f.properties?.valid_end,now)&&(!f.properties?.valid_start||Date.parse(f.properties.valid_start)<=now));
    for(const f of live){const p=f.properties||{},label='Mesoscale Precipitation Discussion '+(p.number??'');
      attach(f.geometry,{fill:false,color:'#fff',weight:5,interactive:false},null,'mpds');
      addFeature(f,'#661B9E',label,[p.tag,period(p.valid_start,p.valid_end)],p.source_url||module.source_url,{pane:'mpds',kind:'WPC MPD',weight:2.4,dash:'8 4',opacity:.08});}
    if(live.length)items.push(key('Active MPD','#661B9E','dash'));
    if(state.product==='mpd'||state.product==='mpds')notes.push(live.length?live.length+' active WPC mesoscale precipitation discussion'+(live.length===1?'':'s')+'.':'No active WPC mesoscale precipitation discussion.');
  }
  function exposure(board,now,items,notes) {
    const records=exposureRecords(board,now),input=state.exposureRecord;
    const record=typeof input==='object'&&input?input:(records.find(r=>r.id===input)||records[0]);if(!record){notes.push('A current exposure estimate is unavailable.');return;}
    const raw=state.exposureBand,b=typeof raw==='object'&&raw?raw:record.bands?.find(b=>b.label===raw||b.rank===raw);
    const rows=(b||record).states||[], bins=[1,10000,100000,1e6,5e6], colors=['#B6DBE2','#72BAC9','#289AB5','#147189','#16485F'];
    for(const item of rows){const area=ref?.states.find(s=>s.code===item.code);if(!area||item.population<=0||state.exposureState&&state.exposureState!==item.code)continue;
      const i=bins.findLastIndex(v=>item.population>=v),ct=fmt(item.population);
      addFeature({geometry:area.geometry},colors[i],area.name+' · '+ct+' estimated residents',[record.label,b?.label,'2020 Census block-group population centers'],links.census,
        {kind:'Population exposure',weight:.8,opacity:.6});
    }
    const ids=new Set(record.feature_ids||[]), alerts=new Set(record.alert_ids||[]);let outline=[];
    if(record.group==='ero')outline=(activeDay(board,record.day,now)?.features||[]).filter(f=>!b||f.properties.rank===b.rank);
    if(record.group==='winter'){
      const full=record.map_product==='wssi_d1_3';
      const spec=full?(state.winter||board.weather?.winter)?.layers?.find(l=>l.id==='wssi_d1_3'):activeWinter(board,now);
      if(spec&&Date.parse(spec.issued)===Date.parse(record.issued))outline=(spec.features||[]).filter(f=>!b||f.properties.impact===b.label);
    }
    if(record.group==='outlook')outline=(activeOutlook(board,now)?.features||[]).filter(f=>ids.has(f.id)||ids.has(f.properties?.id));
    if(record.group==='alerts')outline=currentAlerts(board,now).filter(a=>alerts.has(a.id)).flatMap(a=>(a.geometry||[]).map(geometry=>({geometry})));
    if(record.group==='mpd'||record.map_product==='mpd'){
      const active=state.mpds||board.weather?.mpd;
      outline=fresh(active,now)?asFeatures(active).filter(f=>'mpd-'+String(f.properties?.number??'').padStart(4,'0')===record.id&&validUntil(f.properties?.valid_end,now)):[];
    }
    if(record.group==='winter_alerts'||record.map_product==='winter_alerts'){
      const winterZones=(state.winter||board.weather?.winter)?.layers?.find(l=>l.id==='winter_alerts');
      outline=fresh(winterZones,now)?asFeatures(winterZones).filter(f=>{
        const p=f.properties||{};return validUntil(p.valid_end,now)&&(alerts.size?alerts.has(p.event_id):p.event===record.label);
      }):[];
    }
    for(const f of outline)attach(f.geometry,{color:'#A23A13',weight:2,fill:false,interactive:false},null,'forecast');
    ['1–9,999','10,000–99,999','100,000–999,999','1–4.99M','5M+'].forEach((l,i)=>items.push(key(l,colors[i])));
    notes.push(record.label+' · Estimated residents in the selected footprint by state.');if(outline.length)items.push(key('Hazard boundary','#A23A13','line'));
  }
  function impactPoints(board,kind,now,items,notes) {
    if(kind==='aviation'){
      const a=board.impacts?.aviation; items.push(key('FAA airport program',POINT_COLORS.plane,'plane'));
      notes.push('FAA airport-status notices'+(a?.as_of?' · '+utc(a.as_of):'')+'.');
      return activeAirEvents(a,now).map(e=>({id:e.id||e.airport,cat:'plane',color:POINT_COLORS.plane,source:'FAA',lat:e.lat,lon:e.lon,
        title:[e.airport,e.airport_name].filter(Boolean).join(' · '),place:e.airport,lines:[e.label,e.delay,e.reason||e.scope,period(e.start_utc,e.end_utc)].filter(Boolean),url:e.source_url||links.aviation}));
    }
    const g=board.impacts?.ground||{},out=[];
    for(const r of currentRivers(g.rivers,now))out.push({id:r.id||r.lid,cat:'gauge',source:'NWPS',color:gaugeColors[r.category],lat:r.latitude,lon:r.longitude,
      title:r.name+', '+r.state,place:r.state,lines:[r.category+' flooding',[r.value,r.unit].filter(v=>v!=null).join(' '),'Observed '+utc(r.observedAt)],url:r.url});
    for(const r of currentGroundReports(g.reports,now))out.push({id:r.id,cat:'impact',source:'LSR',color:POINT_COLORS.impact,lat:r.latitude,lon:r.longitude,
      title:r.location+', '+r.state,place:r.state,lines:[(r.categories||[]).map(c=>impactNames[c]||c).join(', '),'Observed '+utc(r.observedAt)],url:r.url});
    for(const [label,color] of Object.entries(gaugeColors))items.push(key(label+' flooding',color,'gauge'));
    items.push(key('Ground impact report',POINT_COLORS.impact,'impact'));notes.push('NWPS flood-stage observations and preliminary local impact reports.');return out;
  }
  function briefingSelection(){
    const selection=state.briefingFocus,now=nowValue(options.now);
    return (state.product==='radar'||state.product==='briefing')&&selection&&validUntil(selection.valid_end,now)&&validUntil(selection.fresh_until,now)?selection:null;
  }
  function drawBriefing(now,items){
    const selection=briefingSelection(),source=selection?.features||selection?.geometry;
    if(!selection){if(briefingCache)briefingLayer.clearLayers();briefingCache=null;delete container.dataset.briefingFocus;delete container.dataset.briefingFeatures;return;}
    if(!briefingCache||briefingCache.source!==source||briefingCache.label!==selection.label||briefingCache.color!==selection.color||briefingCache.ends!==selection.valid_end
      ||briefingCache.fresh!==selection.fresh_until||briefingCache.url!==selection.source_url||briefingCache.starts!==selection.valid_start||now>=briefingCache.nextChange){
      briefingLayer.clearLayers();
      const features=briefingFeatures(selection,now),legend=new Map(),bounds=L.latLngBounds(),anchors=[],deadlines=[selection.valid_end,selection.fresh_until];
      for(const f of features){
        const g=f.geometry||f,p=f.properties||{},style=briefingStyle(f,selection);
        const isArea=g.type==='Polygon'||g.type==='MultiPolygon';
        deadlines.push(p.valid_end||p.expires);
        const info={kind:'Briefing footprint',testId:'idss-briefing-footprint',title:style.title,
          lines:[p.name||p.region||p.area,p.ugc&&'NWS zone '+p.ugc,p.office,period(p.valid_start||selection.valid_start,p.valid_end||selection.valid_end)].filter(Boolean),
          url:safeSource(p.source_url||selection.source_url)};
        const edgeColor=inkFor(style.color);
        attach(g,{color:edgeColor,weight:2.9,opacity:.68,fill:false,interactive:false},null,'briefing',briefingLayer);
        const layer=attach(g,{color:style.color,weight:1.75,opacity:1,fill:isArea,fillColor:style.color,fillOpacity:.30,lineJoin:'round'},info,'briefing',briefingLayer);
        if(layer){
          const extent=layer.getBounds();bounds.extend(extent);
          // Anchor a label on a real boundary vertex, including for concave coastal zones.
          const normalized=geometryNear(g,map.getCenter().lng),coords=normalized.coordinates;
          const lines=normalized.type==='MultiPolygon'?coords.map(polygon=>polygon[0]):normalized.type==='Polygon'?[coords[0]]:normalized.type==='LineString'?[coords]:coords;
          const middle=extent.getCenter();let best=Infinity,anchor=null;
          for(const line of lines){
            const stride=Math.max(1,Math.ceil(line.length/50));
            for(let i=0;i<line.length;i+=stride){
              const [lon,lat]=line[i],distance=(lat-middle.lat)**2+((lon-middle.lng)*Math.cos(lat*Math.PI/180))**2;
              if(distance<best){best=distance;anchor=[lat,lon];}
            }
          }
          if(anchor)anchors.push({anchor,info,color:style.color});
        }
        legend.set(style.title+style.color,key(style.title,style.color,isArea?'square':'line'));
      }
      briefingCache={source,label:selection.label,color:selection.color,ends:selection.valid_end,fresh:selection.fresh_until,
        bounds,anchors,url:selection.source_url,starts:selection.valid_start,items:[...legend.values()],count:features.length,nextChange:Math.min(Infinity,...deadlines.map(Date.parse).filter(d=>d>now))};
    }
    container.dataset.briefingFocus='true';
    container.dataset.briefingFeatures=String(briefingCache.count);
    items.push(...briefingCache.items);
  }
  function fitBriefing(){
    const b=briefingCache?.bounds;
    if(!b?.isValid())return false;
    map.fitBounds(b,{maxZoom:8.5,padding:[26,24],animate:false});return true;
  }
  function drawHazardLabel(){
    if(!briefingCache?.anchors.length||map.getZoom()>6.2)return [];
    const size=map.getSize(),cells=new Map(),available=[];
    for(const a of briefingCache.anchors){
      const at=L.latLng(...a.anchor),xy=map.latLngToContainerPoint(at);
      if(xy.x<25||xy.y<45||xy.x>size.x-25||xy.y>size.y-35)continue;
      const cell=Math.floor(xy.x/92)+','+Math.floor(xy.y/72);
      cells.set(cell,(cells.get(cell)||0)+1);available.push({...a,at,xy,cell});
    }
    if(!available.length)return [];
    const score=p=>cells.get(p.cell)-.2*(Math.abs(p.xy.x/size.x-.5)+Math.abs(p.xy.y/size.y-.5));
    const a=available.reduce((best,c)=>score(c)>score(best)?c:best);
    const tag=doc.createElement('span');tag.className='idss-hazard-name';
    tag.textContent=briefingCache.label||a.info.title;tag.style.setProperty('--hazard-color',a.color);
    tag.setAttribute('data-testid','idss-briefing-label');
    const width=Math.min(175,Math.max(95,tag.textContent.length*6+20));
    const toRight=a.xy.x<width+24, left=toRight?14:-width-14;
    tag.style.width=width+'px';tag.style.left=left+'px';
    const anchor=doc.createElement('span');
    anchor.className=toRight?'hazard-leader right':'hazard-leader';
    anchor.style.setProperty('--hazard-color',a.color);
    anchor.append(tag);
    const marker=L.marker(a.at,{icon:L.divIcon({html:anchor,className:'idss-hazard-anchor',iconSize:[0,0],iconAnchor:[0,0]}),
      pane:'idss-labels',interactive:false,keyboard:false}).addTo(reportsLayer);
    marker.getElement()?.setAttribute('aria-hidden','true');
    return [[a.xy.x+left-3,a.xy.y-45,a.xy.x+left+width+3,a.xy.y+4]];
  }
  function drawReportLabels(featured,boxes,scope){
    const size=map.getSize(),center=map.getCenter().lng;
    for(const point of featured){
      const at=L.latLng(point.lat,point.lon+360*Math.round((center-point.lon)/360));
      const xy=map.latLngToContainerPoint(at),w=size.x<450?120:147,h=52;
      if(xy.x<5||xy.x>size.x-5||xy.y<5||xy.y>size.y-5)continue;
      const candidates=[[10,-h-5],[10,5],[-w-10,-h-5],[-w-10,5]];
      const offset=candidates.find(([x,y])=>{
        const box=[xy.x+x,xy.y+y,xy.x+x+w,xy.y+y+h];
        if(box[0]<5||box[1]<5||box[2]>size.x-5||box[3]>size.y-18)return false;
        if(boxes.some(b=>box[0]<b[2]+5&&box[2]>b[0]-5&&box[1]<b[3]+5&&box[3]>b[1]-5))return false;
        boxes.push(box);return true;
      });
      if(!offset)continue;
      const tag=doc.createElement('span');tag.className='idss-report-label';
      tag.setAttribute('data-testid','idss-briefing-report');tag.style.setProperty('--report-ink',point.color);
      tag.style.setProperty('--callout-width',w+'px');tag.style.setProperty('--callout-x',offset[0]+'px');tag.style.setProperty('--callout-y',offset[1]+'px');
      const box=doc.createElement('span');box.className='idss-report-label-box';
      const context=doc.createElement('b');context.className='idss-label-scope';context.textContent=(scope==='national'?'Nationwide':'In area')+' · '+point.source;
      const amount=doc.createElement('strong');amount.textContent=point.value+' '+(point.record?.label||POINT_LABELS[point.cat]||'');
      const place=doc.createElement('small');place.textContent=point.place;box.append(context,amount,place);tag.append(box);
      const m=L.marker(at,{icon:L.divIcon({html:tag,className:'idss-labeled-point',iconSize:[0,0],iconAnchor:[0,0],tooltipAnchor:[0,-5]}),
        alt:point.title,keyboard:true,autoPanOnFocus:false,pane:'idss-callouts'}).addTo(reportsLayer);
      decorate(L,m,point,{document:doc,onDetail:options.onDetail,sticky:false});
      m.getElement()?.setAttribute('aria-label',point.title+', '+point.place);
    }
  }
  function drawPoints() {
    clearTimeout(pointTimer);reportsLayer.clearLayers();
    const occupied=drawHazardLabel();
    if(!points.length){pointIndex.clear();return;}
    const isImp=state.product==='ground'||state.product==='aviation',selection=briefingSelection(), reportIds=selection?.reports;
    const source=isImp?'all':state.source,category=isImp?'all':state.observation;
    const featured=(Array.isArray(reportIds)?reportIds:[]).slice(0,3).map(row=>points.find(p=>p.id===(typeof row==='string'?row:row?.id))).filter(p=>
      p?.value&&(source==='all'||p.source===source.toUpperCase())&&(category==='all'||p.cat===category));
    const ids=new Set(featured.map(r=>r.id));
    // Place the representative observation at its exact reported coordinate in each group.
    pointIndex=observationsOnMap(L,map,reportsLayer,[...featured,...(ids.size?points.filter(p=>!ids.has(p.id)):points)],{onDetail:options.onDetail,source,category,doc});
    if(featured.length)drawReportLabels(featured,occupied,selection.reportScope);
  }
  function writePowerLegend(){
    if(!powerLayers||!isPower(state.product))return;
    const countNote=powerStatus?outageMapReading(powerStatus):'Loading outage boundaries and readings.';
    emitLegend([...powerLayers.items,...(powerStatus?.legend||[])],[...powerLayers.notes,countNote].join(' '),'Outages');
  }
  function setPower(active,source) {
    const mode=state.product==='power-county'?'counties':state.product==='power-state'?'states':(state.powerMode||'auto');
    if(powerLayer){
      if(source!==powerSignature){powerSignature=source;powerLayer.setData(source);}
      if(mode!==previousPowerMode){previousPowerMode=mode;powerLayer.setMode(mode);}
      if(active!==previousPowerActive){previousPowerActive=active;powerLayer.setActive(active);}
      return;
    }
    if(!active||powerImport)return;
    const factory=options.powerFactory||globalThis.WPCOutages?.create;
    powerImport=(factory?Promise.resolve(factory):import('./outage-layer.js').then(m=>m.createOutageLayer)).then(create=>{
      if(dead)return;powerLayer=create({map,L,assetBase:root,showLegend:false,now:()=>nowValue(options.now),
        onSelect:p=>options.onDetail?.({...p,title:p.title||p.name||p.label,lines:[p.label,utc(p.as_of)].filter(Boolean),url:'https://poweroutmap.com/'}),
        onStatus:p=>{
          if(!isPower(state.product))return;
          powerStatus=p;
          container.dataset.outageLevel=p.level;
          container.dataset.outageStatus=p.status;
          container.dataset.outageFeatures=String(p.visible_features);
          writePowerLegend();
        }});
      powerSignature=null;setPower(isPower(state.product),state.power||state.board?.impacts?.power);
    }).catch(()=>{powerImport=null;emitStatus({layer:'power',status:'unavailable',message:'Outage geography could not be loaded.'});});
  }
  async function focusOutage(query, opts={popup:true}) {
    const selection=selectionEpoch;
    const isCurrent=()=>!dead&&isPower(state.product)&&selection===selectionEpoch;
    if(!isCurrent())return false;
    if(!powerLayer)await powerImport;
    return isCurrent()&&powerLayer ? powerLayer.focus(query,{...opts,isCurrent}) : false;
  }
  async function drawCounties() {
    const ticket=++countyEpoch;
    if(!state.layers.counties||isPower(state.product)){
      if(countyLayer)map.removeLayer(countyLayer);countyLayer=null;return;
    }
    try{
      const {visibleCountyLines}=await import('./county-reference.js');
      const next=await visibleCountyLines(L,map,root);
      if(dead||ticket!==countyEpoch)return;
      if(countyLayer)map.removeLayer(countyLayer);
      countyRenderer ||= L.canvas({pane:'idss-counties',padding:.2});
      next.options.renderer=countyRenderer;countyLayer=next.addTo(map);
      map.getPane('idss-counties')?.setAttribute('data-testid','idss-county-boundaries');
    }catch{if(!dead&&ticket===countyEpoch)emitStatus({layer:'counties',status:'unavailable',message:'County boundaries could not be loaded.'});}
  }
  function isPower(prod){return ['power','outages','power-county','power-state'].includes(prod);}
  function render() {
    if(dead)return;const now=nowValue(options.now),board=state.board,prod=state.product,l=state.layers,items=[],notes=[];
    const weather=board?.weather||{},w=state.winter||weather.winter,m=state.mpds||weather.mpd,r=state.radar||weather.radar;
    container.dataset.product=prod;container.dataset.winterLayer=state.winterLayer;scene.clearLayers();points=[];
    const er=String(prod).match(/^ero([1-5])$/);
    if(er){
      const day=Number(er[1]),d=activeDay(board,day,now);
      if(d){for(const f of [...(d.features||[])].sort((a,b)=>a.properties.rank-b.properties.rank)){const p=f.properties;
        addFeature(f,ERO_COLORS[p.risk],p.risk+' Risk · Day '+day,[p.threshold!=null?'At least '+p.threshold+'% probability of excessive rainfall':'',period(d.valid_start,d.valid_end)],d.source_url||refs.ero,{testId:'idss-ero',outline:ERO_OUTLINES[p.risk],opacity:.38});}
        notes.push('Day '+day+' excessive rainfall · '+period(d.valid_start,d.valid_end)+(d.no_risk_area?' · No risk area delineated.':'.'));}
      else notes.push('Day '+day+' excessive rainfall is unavailable or outside its current edition.');
      for(const [k,c] of Object.entries(ERO_COLORS))if(day<=3||k!=='High')items.push(key(k,c));
    }
    if(prod==='outlook'){
      const o=activeOutlook(board,now);if(o){for(const f of o.features||[]){const p=f.properties,c=EXTENDED_COLORS[p.hazard]||'#677887';
        addFeature(f,c,p.hazard,[p.region,p.valid_start_date+' – '+p.valid_end_date],p.source_url||refs.outlook);items.push(key(p.hazard,c));}
        notes.push('WPC Days 3–7 hazards · '+o.valid_start_date+' – '+o.valid_end_date+'.');}
      else notes.push('The current WPC Days 3–7 outlook is unavailable.');
    }
    if(prod==='winter'||l.winter)winter(w,now,items,notes);
    if(prod==='exposure'&&board)exposure(board,now,items,notes);
    if(prod==='aviation'||prod==='ground'){if(board)points=impactPoints(board,prod,now,items,notes);}
    if(wantsWarnings())generalWarnings(board,w,now,items,notes);
    else if(warningCache){warningsLayer.clearLayers();warningCache=null;delete container.dataset.mappedAlerts;}
    if((state.mpds||weather.mpd||prod==='mpd'||prod==='mpds')&&(prod==='mpd'||prod==='mpds'||l.mpds))mpd(m,now,items,notes);
    drawBriefing(now,items);
    radar(prod==='radar'||prod==='briefing'||l.radar,r,now,items,notes);
    if((prod==='observations'||prod==='evidence'||prod==='reports'||l.reports)&&!['ground','aviation'].includes(prod)&&!isPower(prod)){
      const ob=state.observations||weather.observations;const hours=Math.max(1,Math.min(Number(state.reportHours)||48,Number(ob?.periodHours)||24));let rows=[];
      if(ob){const cutoff=now-hours*3600000;rows=fresh(ob,now)?asFeatures(ob).filter(v=>{const t=Date.parse(v.observedAt||v.valid);return Number.isFinite(t)&&t>=cutoff&&t<=now;}):[];}
      else rows=currentReports(board,hours,now);
      points=rows.map(reportPoint).filter(Boolean);
      const cats=new Set(points.filter(v=>state.observation==='all'||v.cat===state.observation).map(v=>v.cat));
      for(const cat of cats)items.push(key(POINT_LABELS[cat],POINT_COLORS[cat],cat));
      if(prod==='observations'||prod==='evidence'||prod==='reports')notes.push(points.length+' located, preliminary observations in the preceding '+hours+' hours.'+(ob?.unlocated?.length?' '+ob.unlocated.length+' reports have no qualified coordinates.':''));
    }
    points=points.filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon));drawPoints();
    if(isPower(prod)){
      powerLayers={items,notes};
      writePowerLegend();
    }else{
      powerLayers=null;powerStatus=null;
      delete container.dataset.outageLevel;delete container.dataset.outageFeatures;delete container.dataset.outageStatus;
      emitLegend(items,notes.join(' '));
    }
    drawCounties();setPower(isPower(prod),state.power||board?.impacts?.power);
  }
  function update(fields={}) {
    if(dead)return;const productChanged=fields.product!==undefined&&fields.product!==state.product;const {layers,...rest}=fields;Object.assign(state,rest);
    if(layers)Object.assign(state.layers,layers);
    if(state.product!=='radar'&&state.product!=='briefing')state.briefingFocus=null;
    if(productChanged){selectionEpoch++;selectedLayer.clearLayers();map.closePopup();}
    render();
  }
  async function focus(input) {
    if(!input||dead)return false;
    if(isPower(state.product)&&(typeof input==='string'||input.fips)&&powerLayer)return powerLayer.focus(typeof input==='string'?input:input.fips,{popup:true});
    if(typeof input==='string')input={id:input};
    const poi=pointIndex.get(input.id)||points.find(p=>p.id===input.id);
    const alert=state.board&&input.id&&!poi?currentAlerts(state.board,nowValue(options.now)).find(a=>a.id===input.id):null;
    const record=poi||(alert?{...alert,...input}:input),lat=record.latitude??record.lat,lon=record.longitude??record.lon;
    const geo=record.geometry;
    const hasGeometry=Array.isArray(geo)?geo.length>0:Boolean(geo?.type);
    const filled=alert&&!hasGeometry?warningCache?.byId.get(alert.id):null;
    const g=filled?.geometry||(Array.isArray(geo)?geo:geo?.type==='Feature'?[geo.geometry]:geo?[geo]:[]);
    const tag=++selectionEpoch;selectedLayer.clearLayers();
    const info={title:record.title||record.label||record.name||'Selected location',detail:record.detail||record.area||'',
      lines:record.lines||[record.area||record.detail,filled?.basis,record.observedAt&&utc(record.observedAt)].filter(Boolean),url:safeSource(record.url||record.source_url),kind:record.source||'Map selection'};
    if(g.length){
      let bounds;
      for(const shape of g){const picked=attach(shape,{color:container.dataset.basemap==='dark'?'#FFF4D9':'#082235',weight:3.8,dashArray:'7 3',fill:false},info,'selected',selectedLayer);
        if(picked){if(!bounds)bounds=picked.getBounds();else bounds.extend(picked.getBounds());}}
      if(bounds?.isValid()){map.fitBounds(bounds,{maxZoom:9,padding:[28,28],animate:false});L.popup({className:'idss-geo-popup'}).setLatLng(bounds.getCenter()).setContent(detailNode(doc,info,true)).openOn(map);return true;}
    }
    if(Number.isFinite(lat)&&Number.isFinite(lon)){map.setView([lat,lon],Math.max(map.getZoom(),7.25),{animate:false});
      L.popup({className:'idss-geo-popup',maxWidth:340}).setLatLng([lat,lon]).setContent(detailNode(doc,info,true)).openOn(map);return true;}
    if(record.zone_urls?.length) {
      emitStatus({layer:'alerts',status:'loading',message:'Loading the official NWS forecast zones…'});
      const result=await resolveAlertZones(record,new Date(nowValue(options.now)),fetch,zoneCache);
      if(dead||tag!==selectionEpoch)return false;
      if(result.geometry?.length)return focus({...record,zone_urls:[],geometry:result.geometry,lines:[record.area,result.role,result.status==='partial'?'Only some affected zones are available.':''].filter(Boolean)});
      emitStatus({layer:'alerts',status:'unavailable',message:'The alert text is available. Its official zone geometry could not be loaded.'});
    }
    return false;
  }
  function syncView() {
    const center=map.getCenter();container.dataset.zoom=String(map.getZoom());container.dataset.centerLat=String(center.lat);container.dataset.centerLng=String(center.lng);
  }
  syncView();
  function viewChanged() {
    if(dead)return;syncView();drawCounties();clearTimeout(pointTimer);
    if(warningCache&&Math.abs(map.getCenter().lng-warningCache.center)>75)render();
    if(autopanning)autopanning=false;else pointTimer=setTimeout(()=>{if(!dead)drawPoints();},45);
    options.onViewChange?.({center:map.getCenter(),zoom:map.getZoom(),bounds:map.getBounds()});
  }
  map.on('autopanstart',()=>{autopanning=true;clearTimeout(pointTimer);});
  map.on('popupopen',()=>clearTimeout(pointTimer));
  map.on('moveend zoomend',viewChanged);
  const resize=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>{if(!dead)map.invalidateSize({pan:false,debounceMoveend:true});}):null;resize?.observe(container);
  return {map,update,region,focus,fitBriefing,setBasemap:base.setStyle,focusOutage,zoomBy:n=>map.setZoom(map.getZoom()+Number(n||0)),invalidateSize:()=>map.invalidateSize({pan:false}),
    get legend(){return lastLegend;},get radar(){return radarInfo;},get impactOverlay(){return powerLayer;},
    destroy(){dead=true;selectionEpoch++;clearTimeout(pointTimer);resize?.disconnect();map.off('moveend zoomend',viewChanged);powerLayer?.destroy();base.destroy();map.remove();}
  };
}
