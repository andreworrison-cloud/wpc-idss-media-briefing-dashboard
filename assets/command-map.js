import {ASSET_ROOT,MAP_REGIONS,geometryNear,mountBase} from './geographic-base.js';
import {utc,detailNode,decorate,observationsOnMap,reportPoint,POINT_COLORS,POINT_LABELS} from './map-points.js';
import {activeDay,activeWinter,activeOutlook,currentAlerts,currentReports,refs} from './logic.js';
import {activeAirEvents,currentRivers,currentGroundReports,exposureRecords,gaugeColors,impactNames,links} from './impact-logic.js';
import {ERO_COLORS,ERO_OUTLINES,WSSI_COLORS,EXTENDED_COLORS,alertStyle,inkFor} from './hazard-palette.js';
import {resolveAlertZones} from './alert-zones.js';
export {MAP_REGIONS};

const GOOD=new Set(['ok','current','partial','active','published','none']);
const fmt=n=>Number.isFinite(n)?n.toLocaleString('en-US'):'';
const cleanColor=s=>/^#[0-9a-f]{6}$/i.test(s||'')?s:'#617C8C';
const emptyGeo=()=>({title:'',lines:[]});
const truthy=v=>Array.isArray(v)?v.filter(Boolean):[];
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
function makePanes(map) {
  // Leaflet tilePane is 200, tooltipPane is 650 and popupPane is 700.
  for(const [name,z] of Object.entries({land:155,backdrop:170,outages:340,raster:348,forecast:370,counties:399,borders:410,alerts:430,mpds:445,labels:450,points:510,selected:535})) {
    const pane=map.createPane('idss-'+name);pane.style.zIndex=z;
    if(['backdrop','land','labels','borders','raster','counties'].includes(name))pane.style.pointerEvents='none';
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
  const state={board:null,product:'ero1',reportHours:48,observation:'all',source:'all',winterLayer:'wssi_d1_3',radarFrame:null,
    layers:{alerts:false,reports:true,radar:false,winter:false,mpds:true,counties:false}};
  let dead=false,ref=null,points=[],pointIndex=new Map(),pointTimer,epoch=0,selectionEpoch=0,legendSerial='',lastLegend=null;
  let countyLayer=null,countyEpoch=0,countyRenderer=null;
  let powerLayer=null,powerImport=null,powerSignature=null,powerLegend=[],previousPowerMode=null,previousPowerActive=null;
  const zoneCache=new Map();
  let radarKey='',radarImage=null,radarInfo=null;
  const base=mountBase(L,map,{root,tiles:options.tiles??true,onStatus:emitStatus,onReference:g=>{ref=g;if(state.product==='exposure')render();}});
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
  function alertArea(g,a,info,coverage) {
    const spec=alertStyle(a);if(!spec.visible)return;
    const color=spec.color,prog=state.product==='alerts'||state.product==='warnings'||state.winterLayer==='winter_alerts'&&state.product==='winter';
    attach(g,{color:inkFor(color),weight:3.7,fill:false,opacity:.85,interactive:false},null,'alerts');
    attach(g,{color,fillColor:color,weight:2.1,fill:prog,fillOpacity:.28,dashArray:spec.known?null:'5 3'},
      info||{kind:'NWS alert',title:a.title,lines:[a.area,coverage,'Expires '+utc(a.expires)].filter(Boolean),url:safeSource(a.source_url)},'alerts');
  }
  function winter(w,now,items,notes) {
    const selected=w?.layers?.find(l=>l.id===state.winterLayer);
    if(!selected) {
      if(state.winterLayer!=='wssi_d1_3'){notes.push('This winter product is unavailable.');return;}
      const active=activeWinter(state.board,now);
      if(!active){notes.push('The winter impact forecast is unavailable.');return;}
      const used=new Set();
      for(const f of active.features||[]){const p=f.properties||{},c=WSSI_COLORS[p.impact];if(!c)continue;
        used.add(p.impact);addFeature(f,c,p.impact+' winter impacts',[period(active.valid_start,active.valid_end)],p.source_url||refs.winter);}
      for(const [name,c] of Object.entries(WSSI_COLORS))if(used.has(name))items.push(key(name,c));
      notes.push('WSSI · '+period(active.valid_start,active.valid_end));return;
    }
    if(!fresh(selected,now)||!validUntil(selected.valid_end,now)){notes.push(selected.title+' · current layer unavailable.');return;}
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
    const id=ok?url+JSON.stringify(r.bounds):'';
    if(id!==radarKey){
      if(radarImage)map.removeLayer(radarImage);radarImage=null;radarKey=id;
      if(id){radarImage=L.imageOverlay(url,r.bounds,{pane:'idss-raster',opacity:.78,interactive:false,className:'idss-radar-raster'}).addTo(map);
        radarImage.getElement()?.setAttribute('data-testid','idss-radar-raster');radarImage.getElement()?.setAttribute('data-valid-time',frame?.valid_time||r.valid_time||'');
        radarImage.on('error',()=>{if(radarKey===id)emitStatus({layer:'radar',status:'unavailable',message:'Radar image could not be loaded.'});});
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
  function drawPoints() {
    clearTimeout(pointTimer);reportsLayer.clearLayers();
    if(!points.length){pointIndex.clear();return;}
    const isImp=state.product==='ground'||state.product==='aviation';
    pointIndex=observationsOnMap(L,map,reportsLayer,points,{onDetail:options.onDetail,source:isImp?'all':state.source,category:isImp?'all':state.observation,doc});
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
      if(dead)return;powerLayer=create({map,L,assetBase:root,showLegend:false,
        onSelect:p=>options.onDetail?.({...p,title:p.name||p.label,detail:p.label,url:'https://poweroutmap.com/'}),
        onStatus:p=>{powerLegend=p.legend||[];emitStatus({layer:'power',...p});if(isPower(state.product))emitLegend(powerLegend,'Reported electric customer accounts without power · '+(utc(p.as_of)||'time unverified'),'Outages');}});
      powerSignature=null;setPower(isPower(state.product),state.power||state.board?.impacts?.power);
    }).catch(()=>{powerImport=null;emitStatus({layer:'power',status:'unavailable',message:'Outage geography could not be loaded.'});});
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
    if(prod==='alerts'||prod==='warnings'||l.alerts){
      const warnings=currentAlerts(board,now),shown=new Map();let zones=0;
      for(const a of [...warnings].sort((a,b)=>alertStyle(b).priority-alertStyle(a).priority)){
        const spec=alertStyle(a);if(!spec.visible)continue;
        if(!a.geometry?.length){zones++;continue;}
        shown.set(a.title,spec.color);for(const g of a.geometry)alertArea(g,a,null,a.geometry_status);
      }
      for(const [k,c] of shown)items.push(key(k,c,'line'));
      if(zones)notes.push(zones+' zone-based messages have no published polygon in this layer. Select an alert for its NWS zones.');
    }
    if((state.mpds||weather.mpd||prod==='mpd'||prod==='mpds')&&(prod==='mpd'||prod==='mpds'||l.mpds))mpd(m,now,items,notes);
    radar(prod==='radar'||l.radar,r,now,items,notes);
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
    if(isPower(prod)){items.push(...powerLegend);notes.push('Reported electric customer accounts without power.');}
    drawCounties();emitLegend(items,notes.join(' '));setPower(isPower(prod),state.power||board?.impacts?.power);
  }
  function update(fields={}) {
    if(dead)return;const productChanged=fields.product!==undefined&&fields.product!==state.product;const {layers,...rest}=fields;Object.assign(state,rest);
    if(layers)Object.assign(state.layers,layers);
    if(productChanged){selectionEpoch++;selectedLayer.clearLayers();map.closePopup();}
    render();
  }
  async function focus(input) {
    if(!input||dead)return false;
    if(isPower(state.product)&&(typeof input==='string'||input.fips)&&powerLayer)return powerLayer.focus(typeof input==='string'?input:input.fips,{popup:true});
    if(typeof input==='string')input={id:input};
    const poi=pointIndex.get(input.id)||points.find(p=>p.id===input.id);
    const record=poi||input,lat=record.latitude??record.lat,lon=record.longitude??record.lon;
    const geo=record.geometry, g=Array.isArray(geo)?geo:geo?.type==='Feature'?[geo.geometry]:geo?[geo]:[];
    const tag=++selectionEpoch;selectedLayer.clearLayers();
    const info={title:record.title||record.label||record.name||'Selected location',detail:record.detail||record.area||'',
      lines:record.lines||[record.area||record.detail,record.observedAt&&utc(record.observedAt)].filter(Boolean),url:safeSource(record.url||record.source_url),kind:record.source||'Map selection'};
    if(g.length){
      let bounds;
      for(const shape of g){const picked=attach(shape,{color:'#082235',weight:3.8,dashArray:'7 3',fill:false},info,'selected',selectedLayer);
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
    if(dead)return;syncView();drawCounties();clearTimeout(pointTimer);pointTimer=setTimeout(()=>{if(!dead)drawPoints();},45);
    options.onViewChange?.({center:map.getCenter(),zoom:map.getZoom(),bounds:map.getBounds()});
  }
  map.on('moveend zoomend',viewChanged);
  const resize=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>{if(!dead)map.invalidateSize({pan:false,debounceMoveend:true});}):null;resize?.observe(container);
  return {map,update,region,focus,focusOutage:(query,opts={popup:true})=>powerLayer?.focus(query,opts)??false,zoomBy:n=>map.setZoom(map.getZoom()+Number(n||0)),invalidateSize:()=>map.invalidateSize({pan:false}),
    get legend(){return lastLegend;},get radar(){return radarInfo;},get impactOverlay(){return powerLayer;},
    destroy(){dead=true;selectionEpoch++;clearTimeout(pointTimer);resize?.disconnect();map.off('moveend zoomend',viewChanged);powerLayer?.destroy();base.destroy();map.remove();}
  };
}
