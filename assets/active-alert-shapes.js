// This cartographic feed supplements CAP messages that carry zone identifiers without a polygon.
const service='https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query';
function validPolygon(g){
  const polys=g?.type==='Polygon'?[g.coordinates]:g?.type==='MultiPolygon'?g.coordinates:null;
  return Array.isArray(polys)&&polys.length>0&&polys.every(poly=>Array.isArray(poly)&&poly.length>0&&poly.every(ring=>
    Array.isArray(ring)&&ring.length>=4&&ring.every(p=>Array.isArray(p)&&Number.isFinite(p[0])&&Number.isFinite(p[1])&&Math.abs(p[0])<=180&&Math.abs(p[1])<=90)));
}
const stamp=value=>typeof value==='string'&&value.trim()?Date.parse(value):NaN;
const sameTime=(a,b)=>Number.isFinite(stamp(a))&&stamp(a)===stamp(b);
const optionalTime=value=>typeof value==='string'&&value.trim()?stamp(value):null;

function indexed(features,idOf){
  const byId=new Map();
  for(const feature of features||[]){
    const id=idOf(feature.properties||{});
    if(!id||!validPolygon(feature.geometry))continue;
    if(!byId.has(id))byId.set(id,[]);
    byId.get(id).push(feature);
  }
  return byId;
}

export const indexGISShapes=features=>indexed(features,p=>p.cap_id);
export const indexWinterShapes=features=>indexed(features,p=>p.event_id);

export async function loadAlertGIS(fetcher=globalThis.fetch){
  const features=[],limit=4000;
  const query=new URLSearchParams({where:'1=1',f:'geojson',returnGeometry:'true',outSR:'4326',
    geometryPrecision:'4',maxAllowableOffset:'0.004',orderByFields:'objectid ASC',resultRecordCount:String(limit),
    outFields:'objectid,cap_id,prod_type,issuance,expiration,ends'});
  const timeout=AbortSignal.timeout(25000);
  for(let page=0;page<5;page++){
    query.set('resultOffset',String(features.length));
    const response=await fetcher(service+'?'+query,{credentials:'omit',signal:timeout});
    if(!response.ok)throw Error('NWS warning geography unavailable');
    const collection=await response.json();
    if(collection.type!=='FeatureCollection'||!Array.isArray(collection.features))throw Error('NWS warning geography unavailable');
    features.push(...collection.features);
    if(collection.features.length<limit&&!collection.exceededTransferLimit&&!collection.properties?.exceededTransferLimit)return indexGISShapes(features);
    if(!collection.features.length)break;
  }
  throw Error('The complete NWS warning geography is unavailable');
}

function zoneGeometry(features,basis,partial=false){
  const shapes=features.map(f=>f.geometry);
  const geometry=shapes.length===1?shapes[0]:{type:'MultiPolygon',
    coordinates:shapes.flatMap(g=>g.type==='Polygon'?[g.coordinates]:g.coordinates)};
  return {geometry:[geometry],basis,partial};
}

/** Keep presentation geometry tied to a current, independently received CAP bulletin and edition. */
export function alertOutline(alert,winter,gis,now){
  if(!(stamp(alert.effective)<=now)||!(stamp(alert.expires)>now)||(alert.ends&&!(stamp(alert.ends)>now)))return null;
  if(alert.geometry?.some(validPolygon))return {geometry:alert.geometry.filter(validPolygon),basis:alert.geometry_status||'NWS bulletin polygon'};
  if(alert.warning_identity_status==='needs review')return null;
  const knownCodes=new Set(alert.ugc||[]);
  const zones=(winter?.get(alert.id)||[]).filter(({properties:p})=>p.event===alert.title&&knownCodes.has(p.ugc)
    &&sameTime(p.issued,alert.sent||alert.effective)&&stamp(p.valid_start)<=now&&stamp(p.valid_end)>now);
  const covered=new Set(zones.map(f=>f.properties.ugc));
  if(zones.length&&covered.size===knownCodes.size)return zoneGeometry(zones,'NWS forecast zones');
  // A CAP id may cover several VTEC segments. The original whole-message shape can include expired segments.
  if(alert.geometry_status!=='Active segment boundary unavailable'){
    const features=(gis?.get(alert.id)||[]).filter(({properties:p})=>p.prod_type===alert.title
      &&sameTime(p.issuance,alert.sent||alert.effective)&&sameTime(p.expiration,alert.expires)
      &&optionalTime(p.ends)===optionalTime(alert.ends));
    if(features.length)return zoneGeometry(features,'NWS Watches, Warnings and Advisories GIS boundary');
  }
  return zones.length?zoneGeometry(zones,'NWS forecast zones · partial boundary',true):null;
}
