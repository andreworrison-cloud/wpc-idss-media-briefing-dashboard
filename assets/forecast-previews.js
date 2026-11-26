import {activeDay} from './logic.js';
import {loadReference, MAP_REGIONS} from './geographic-base.js';
import {ERO_COLORS, WSSI_COLORS} from './hazard-palette.js';

const specs=[['ero1','Excessive rainfall','Day 1'],['winter','Winter storm severity','Day 1'],['mpd','Precipitation discussions','Active MPDs']];
const supported=new Set(['current','ok','partial','none']);
const otherStates=new Set(['AK','HI','PR','VI','GU','MP','AS']);
const sourceTime=t=>Number.isFinite(Date.parse(t))?new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(Date.parse(t))+' UTC':'';
const polygons=f=>f?.geometry?.type==='Polygon'||f?.geometry?.type==='MultiPolygon';
const fresh=(s,now)=>supported.has(s?.status)&&Date.parse(s.fresh_until)>now;
const colors={ero1:ERO_COLORS,winter:WSSI_COLORS};
function category(id,f){return id==='ero1'?f?.properties?.risk:f?.properties?.impact||f?.properties?.label;}
function featuresFor(source){return (Array.isArray(source?.features)?source.features:[]).filter(polygons).slice().sort((a,b)=>(a.properties?.rank??-1)-(b.properties?.rank??-1));}
export function previewData(id,board,now=Date.now()){
  const model={features:[],message:'Current product unavailable',time:'',region:'CONUS',color:null};
  if(id==='mpd'){
    const data=board?.weather?.mpd;if(!fresh(data,now))return model;
    model.features=featuresFor(data).filter(f=>Date.parse(f.properties?.valid_start)<=now&&now<Date.parse(f.properties?.valid_end));
    const ids=[...new Set(model.features.map(f=>f.properties.number).filter(n=>n!=null))];
    if(ids.length){
      model.message=ids.length===1?'MPD '+String(ids[0]).padStart(4,'0'):ids.length+' active discussions';
      if(data.status==='partial')model.message+=' · partial';
      const latest=Math.max(...model.features.map(f=>Date.parse(f.properties.valid_end)));
      model.time='Through '+sourceTime(new Date(latest).toISOString());
      model.color='#b893eb';
      const regions=new Set(model.features.map(f=>{
        const p=f.geometry.type==='Polygon'?f.geometry.coordinates[0]?.[0]:f.geometry.coordinates[0]?.[0]?.[0];
        if(!p)return 'CONUS';
        for(const key of ['AK','HI','PR','GU','AS']){
          const [[s,w],[n,e]]=MAP_REGIONS[key].bounds;let lon=p[0];if(key==='AK'&&lon>0)lon-=360;
          if(p[1]>=s-1&&p[1]<=n+1&&lon>=w-1&&lon<=e+1)return key;
        }return 'CONUS';
      }));
      model.region=regions.size===1?[...regions][0]:'CONUS';
      if(regions.size>1)model.message+=' · multiple regions';
    }else{
      if(data.explicit_no_mpd===true&&data.count===0&&data.status!=='partial')model.message='No active MPD';
      else model.message='Active coverage unconfirmed';
      model.time=sourceTime(data.checked_at||data.checkedAt||data.retrieved_at||data.as_of||data.asOf);
    }
    return model;
  }
  const source=id==='ero1'?activeDay(board,1,now):board?.weather?.winter?.layers?.find(l=>l.id==='wssi_d1');
  if(!source||!fresh(source,now)||!(Date.parse(source.valid_end)>now))return model;
  model.features=featuresFor(source);const highest=model.features[model.features.length-1];
  const name=category(id,highest);
  if(highest){
    model.color=colors[id][name]||null;
    model.message=id==='ero1'?name+' risk':name==='Winter Weather Area'?name:name+' impacts';
    if(source.status==='partial'||source.collapsed_display_rings)model.message+=' · partial';
  } else if(id==='ero1'&&source.no_risk_area===true)model.message='No risk area issued';
  else if(id==='winter'&&source.status==='none')model.message='No mapped winter impacts';
  else model.message='Coverage unconfirmed';
  model.time='Valid to '+sourceTime(source.valid_end);
  return model;
}
const rad=Math.PI/180,n=(Math.sin(29.5*rad)+Math.sin(45.5*rad))/2,C=Math.cos(29.5*rad)**2+2*n*Math.sin(29.5*rad);
function project(lon,lat,region){
  if(region==='CONUS'){
    const radius=Math.sqrt(C-2*n*Math.sin(lat*rad))/n,theta=n*(lon+96)*rad;
    return [radius*Math.sin(theta),radius*Math.cos(theta)];
  }
  const bounds=MAP_REGIONS[region].bounds,center=(bounds[0][1]+bounds[1][1])/2;
  return [(lon+360*Math.round((center-lon)/360))*Math.cos(rad*(bounds[0][0]+bounds[1][0])/2),-lat];
}
function rings(geom,visit){
  const pieces=geom.type==='MultiPolygon'?geom.coordinates:[geom.coordinates];
  for(const poly of pieces)for(const ring of poly)if(ring?.length>=3)visit(ring);
}
const baseByRegion=new Map();
function plates(geo,region){
  if(baseByRegion.has(region))return baseByRegion.get(region);
  const stateMatch={AK:['AK'],HI:['HI'],PR:['PR','VI'],GU:['GU','MP'],AS:['AS']};
  const states=geo.states.filter(s=>region==='CONUS'?!otherStates.has(s.code):stateMatch[region].includes(s.code));
  let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
  for(const state of states)rings(state.geometry,ring=>{for(const p of ring){const [x,y]=project(...p,region);x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}});
  if(!Number.isFinite(x0))return null;
  const scale=Math.min(266/(x1-x0||1),114/(y1-y0||1)), ox=(290-(x1-x0)*scale)/2,oy=(124-(y1-y0)*scale)/2;
  function path(geom){
    const result=new Path2D();
    rings(geom,ring=>{let lastX,lastY;for(const [i,p] of ring.entries()){
      const [x,y]=project(...p,region), xx=ox+(x-x0)*scale, yy=oy+(y-y0)*scale;
      if(!i)result.moveTo(xx,yy);else if(i===ring.length-1||Math.abs(xx-lastX)+Math.abs(yy-lastY)>.26)result.lineTo(xx,yy);else continue;
      lastX=xx;lastY=yy;
    }result.closePath();});
    return result;
  }
  const base=new Path2D();for(const state of states)base.addPath(path(state.geometry));
  const result={base,path,weather:new WeakMap()};baseByRegion.set(region,result);return result;
}
function paint(canvas,id,model,geo){
  if(!geo)return;
  const plate=plates(geo,model.region);if(!plate)return;
  const dark=document.documentElement.dataset.theme!=='light', w=580,h=248;
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
  const ctx=canvas.getContext('2d');if(!ctx)return;
  ctx.setTransform(2,0,0,2,0,0);ctx.clearRect(0,0,290,124);
  ctx.fillStyle=dark?'#294557':'#d8e5e8';ctx.fill(plate.base,'evenodd');
  ctx.strokeStyle=dark?'#758e9c':'#829ba3';ctx.lineWidth=.52;ctx.stroke(plate.base);
  for(const f of model.features){
    let shape=plate.weather.get(f.geometry);if(!shape){shape=plate.path(f.geometry);plate.weather.set(f.geometry,shape);}
    const color=colors[id]?.[category(id,f)]||(id==='mpd'?'#aa70df':null);if(!color)continue;
    ctx.fillStyle=color;ctx.globalAlpha=id==='mpd'?.68:.93;ctx.fill(shape,'evenodd');ctx.globalAlpha=1;
    ctx.strokeStyle=id==='mpd'?(dark?'#f2dfff':'#642389'):color;ctx.lineWidth=id==='mpd'?1.7:.48;ctx.stroke(shape);
  }
  ctx.strokeStyle=dark?'#adc0c480':'#354d594d';ctx.lineWidth=.35;ctx.stroke(plate.base);
  canvas.dataset.drawn='true';
}
function el(tag,cls,text){const n=document.createElement(tag);n.className=cls;if(text!=null)n.textContent=text;return n;}
export function mountForecastPreviews(container,onOpen){
  let reference=null,pending=false;
  const cards=specs.map(([id,title,period])=>{
    const button=el('button','forecast-preview');button.type='button';button.dataset.forecast=id;
    const head=el('span','forecast-head');head.append(el('strong','',title),el('small','',period));
    const plot=el('span','forecast-plot'), canvas=el('canvas',''), area=el('small','forecast-area','CONUS');
    canvas.setAttribute('aria-hidden','true');plot.append(canvas,area);
    const value=el('strong','forecast-value','Loading product…'),when=el('small','forecast-time','');
    button.append(head,plot,value,when);container.append(button);
    const card={id,canvas,area,value,when,model:null};
    button.onclick=()=>onOpen(id,card.model?.region||'CONUS');return card;
  });
  function redraw(){if(reference)for(const c of cards)if(c.model)paint(c.canvas,c.id,c.model,reference);}
  function fetchBase(){
    if(reference||pending)return;pending=true;
    loadReference().then(g=>{reference=g;redraw();}).catch(()=>{for(const c of cards)c.area.textContent='Boundaries unavailable';}).finally(()=>{pending=false;});
  }
  return {redraw,update(board,now){
    for(const c of cards){
      c.model=previewData(c.id,board,now);
      c.area.textContent=c.model.region==='CONUS'?'CONUS':MAP_REGIONS[c.model.region].label;
      c.value.textContent=c.model.message;c.when.textContent=c.model.time;
      c.value.style.setProperty('--signal',c.model.color||'var(--soft)');
    }
    fetchBase();redraw();
  }};
}
