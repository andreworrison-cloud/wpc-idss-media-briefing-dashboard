const SVGS={
 snow:'<path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 4l3 3 3-3M9 20l3-3 3 3M4 10l4-1-1-4M17 19l-1-4 4-1M4 14l4 1-1 4M17 5l-1 4 4 1"/>',
 ice:'<path d="M12 2 21 12 12 22 3 12ZM12 7v7m0 2v1"/>',
 rain:'<path d="M12 2C10 7 5 11 5 15a7 7 0 0 0 14 0c0-4-5-9-7-13Zm-3 13c0 2 1 3 3 4"/>',
 wind:'<path d="M2 9h11a3 3 0 1 0-3-3m-8 7h16a3 3 0 1 0-3-3M5 17h8a3 3 0 1 1-3 3"/>',
 hail:'<path d="m12 2 5 6-5 6-5-6Zm-7 12 3 4-3 4-3-4Zm12 0 3 4-3 4-3-4Z"/>',
 cold:'<path d="M10 4a2 2 0 0 1 4 0v10a5 5 0 1 1-4 0Zm2 7v6m4-11h4"/>',
 heat:'<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',
 effect:'<path d="m12 3 10 17H2Zm0 5v6m0 2v1"/>',
 plane:'<path d="m12 2 2 7 7 4v2l-7-2-1 5 3 2v1l-4-1-4 1v-1l3-2-1-5-7 2v-2l7-4Z"/>',
 gauge:'<path d="M7 3v12m4-10H7m4 4H7m4 4H7M2 18q3-3 6 0t6 0 6 0"/>',
 impact:'<path d="m12 2 10 10-10 10L2 12Zm0 5v6m0 3v1"/>'
};
export const POINT_COLORS={snow:'#1970B7',ice:'#7545A5',rain:'#087F80',wind:'#327045',hail:'#6B4DA9',cold:'#23639A',heat:'#B24E24',effect:'#9D4D27',plane:'#215E92',gauge:'#3279A6',impact:'#915B2F'};
export const POINT_LABELS={snow:'Snow / sleet',ice:'Ice',rain:'Rain',wind:'Wind',hail:'Hail',cold:'Cold',heat:'Heat',effect:'Observed impact',plane:'Airport program',gauge:'River gauge',impact:'Ground impact'};
export const textValue=v=>v===null||v===undefined||v===''?'':String(v);
export const utc=v=>{
  const d=new Date(v||'invalid');return Number.isFinite(+d)?d.toLocaleString('en-US',{timeZone:'UTC',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})+' UTC':'';
};
const human=v=>String(v||'').replace(/[_-]+/g,' ');
function categoryOf(raw) {
  if(POINT_COLORS[raw.category])return raw.category;
  const str=(raw.phenomenon||raw.title||'').toLowerCase();
  if(/freezing rain|ice acc|ice storm/.test(str))return 'ice';
  if(/snow|sleet|blizzard/.test(str))return 'snow';
  if(/rain|precip/.test(str))return 'rain';
  if(/gust|wind/.test(str)&&!str.includes('damage'))return 'wind';
  if(/hail/.test(str))return 'hail';return 'effect';
}
export function reportPoint(r) {
  const lat=r.latitude??r.lat, lon=r.longitude??r.lon;
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>85||Math.abs(lon)>180)return null;
  const source=r.sourceType||'LSR', cat=categoryOf(r), val=r.value??r.magnitude;
  const measurement=val==null?'':textValue(val)+' '+textValue(r.unit);
  const place=[r.place||r.city||r.location,r.state].filter(Boolean).join(', ');
  const phenomenon=r.phenomenon||r.title||POINT_LABELS[cat];
  const value=r.trace?'Trace':measurement.trim(), knownQ=r.qualifier&&!/^(unknown|not reported)$/i.test(r.qualifier)?r.qualifier:'';
  const label=r.label||phenomenon, head=value?value+' · '+phenomenon:label;
  const duration=r.durationHours??r.accumulation_hours;
  const lines=[place,(r.observedAt||r.valid)?'Observed '+utc(r.observedAt||r.valid):'Observation time unavailable',
    [source==='PNS'?'Public Information Statement':'Local Storm Report',r.office||r.wfo].filter(Boolean).join(' · '),
    Number.isFinite(duration)?duration+' h accumulation':r.periodLabel,
    [r.measurementType&&human(r.measurementType),knownQ&&human(knownQ)].filter(Boolean).join(' · '),
    (r.issuedAt||r.issued)?'Issued '+utc(r.issuedAt||r.issued):'',
    ...(r.impactFlags||r.impact_flags||[]).map(human)].filter(Boolean);
  return {id:r.id,lat,lon,cat,source,color:POINT_COLORS[cat],title:head,place,lines,detail:lines.join(' · '),
    url:r.url||r.source_url,value,record:r};
}
export function detailNode(doc,info,expanded=false) {
  const root=doc.createElement('div');root.className='idss-detail-content';
  root.setAttribute('data-testid',expanded?'idss-geo-popup':'idss-geo-tooltip');
  const add=(type,t,cls)=>{const n=doc.createElement(type);n.className=cls||'';n.textContent=t;root.append(n);return n;};
  if(info.kind||info.source)add('span',info.kind||info.source,'idss-detail-type');
  add('strong',info.title||'Map detail','idss-detail-title');
  const lines=info.lines?.length?info.lines:info.detail?[info.detail]:[];
  for(const line of lines.slice(0,expanded?18:5))if(line)add('span',line,'idss-detail-line');
  if(expanded&&info.url){try{const url=new URL(info.url);if(url.protocol==='https:'){const a=add('a','Open source ↗','idss-detail-source');a.href=url.href;a.target='_blank';a.rel='noopener';}}catch{}}
  return root;
}
export function decorate(L,layer,info,opts={}) {
  const doc=opts.document||document;
  layer.bindTooltip(()=>detailNode(doc,info),{sticky:opts.sticky!==false,direction:'top',offset:[0,-7],opacity:1,className:'idss-geo-tooltip'});
  layer.bindPopup(()=>detailNode(doc,info,true),{maxWidth:330,maxHeight:340,autoPanPadding:[18,25],className:'idss-geo-popup'});
  layer.on('click',()=>opts.onDetail?.(info));
  return layer;
}
export function pointIcon(L,doc,info,count=1,showValue=false) {
  const span=doc.createElement('span');span.className='idss-glyph';
  span.style.setProperty('--glyph-color',info.color||POINT_COLORS[info.cat]||POINT_COLORS.effect);
  span.dataset.category=info.cat;span.setAttribute('data-testid','idss-report-glyph');
  const body=doc.createElement('span');body.className='idss-glyph-shape';
  body.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'+(SVGS[info.cat]||SVGS.effect)+'</svg>';
  span.append(body);
  if(count>1||showValue&&info.value){const tag=doc.createElement('small');tag.className='idss-glyph-count';tag.textContent=count>1?String(count):info.value;span.append(tag);}
  return L.divIcon({html:span,className:'idss-marker',iconSize:[22,22],iconAnchor:[11,11],popupAnchor:[0,-9],tooltipAnchor:[0,-5]});
}
export function observationsOnMap(L,map,target,rows,{onDetail,source='all',category='all',doc=document,selected}={}) {
  const zoom=map.getZoom(), box=map.getBounds().pad(.15), buckets=new Map(), index=new Map();
  const width=map.getSize().x<600?32:zoom<5?31:26;
  const clusters=[];
  const sourceKey=source.toUpperCase(), near=lon=>lon+360*Math.round((map.getCenter().lng-lon)/360);
  for(const info of rows) {
    if(!info||category!=='all'&&info.cat!==category||sourceKey!=='ALL'&&info.source!==sourceKey)continue;
    index.set(info.id,info);
    const at=L.latLng(info.lat,near(info.lon));if(!box.contains(at))continue;
    // A symbol stays on the first source coordinate in that cell. It advertises the report count.
    const px=map.latLngToContainerPoint(at),x=Math.floor(px.x/width),y=Math.floor(px.y/width);
    let found=null,best=width;
    for(let i=x-1;i<=x+1;i++)for(let j=y-1;j<=y+1;j++){
      for(const seed of buckets.get(i+','+j)||[]){
        const distance=seed.pixel.distanceTo(px);
        if(distance<best){best=distance;found=seed;}
      }
    }
    if(found)found.records.push(info);
    else{
      const seed={pixel:px,records:[info]},cell=x+','+y;
      if(!buckets.has(cell))buckets.set(cell,[]);buckets.get(cell).push(seed);clusters.push(seed);
    }
  }
  for(const {records} of clusters){
    const first=records[0],more=records.length-1,at=L.latLng(first.lat,near(first.lon));
    const info=more?{...first,kind:[...new Set(records.map(r=>r.source))].filter(Boolean).join(' / ')+' · '+records.length+' reports',
      title:first.title,lines:[first.place,...first.lines.filter(v=>v!==first.place).slice(0,3),more+' additional nearby report'+(more===1?'':'s')]}:first;
    const marker=L.marker(at,{icon:pointIcon(L,doc,first,records.length,zoom>=6.2),alt:info.title,title:'',keyboard:true,autoPanOnFocus:false,pane:'idss-points',
      zIndexOffset:more?Math.min(30,more):0}).addTo(target);
    decorate(L,marker,info,{document:doc,onDetail,sticky:false});
    marker.getElement()?.setAttribute('aria-label',[info.title,info.place,info.kind||info.source].filter(Boolean).join(', '));
    marker.getElement()?.setAttribute('data-observation-id',String(first.id||''));
    if(more)marker.bindPopup(()=>{
      const wrapper=doc.createElement('div'), overview=detailNode(doc,info,true), list=doc.createElement('div');list.className='idss-nearby-list';
      for(const record of records.slice(1)){
        const item=doc.createElement('button');item.type='button';item.textContent=[record.title,record.place].filter(Boolean).join(' · ');
        item.onclick=()=>{
          const detail=detailNode(doc,record,true), back=doc.createElement('button');
          back.type='button';back.textContent='All nearby reports';back.onclick=()=>wrapper.replaceChildren(overview);
          detail.append(back);wrapper.replaceChildren(detail);onDetail?.(record);
        };list.append(item);
      }overview.append(list);wrapper.append(overview);return wrapper;
    },{maxWidth:345,maxHeight:300,className:'idss-geo-popup'});
    if(selected===first.id)marker.openPopup();
  }
  return index;
}
