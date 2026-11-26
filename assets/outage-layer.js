// Native geographic Census boundaries. Source measures are joined only at their reported level.
const SOURCE = 'Power Out Map';
const CREDIT = 'Outages <a href="https://poweroutmap.com/" target="_blank" rel="noopener noreferrer">Power Out Map</a> · Boundaries <a href="https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.2025.html" target="_blank" rel="noopener noreferrer">U.S. Census</a>';
const MAX_AGE = 30 * 60 * 1000;
const COUNTY_ZOOM = 6;
const GEO_CACHE = new Map();
const NUM = new Intl.NumberFormat('en-US');
const REGION = Object.fromEntries(Object.entries({
  west:'WA OR CA NV ID MT WY UT CO AZ NM', central:'ND SD NE KS IA MN MO WI IL MI IN OH',
  south:'OK TX AR LA MS TN KY AL', southeast:'WV VA NC SC GA FL MD DE DC',
  northeast:'PA NY NJ CT RI MA VT NH ME', islands:'AK HI AS GU MP PR VI',
}).flatMap(([region, codes]) => codes.split(' ').map(code => [code, region])));
const OLD_CT = /^090(01|03|05|07|09|11|13|15)$/;
const NEW_CT = /^091[1-9]0$/;

export const OUTAGE_LEGEND = Object.freeze([
  {id:'missing', label:'No mapped report', color:'#e0e3e3'},
  {id:'zero', label:'0 reported', color:'#6d9eac', min:0},
  {id:'ones', label:'1–9', color:'#fff2b5', min:1},
  {id:'tens', label:'10–99', color:'#fbd269', min:10},
  {id:'hundreds', label:'100–999', color:'#f5a23d', min:100},
  {id:'thousands', label:'1,000–9,999', color:'#db652f', min:1000},
  {id:'large', label:'10,000–99,999', color:'#a33131', min:10000},
  {id:'largest', label:'100,000+', color:'#642443', min:100000},
].map(Object.freeze));

export function outageBand(value) {
  if (!Number.isSafeInteger(value) || value < 0) return OUTAGE_LEGEND[0];
  for (let i=OUTAGE_LEGEND.length-1;i>0;i--) if (value >= OUTAGE_LEGEND[i].min) return OUTAGE_LEGEND[i];
}

export function sectionStatus(data, level, now=Date.now()) {
  const prefix = level === 'state' ? 'states' : 'counties';
  const at = data?.[prefix+'_as_of'] || null;
  const stamp = Date.parse(at);
  const status = data?.[prefix+'_status'] || 'unavailable';
  if (data?.status !== 'current') return {status:data?.status === 'stale'?'stale':'unavailable', as_of:at};
  if (status !== 'current') return {status:['stale','inconsistent'].includes(status)?status:'unavailable',as_of:at};
  if (!Number.isFinite(stamp) || stamp > now+120000) return {status:'unavailable',as_of:null};
  if (now-stamp > MAX_AGE) return {status:'stale',as_of:at};
  return {status:'current',as_of:at};
}

function index(list, level) {
  const map = new Map();
  for (const row of Array.isArray(list)?list:[]) {
    if (!row || typeof row !== 'object') continue;
    const id = level==='state' ? row.state : row.fips;
    if (typeof id === 'string') map.set(id, map.has(id)?null:row);
  }
  return map;
}

export function ctVintage(rows) {
  let old=false, modern=false;
  for (const row of Array.isArray(rows)?rows:[]) {
    if (OLD_CT.test(row?.fips)) old=true;
    if (NEW_CT.test(row?.fips)) modern=true;
  }
  return old && modern ? 'mixed' : modern ? 'planning' : 'legacy';
}

export function decodeArc(text, q) {
  let x=0, y=0, offset=0;
  const result=[];
  function delta() {
    let b, shift=0, value=0;
    do {
      if (offset === text.length || shift>30) throw Error('Invalid Census arc');
      b=text.charCodeAt(offset++)-63;
      value |= (b&31) << shift;
      shift+=5;
    } while (b>=32);
    return (value>>>1)^-(value&1);
  }
  while (offset < text.length) { x+=delta(); y+=delta(); result.push([y/q,x/q]); }
  return result;
}

export function geometry(file, record, shift=0) {
  file.decoded ??= new Map();
  return record[4].map(polygon => polygon.map(ring => {
    const result=[];
    for (const j of ring) {
      const i=j<0?~j:j;
      if (!file.decoded.has(i)) file.decoded.set(i,decodeArc(file.arcs[i],file.q));
      const arc=file.decoded.get(i);
      for (let n=result.length?1:0;n<arc.length;n++) {
        const pt=arc[j<0?arc.length-1-n:n];
        result.push(shift?[pt[0],pt[1]+shift]:pt);
      }
    }
    return result;
  }));
}

function fileAt(base, name) {
  const url=new URL('outage-geo-'+name+'.json',base).href;
  if (!GEO_CACHE.has(url)) {
    const request=fetch(url).then(async reply=>{
      if (!reply.ok) throw Error('Outage boundaries could not be loaded');
      const file=await reply.json();
      if (file.v!==1 || file.q!==10000 || !Array.isArray(file.features) || !Array.isArray(file.arcs)) {
        throw Error('Unsupported outage geography');
      }
      return file;
    }).catch(error=>{GEO_CACHE.delete(url);throw error});
    GEO_CACHE.set(url,request);
  }
  return GEO_CACHE.get(url);
}

function utc(stamp) {
  const ms=Date.parse(stamp);
  if (!Number.isFinite(ms)) return 'Time unavailable';
  const iso=new Date(ms).toISOString();
  return iso.slice(0,10)+' '+iso.slice(11,16)+' UTC';
}
function shiftFor(box, center) { return 360*Math.round((center-(box[0]+box[2])/2)/360); }
function touches(box, viewport, shift) {
  return box[0]+shift <= viewport.getEast() && box[2]+shift >= viewport.getWest()
    && box[1] <= viewport.getNorth() && box[3] >= viewport.getSouth();
}
function node(tag, cls, content) {
  const el=document.createElement(tag);
  if (cls) el.className=cls;
  if (content!=null) el.textContent=content;
  return el;
}
function finiteCount(v) { return Number.isSafeInteger(v)&&v>=0?v:null; }
function percent(v) { return Number.isFinite(v)&&v>=0&&v<=100?v:null; }

function detailFor(record, level, row, section, mixed) {
  const [fips,state,name,box]=record;
  const available=section.status==='current' && !mixed;
  const coverage=available?percent(row?.coverage_percent):null;
  const tracked=available?finiteCount(row?.customers_tracked):null;
  let out=available?finiteCount(row?.customers_out):null;
  if (level==='state' && out===0 && !(coverage>0 || tracked>0)) out=null;
  const status=mixed?'inconsistent':section.status;
  const label=out==null ? (status==='current'?'No mapped report':status==='stale'?'Reading expired':
    (status==='inconsistent'?'Reporting geography inconsistent':'Reading unavailable')):
    out===0?'0 customers reported out':NUM.format(out)+(out===1?' customer out':' customers out');
  return {kind:'outage',level,fips,state,name,customers_out:out,customers_tracked:tracked,coverage_percent:coverage,
    status,as_of:section.as_of,source:SOURCE,source_url:'https://poweroutmap.com/',label,
    title:level==='county'?name+', '+state:name,
    lat:Number.isFinite(row?.lat)?row.lat:(box[1]+box[3])/2,lon:Number.isFinite(row?.lon)?row.lon:(box[0]+box[2])/2};
}

function makeCard(d, full, drill) {
  const content=node('div','wpc-outage-card');
  content.append(node('strong','wpc-outage-title',d.title),node('span','wpc-outage-value',d.label));
  if (d.coverage_percent!==null) content.append(node('span','wpc-outage-meta','Reporting utilities cover '+NUM.format(d.coverage_percent)+'% of state accounts'));
  if (full && d.customers_tracked!==null) content.append(node('span','wpc-outage-meta',NUM.format(d.customers_tracked)+' accounts tracked'));
  if (full && d.level==='county' && d.status==='current' && d.customers_out===null) {
    content.append(node('span','wpc-outage-meta','This feed lists counties with reported interruptions. Local coverage is unknown.'));
  }
  content.append(node('span','wpc-outage-time',d.level[0].toUpperCase()+d.level.slice(1)+' reading · '+utc(d.as_of)));
  if (full) {
    if (d.level==='state' && drill) {
      const b=node('button','wpc-outage-drill','Explore counties');
      b.type='button';
      b.addEventListener('click',drill);
      content.append(b);
    }
    const source=node('a','wpc-outage-credit','Power Out Map');
    source.href='https://poweroutmap.com/';source.target='_blank';source.rel='noopener noreferrer';
    content.append(source);
  }
  return content;
}

function pathStyle(d, zoom, hot=false) {
  const band=outageBand(d.customers_out);
  const state=d.level==='state';
  const missing=band.id==='missing';
  return {stroke:hot||state||!missing||zoom>=8,color:hot?'#134b6a':missing?'#708189':state?'#605b50':'#806a51',
    weight:hot ? 2.1 : state ? 1.05 : missing ? 0.45 : 0.70,
    opacity:hot ? 1 : missing ? (state ? 0.45 : 0.18) : state ? 0.78 : 0.72,
    fill:true,fillColor:band.color,fillOpacity:hot ? (missing ? 0.20 : 0.88) : missing ? (state ? 0.16 : 0.055) : state ? 0.72 : 0.78,
    fillRule:'evenodd',smoothFactor:.65,interactive:true,bubblingMouseEvents:false};
}

function modeValue(value) { return ['states','state'].includes(value)?'states':['counties','county'].includes(value)?'counties':'auto'; }

export function createOutageLayer(options) {
  const {map,L,onSelect=()=>{},onStatus=()=>{}}=options;
  const clock=typeof options.now==='function'?options.now:Date.now;
  const rawBase=options.assetBase || new URL('./',import.meta.url).href;
  const base=new URL(String(rawBase).replace(/\/?$/,'/'),document.baseURI);
  const paneName='idss-outages';
  const pane=map.getPane(paneName) || map.createPane(paneName);
  if (!pane.style.zIndex) pane.style.zIndex='340';
  const renderer=L.canvas({pane:paneName,padding:.24,tolerance:0}) || L.svg({pane:paneName});
  let data={}, byState=new Map(),byCounty=new Map(), vintage='legacy', dataRevision=0;
  let active=options.active!==false,disposed=false,mode=modeValue(options.mode),serial=0,raf=0,expiry=0;
  let held=new Map(),lastStatus=null,popup=null,keyControl=null,creditControl=null,credited=false;
  let nativeLegendBody=null,modeSelect=null;
  function declare(status) {
    lastStatus=status;
    if (nativeLegendBody) nativeLegendBody.textContent=(status.level==='county'?'County':'State')+' · '+utc(status.as_of);
    if (modeSelect) modeSelect.value=mode;
    onStatus(status);
    return status;
  }
  function getLevel() { return mode==='auto'?(map.getZoom()>=COUNTY_ZOOM?'county':'state'):mode==='counties'?'county':'state'; }
  function pick(record,level,section) {
    const row=(level==='state'?byState:byCounty).get(level==='state'?record[1]:record[0]);
    return detailFor(record,level,row,section,level==='county'&&record[1]==='CT'&&vintage==='mixed');
  }
  function clearShapes() {
    for (const v of held.values()) v.layer.remove();
    held.clear();
    if (popup?.isOpen()) map.closePopup(popup);
    popup=null;
  }
  function controls(show) {
    if (!show) {
      if (credited) map.attributionControl?.removeAttribution(CREDIT);
      credited=false;keyControl?.remove();creditControl?.remove();keyControl=creditControl=nativeLegendBody=modeSelect=null;
      return;
    }
    if (!credited) {
      if (map.attributionControl) map.attributionControl.addAttribution(CREDIT);
      else {
        creditControl=L.control({position:'bottomright'});
        creditControl.onAdd=()=>{const el=node('div','leaflet-control-attribution');el.innerHTML=CREDIT;return el;};
        creditControl.addTo(map);
      }
      credited=true;
    }
    if (options.showLegend===false || keyControl) return;
    keyControl=L.control({position:'bottomleft'});
    keyControl.onAdd=()=>{
      const box=node('div','wpc-outage-key');
      const head=node('div','wpc-outage-keyhead');
      head.append(node('strong','', 'Customers without power'));
      modeSelect=node('select','');modeSelect.setAttribute('aria-label','Outage reporting geography');
      for (const [value,label] of [['auto','Auto'],['states','States'],['counties','Counties']]) {
        const op=node('option','',label);op.value=value;modeSelect.append(op);
      }
      modeSelect.addEventListener('change',()=>api.setMode(modeSelect.value));head.append(modeSelect);box.append(head);
      nativeLegendBody=node('span','wpc-outage-time');box.append(nativeLegendBody);
      const bins=node('div','wpc-outage-bins');
      for (const bin of OUTAGE_LEGEND) {
        const cell=node('span','');const chip=node('i','');chip.style.backgroundColor=bin.color;
        cell.append(chip,document.createTextNode(bin.label));bins.append(cell);
      }
      box.append(bins);L.DomEvent.disableClickPropagation(box);L.DomEvent.disableScrollPropagation(box);return box;
    };
    keyControl.addTo(map);
  }
  function schedule() {
    if (!raf && active && !disposed) raf=requestAnimationFrame(()=>{raf=0;void render();});
  }
  function open(record,level,latlng) {
    const d=pick(record,level,sectionStatus(data,level,clock()));
    if (popup?.isOpen()) map.closePopup(popup);
    for (const entry of held.values()) if (entry.layer.isTooltipOpen()) entry.layer.closeTooltip();
    popup=L.popup({className:'wpc-outage-pop',maxWidth:285,autoPanPadding:[20,26]}).setLatLng(latlng)
      .setContent(makeCard(d,true,()=>{
        map.closePopup(popup);mode='auto';map.setView(latlng,Math.max(COUNTY_ZOOM,map.getZoom()+1));schedule();
      })).openOn(map);
    // Other consumers may want geographic labels without opening a second popup.
    onSelect({...d,detail:d.label+' · '+utc(d.as_of),url:d.source_url});
  }
  function shape(file,record,level,shift,section) {
    const entry={item:pick(record,level,section),revision:dataRevision,zoom:map.getZoom(),status:section.status,hot:false};
    const layer=L.polygon(geometry(file,record,shift),{...pathStyle(entry.item,entry.zoom),pane:paneName,renderer});
    entry.layer=layer;
    layer.bindTooltip(()=>makeCard(pick(record,level,sectionStatus(data,level,clock())),false),{
      className:'wpc-outage-tip',sticky:true,direction:'auto',opacity:.98,offset:[10,3]});
    layer.on('tooltipopen',()=>{if(popup?.isOpen())layer.closeTooltip();});
    layer.on('mouseover',()=>{entry.hot=true;layer.setStyle(pathStyle(entry.item,map.getZoom(),true));});
    layer.on('mouseout',()=>{entry.hot=false;layer.setStyle(pathStyle(entry.item,map.getZoom()));});
    layer.on('click',e=>open(record,level,e.latlng));
    layer.addTo(map);
    return entry;
  }
  async function render() {
    if (!active || disposed) return lastStatus;
    const token=++serial,level=getLevel(),section=sectionStatus(data,level,clock());
    clearTimeout(expiry);
    if (section.status==='current') {
      expiry=setTimeout(()=>{if(!disposed && active){clearShapes();void render();}},Math.max(1,Date.parse(section.as_of)+MAX_AGE-clock()+10));
    }
    controls(true);
    const summary={level,mode,status:section.status,as_of:section.as_of,legend:OUTAGE_LEGEND,unit:'Electric customer accounts',
      source:SOURCE,source_url:'https://poweroutmap.com/',geometry_status:'current',visible_features:0,ct_geography:vintage};
    let states;
    try { states=await fileAt(base,'states'); }
    catch {if(token===serial && active&&!disposed){clearShapes();return declare({...summary,geometry_status:'unavailable'});} return lastStatus;}
    if(token!==serial||!active||disposed) return lastStatus;
    const view=map.getBounds().pad(.12),center=map.getCenter().lng;
    const within=r=>touches(r[3],view,shiftFor(r[3],center));
    const inView=states.features.filter(within);
    let files=[states];
    if(level==='county') {
      const regions=[...new Set(inView.map(s=>REGION[s[1]]).filter(Boolean))];
      const downloads=await Promise.allSettled(regions.map(name=>fileAt(base,name)));
      files=downloads.filter(x=>x.status==='fulfilled').map(x=>x.value);
      if(files.length!==downloads.length)summary.geometry_status=files.length?'partial':'unavailable';
    }
    if(token!==serial||!active||disposed) return lastStatus;
    const next=new Map(), zoom=map.getZoom();
    for(const file of files) {
      for(const r of file.features) {
        if(!within(r))continue;
        if(level==='county'&&r[1]==='CT'&&(vintage==='legacy'?NEW_CT.test(r[0]):OLD_CT.test(r[0])))continue;
        const shift=shiftFor(r[3],center),key=level+'/'+r[0]+'/'+shift;
        let entry=held.get(key);
        if(!entry)entry=shape(file,r,level,shift,section);
        else if(entry.revision!==dataRevision||entry.zoom!==zoom||entry.status!==section.status) {
          entry.item=pick(r,level,section);entry.revision=dataRevision;entry.zoom=zoom;entry.status=section.status;
          entry.layer.setStyle(pathStyle(entry.item,zoom,entry.hot));
          if(entry.layer.isTooltipOpen())entry.layer.getTooltip().update();
        }
        next.set(key,entry);
      }
    }
    for(const [key,entry] of held)if(!next.has(key))entry.layer.remove();
    held=next;summary.visible_features=next.size;
    return declare(summary);
  }
  async function focus(query,{popup:withPopup=false,isCurrent=()=>true}={}) {
    if(disposed||query==null||!isCurrent())return false;
    const q=String(query).trim().toLowerCase();
    const states=await fileAt(base,'states');
    let s=states.features.find(r=>[r[0],r[1],r[2]].some(v=>v.toLowerCase()===q));
    let r=s,level='state';
    if(!r) {
      let code=q;
      if(!/^\d{5}$/.test(code)) {
        const candidates=[...byCounty.values()].filter(row=>row && [row.name,row.name+', '+row.state]
          .some(v=>v?.toLowerCase()===q));
        if(candidates.length!==1)return false;
        code=candidates[0].fips;
      }
      s=states.features.find(state=>state[0]===code.slice(0,2));
      if(!s)return false;
      const file=await fileAt(base,REGION[s[1]]);
      r=file.features.find(v=>v[0]===code);
      if(!r || (s[1]==='CT'&&(vintage==='mixed'||(vintage==='legacy'?NEW_CT.test(code):OLD_CT.test(code)))))return false;
      level='county';
    }
    if(disposed||!isCurrent())return false;
    if(!active){active=true;controls(true);}
    // State focus in Hawaii opens on the main islands; Manawai and the outlying islands retain their coordinates.
    const box=level==='state'&&r[1]==='HI'?[-160.65,18.8,-154.7,22.5]:r[3];
    const shift=shiftFor(box,map.getCenter().lng);
    const bounds=L.latLngBounds([box[1],box[0]+shift],[box[3],box[2]+shift]);
    if(level==='county')mode='counties';
    map.fitBounds(bounds,{padding:[26,26],maxZoom:level==='state'?8:11,animate:false});
    await render();
    if(withPopup&&!disposed&&isCurrent())open(r,level,bounds.getCenter());
    return true;
  }
  const api={
    setData(value){data=value?.impacts?.power||value||{};byState=index(data.states,'state');byCounty=index(data.counties,'county');
      vintage=ctVintage(data.counties);dataRevision++;if(popup?.isOpen())map.closePopup(popup);return render();},
    setMode(value){mode=modeValue(value);if(popup?.isOpen())map.closePopup(popup);return render();},
    setActive(value){active=Boolean(value);if(!active){serial++;clearTimeout(expiry);clearShapes();controls(false);return Promise.resolve(lastStatus);}return render();},
    focus,refresh:render,getStatus:()=>lastStatus,
    destroy(){disposed=true;active=false;serial++;clearTimeout(expiry);cancelAnimationFrame(raf);map.off('zoomend moveend',schedule);
      clearShapes();controls(false);if(map.hasLayer(renderer))renderer.remove();},
  };
  map.on('zoomend moveend',schedule);
  if(options.data)void api.setData(options.data);else if(active)schedule();
  return api;
}

export const create = createOutageLayer;
if (typeof window!=='undefined') window.WPCOutages={create:createOutageLayer,legend:OUTAGE_LEGEND};
