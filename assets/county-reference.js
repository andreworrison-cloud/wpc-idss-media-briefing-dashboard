import {geometry} from './outage-layer.js';
const files=new Map();
const boxes={west:[-125,31,-101,50],central:[-105,35,-80,50],south:[-107,25,-81,40],southeast:[-84.7,24,-74,41],northeast:[-81,38,-66,48],islands:[-194,49,-128,74]};
function intersects(b,v){return b[0]<=v.getEast()&&b[2]>=v.getWest()&&b[1]<=v.getNorth()&&b[3]>=v.getSouth();}
async function load(root,region){
  const url=new URL('outage-geo-'+region+'.json',root).href;
  if(!files.has(url))files.set(url,fetch(url).then(r=>{if(!r.ok)throw Error('County boundaries unavailable');return r.json();}).catch(e=>{files.delete(url);throw e;}));
  return files.get(url);
}
export async function visibleCountyLines(L,map,root) {
  const v=map.getBounds().pad(.05),center=map.getCenter().lng;
  const regions=Object.entries(boxes).filter(([id,b])=>intersects(b,v)||id==='islands'&&(
    intersects([-161,18,-154,23],v)||intersects([-68,17,-64,19],v)||intersects([144,12,146.5,21],v)||intersects([-171.5,-15,-168,-10],v)));
  const files=await Promise.all(regions.map(([id])=>load(root,id)));
  const lines=[];
  for(const file of files)for(const record of file.features){
    if(/^090(01|03|05|07|09|11|13|15)$/.test(record[0]))continue;
    const b=record[3], shift=360*Math.round((center-(b[0]+b[2])/2)/360);
    if(!intersects([b[0]+shift,b[1],b[2]+shift,b[3]],v))continue;
    for(const poly of geometry(file,record,shift))for(const ring of poly)lines.push(ring);
  }
  return L.polyline(lines,{pane:'idss-counties',color:'#56707C',opacity:.64,weight:map.getZoom()<6?.38:.65,interactive:false,smoothFactor:1});
}
