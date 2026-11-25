const NS = 'http://www.w3.org/2000/svg';
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
export function mountBase(L,map,{root=ASSET_ROOT,onStatus,tiles=true,onReference}={}) {
  const doc=map.getContainer().ownerDocument;
  const vector=L.layerGroup().addTo(map), borders=L.layerGroup().addTo(map), labels=L.layerGroup().addTo(map);
  let destroyed=false, reference=null, previousLabelBand='', loaded=0, errors=0, timer, basemap;
  const baseFill={stroke:false,fillOpacity:1,interactive:false,pane:'idss-land'};
  const vectorStyle=(geometry,style,group,lon=-98)=>L.geoJSON(geometryNear(geometry,lon),{style,interactive:false,pane:style.pane}).addTo(group);
  const homeBackdrop=L.imageOverlay(new URL('conus-reference.webp',root).href,[[11.178401873711781,-135],[55.77657301866769,-56.25]],{
    pane:'idss-backdrop',alt:'USGS geographic reference',interactive:false,className:'idss-reference-backdrop'
  }).addTo(map);
  map.attributionControl.addAttribution(attribution);
  map.attributionControl.addAttribution('<a href="https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html" target="_blank" rel="noopener">Census</a> · <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>');
  map.attributionControl.setPrefix(false);
  const label=(text,at,cls)=>{
    const span=doc.createElement('span');span.textContent=text;
    L.marker(at,{icon:L.divIcon({className:cls,html:span,iconSize:[0,0]}),interactive:false,keyboard:false,pane:'idss-labels'}).addTo(labels);
  };
  function drawLabels() {
    if(!reference)return;
    const z=map.getZoom(), band=z<3.35?'far':z<5.7?'state':z<8?'city':'close';
    const online=loaded>0&&errors<loaded;
    // Remote tiles include place names. National state abbreviations stay visible above radar.
    const key=band+online;if(key===previousLabelBand)return;previousLabelBand=key;labels.clearLayers();
    if(band==='state'||(band==='city'&&!online)){
      const small=new Set(['DC','MD','DE','RI','NJ','VT','NH','MA','CT','VI','MP','AS','GU']);
      for(const s of reference.states)if(!small.has(s.code)||band==='city')label(s.code,s.center,'idss-state-label');
    }
    if(!online&&(band==='city'||band==='close'))for(const [name,lat,lon] of reference.cities)label(name,[lat,lon],'idss-city-label');
  }
  function tileStatus() {
    clearTimeout(timer);
    timer=setTimeout(()=>{
      if(destroyed)return;drawLabels();
      if(errors>0&&loaded===0)onStatus?.({layer:'basemap',status:'partial',message:'Local geographic reference in use. Detailed USGS tiles are unavailable.'});
      else if(loaded>0)onStatus?.({layer:'basemap',status:'current',message:'USGS topographic reference'});
    },220);
  }
  if(tiles) {
    basemap=L.tileLayer(typeof tiles==='string'?tiles:tileSource,{maxZoom:16,maxNativeZoom:16,minZoom:2,keepBuffer:1,
      pane:'tilePane',className:'idss-usgs-tiles',updateWhenIdle:true,updateWhenZooming:false});
    basemap.on('tileload',()=>{loaded++;tileStatus();}).on('tileerror',()=>{errors++;tileStatus();}).addTo(map);
  }
  loadReference(root).then(g=>{
    if(destroyed)return;reference=g;
    for(const land of g.land)vectorStyle(land,{...baseFill,fillColor:'#E4E6DA',color:'#9DAA9B',stroke:true,weight:.45},vector);
    for(const state of g.states) {
      const near=state.code==='AK'?-154:state.center[1];
      vectorStyle(state.geometry,{...baseFill,fillColor:'#EBECE2'},vector,near);
      const edge=vectorStyle(state.geometry,{pane:'idss-borders',color:'#516775',weight:.8,opacity:.78,fill:false,interactive:false},borders,near);
      edge.eachLayer(l=>{l.getElement()?.setAttribute('data-testid','idss-states');});
    }
    vectorStyle(g.lakes,{...baseFill,fillColor:'#A8CCDD'},vector);
    vectorStyle(g.rivers,{pane:'idss-land',stroke:true,fill:false,color:'#91BACD',weight:.85,interactive:false},vector);
    drawLabels();onReference?.(g);
  }).catch(()=>onStatus?.({layer:'geography',status:'partial',message:'Local state boundaries could not be loaded.'}));
  map.on('zoomend',drawLabels);
  return {get reference(){return reference;},destroy(){destroyed=true;clearTimeout(timer);map.off('zoomend',drawLabels);}};
}
