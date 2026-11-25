const tileSource = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';
const attribution = '<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noopener">USGS The National Map</a>';
export const MAP_REGIONS = Object.freeze({
  CONUS: {label:'Contiguous U.S.',bounds:[[24.2,-125.3],[49.8,-66.3]]},
  WEST: {label:'West',bounds:[[31,-125.3],[49.4,-101.3]]},
  CENTRAL: {label:'Central U.S.',bounds:[[25,-106.8],[49.6,-83.0]]},
  EAST: {label:'East',bounds:[[24.6,-91.6],[47.7,-65.7]]},
  NORTHEAST: {label:'Northeast',bounds:[[36.6,-82.6],[47.6,-66.2]]},
  SOUTHEAST: {label:'Southeast',bounds:[[24.4,-95.1],[38.3,-74.7]]},
  MIDWEST: {label:'Midwest',bounds:[[35.5,-104.1],[49.5,-80.1]]},
  SOUTHWEST: {label:'Southwest',bounds:[[29,-124.5],[42.5,-102.0]]},
  NORTHWEST: {label:'Northwest',bounds:[[40.8,-125.2],[49.4,-109.1]]},
  AK: {label:'Alaska',bounds:[[50.5,-188.6],[71.8,-129.1]]},
  HI: {label:'Hawaiʻi',bounds:[[18.7,-160.6],[22.4,-154.6]]},
  PR: {label:'Puerto Rico & U.S. Virgin Islands',bounds:[[17.58,-67.5],[18.65,-64.45]]},
  GU: {label:'Guam & Northern Mariana Islands',bounds:[[13.0,144.45],[20.7,146.45]]},
  AS: {label:'American Samoa',bounds:[[-14.65,-171.2],[-10.75,-168.0]]}
});
export const ASSET_ROOT = new URL('./', import.meta.url).href;
const cache = new Map();
function decode(text) {
  let at=0, lat=0, lon=0, points=[];
  function delta() {
    let value=0, shift=0, c;
    do {c=text.charCodeAt(at++)-63; value|=(c&31)<<shift; shift+=5;} while(c>=32);
    return value&1 ? ~ (value>>1) : value>>1;
  }
  while(at<text.length){lon+=delta();lat+=delta();points.push([lon/1000,lat/1000]);}
  return points;
}
const polygons = polygons => ({type:'MultiPolygon',coordinates:polygons.map(p=>p.map(decode))});
const wrap = (lon,target) => lon+360*Math.round((target-lon)/360);
function ringNear(points, center) {
  let previous=center;
  return points.map(p=>{const lon=wrap(p[0],previous);previous=lon;return [lon,p[1]];});
}
/** Keep each ring and its holes continuous in the selected copy of Web Mercator. */
export function geometryNear(geometry, center) {
  if(!geometry)return null;
  const c=geometry.coordinates;
  if(geometry.type==='Polygon') {
    const outer=ringNear(c[0],center), anchor=outer[0]?.[0]??center;
    return {type:'Polygon',coordinates:[outer,...c.slice(1).map(r=>ringNear(r,anchor))]};
  }
  if(geometry.type==='MultiPolygon')return {type:'MultiPolygon',coordinates:c.map(p=>geometryNear({type:'Polygon',coordinates:p},center).coordinates)};
  if(geometry.type==='LineString')return {type:'LineString',coordinates:ringNear(c,center)};
  if(geometry.type==='MultiLineString')return {type:'MultiLineString',coordinates:c.map(p=>ringNear(p,center))};
  return geometry;
}
export function loadReference(root=ASSET_ROOT) {
  const href=new URL('geo-reference.json',root).href;
  if(!cache.has(href))cache.set(href,fetch(href).then(r=>{if(!r.ok)throw Error('Local geographic reference unavailable');return r.json();}).then(g=>({
    states:g.states.map(([code,name,center,shape])=>({code,name,center,geometry:polygons(shape)})),
    land:g.land.map(([,shape])=>polygons(shape)),lakes:polygons(g.lakes),
    rivers:{type:'MultiLineString',coordinates:g.rivers.map(decode)},cities:g.cities
  })).catch(e=>{cache.delete(href);throw e;}));
  return cache.get(href);
}
const basePalettes = {
  dark: {foreign:'#243a49', land:'#2d4352', water:'#0c1e2e', coast:'#617783', state:'#c4d6da', river:'#527285'},
  topo: {foreign:'#e4e6da', land:'#ebece2', water:'#a8ccdd', coast:'#9daa9b', state:'#516775', river:'#91bacd'}
};
const nearLongitude=(lon,center)=>lon+360*Math.round((center-lon)/360);
const smallStates=new Set(['DC','MD','DE','RI','NJ','VT','NH','MA','CT','VI','MP','AS','GU']);
const majorStates=new Set(['CA','WA','MT','CO','TX','MN','IL','GA','NY','AK','HI','PR']);
const reliefBounds=[[10,-175],[75,-45]];
export function mountBase(L,map,{root=ASSET_ROOT,onStatus,tiles=true,onReference,style:initialStyle}={}) {
  const container=map.getContainer(),doc=container.ownerDocument;
  const vector=L.layerGroup().addTo(map), borders=L.layerGroup().addTo(map), labels=L.layerGroup().addTo(map);
  const water=L.layerGroup().addTo(map);
  let destroyed=false,reference=null,loaded=0,errors=0,timer,basemap,style;
  let saved;
  try{saved=doc.defaultView?.localStorage.getItem('wpc-idss:basemap');}catch{}
  const baseFill={stroke:false,fillOpacity:1,interactive:false,pane:'idss-land'};
  function vectorStyle(geometry,sty,group,lon=-98) {
    return L.geoJSON(geometryNear(geometry,lon),{style:sty,interactive:false,pane:sty.pane}).addTo(group);
  }
  const national=L.imageOverlay(new URL('conus-reference.webp',root).href,[[11.178401873711781,-135],[55.77657301866769,-56.25]],{
    pane:'idss-backdrop',alt:'USGS geographic reference',interactive:false,className:'idss-reference-backdrop'
  });
  const relief=L.imageOverlay(new URL('briefing-relief.webp',root).href,reliefBounds,{
    pane:'idss-backdrop',alt:'Natural Earth shaded relief',interactive:false,className:'idss-relief-backdrop'
  });
  const terrainCredit='<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth relief</a>';
  map.attributionControl.addAttribution('<a href="https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html" target="_blank" rel="noopener">Census</a>');
  map.attributionControl.addAttribution(terrainCredit);
  map.attributionControl.setPrefix(false);
  if(tiles) {
    basemap=L.tileLayer(typeof tiles==='string'?tiles:tileSource,{maxZoom:16,maxNativeZoom:16,minZoom:2,keepBuffer:1,
      pane:'tilePane',className:'idss-usgs-tiles',updateWhenIdle:true,updateWhenZooming:false});
    basemap.on('loading',()=>{loaded=0;errors=0;}).on('tileload',()=>{loaded++;tileStatus();}).on('tileerror',()=>{errors++;tileStatus();});
  }
  function tileStatus() {
    clearTimeout(timer);
    timer=setTimeout(()=>{
      if(destroyed||!basemap||!map.hasLayer(basemap))return;
      drawLabels();
      if(errors>0)onStatus?.({layer:'basemap',status:'partial',message:loaded?'Local geography fills gaps in the USGS tile coverage.':'Local geographic reference in use. Detailed USGS tiles are unavailable.'});
      else if(loaded>0)onStatus?.({layer:'basemap',status:'current',message:'USGS topographic reference'});
    },220);
  }
  function syncTiles() {
    const useTiles=Boolean(basemap)&&(style==='topo'||map.getZoom()>=6.8);
    if(basemap&&useTiles!==map.hasLayer(basemap)){
      if(useTiles){basemap.addTo(map);}else{map.removeLayer(basemap);loaded=0;errors=0;clearTimeout(timer);}
    }
    const credit=style==='topo'||useTiles;
    if(credit!==Boolean(container.dataset.usgsCredit)){
      if(credit){map.attributionControl.addAttribution(attribution);container.dataset.usgsCredit='yes';}
      else{map.attributionControl.removeAttribution(attribution);delete container.dataset.usgsCredit;}
    }
  }
  function drawGeography(){
    if(!reference)return;
    vector.clearLayers();borders.clearLayers();water.clearLayers();
    const p=basePalettes[style],dark=style==='dark';
    for(const land of reference.land)vectorStyle(land,{...baseFill,fillColor:p.foreign,color:p.coast,stroke:true,weight:.55},vector);
    for(const state of reference.states){
      const near=state.code==='AK'?-154:state.center[1];
      vectorStyle(state.geometry,{...baseFill,fillColor:p.land},vector,near);
      const edge=vectorStyle(state.geometry,{pane:'idss-borders',color:p.state,weight:dark?.85:.8,opacity:dark?.74:.78,fill:false,interactive:false},borders,near);
      edge.eachLayer(layer=>layer.getElement()?.setAttribute('data-testid','idss-states'));
    }
    const waterPane=dark?'idss-hydrography':'idss-land';
    vectorStyle(reference.lakes,{...baseFill,pane:waterPane,fillColor:p.water},water);
    vectorStyle(reference.rivers,{pane:waterPane,stroke:true,fill:false,color:p.river,weight:dark?.75:.85,opacity:dark?.72:1,interactive:false},water);
  }
  function drawLabels(){
    if(!reference||destroyed)return;
    labels.clearLayers();
    const zoom=map.getZoom(),size=map.getSize(),center=map.getCenter().lng,online=basemap&&map.hasLayer(basemap)&&loaded>0&&errors<loaded;
    map.getPane('idss-borders').style.opacity=zoom>=8&&online&&style==='topo'?'.25':'1';
    const taken=[];
    function place(text,lat,lon,kind){
      const position=L.latLng(lat,nearLongitude(lon,center)),xy=map.latLngToContainerPoint(position);
      const isState=kind==='state',w=isState?21:Math.min(108,text.length*5.6+12),h=isState?13:16;
      const left=isState?xy.x-w/2:xy.x-2,top=xy.y-h/2;
      const box=[left,top,left+w,top+h];
      if(box[0]<4||box[1]<6||box[2]>size.x-4||box[3]>size.y-6)return;
      if(taken.some(a=>box[0]<a[2]+4&&box[2]>a[0]-4&&box[1]<a[3]+3&&box[3]>a[1]-3))return;
      taken.push(box);
      const span=doc.createElement('span');span.textContent=text;
      L.marker(position,{icon:L.divIcon({className:'idss-'+kind+'-label',html:span,iconSize:[0,0]}),interactive:false,keyboard:false,pane:'idss-labels'}).addTo(labels);
    }
    if(zoom<7.8)for(const state of reference.states){
      if(zoom<3.65&&!majorStates.has(state.code)||zoom<5.5&&smallStates.has(state.code))continue;
      place(state.code,...state.center,'state');
    }
    if(online&&style==='topo'||zoom<3.7)return;
    const rank=zoom<4.3?0:zoom<5.2?1:zoom<6?2:zoom<6.8?4:6;
    for(const [name,lat,lon,r] of reference.cities)if(r<=rank)place(name,lat,lon,'city');
  }
  function changeStyle(value,remember=false){
    if(!Object.hasOwn(basePalettes,value)||value===style)return;
    style=value;container.dataset.basemap=style;
    if(remember)try{doc.defaultView?.localStorage.setItem('wpc-idss:basemap',style);}catch{}
    const was=style==='dark'?national:relief, active=style==='dark'?relief:national;
    if(map.hasLayer(was))map.removeLayer(was);
    active.addTo(map);
    syncTiles();drawGeography();drawLabels();select.value=style;
    onStatus?.({layer:'basemap',status:'current',message:style==='dark'?'Natural Earth shaded relief':'USGS topographic reference'});
    map.fire('idssbasemapchange',{style});
  }
  const selector=L.control({position:'bottomleft'}), select=doc.createElement('select');
  selector.onAdd=()=>{
    const box=doc.createElement('div');box.className='idss-base-switch';
    select.setAttribute('aria-label','Map background');select.setAttribute('data-testid','idss-basemap');
    for(const [id,label] of [['dark','Dark relief'],['topo','USGS topo']]){
      const option=doc.createElement('option');option.value=id;option.textContent=label;select.append(option);
    }
    box.append(select);L.DomEvent.disableClickPropagation(box);L.DomEvent.disableScrollPropagation(box);
    select.onchange=()=>changeStyle(select.value,true);return box;
  };
  selector.addTo(map);
  changeStyle(Object.hasOwn(basePalettes,initialStyle)?initialStyle:saved==='topo'?'topo':'dark');
  const onZoom=()=>{syncTiles();drawLabels();};
  map.on('zoomend',onZoom);map.on('moveend',drawLabels);
  loadReference(root).then(g=>{
    if(destroyed)return;
    reference=g;drawGeography();drawLabels();onReference?.(g);
  }).catch(()=>onStatus?.({layer:'geography',status:'partial',message:'Local state boundaries could not be loaded.'}));
  return {get reference(){return reference;},setStyle:value=>changeStyle(value,true),destroy(){destroyed=true;clearTimeout(timer);map.off('zoomend',onZoom);map.off('moveend',drawLabels);selector.remove();}};
}
