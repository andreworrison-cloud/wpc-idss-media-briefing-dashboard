// Convert only reviewed fields from the public archive. Bulletin bodies are never retained here.
const HOUR=3600000, stamp=t=>new Date(t).toISOString();
const bulletin=/^https:\/\/mesonet\.agron\.iastate\.edu\/api\/1\/nwstext\/(\d{12})-[A-Z0-9]{4}-[A-Z0-9]{6}-LSR[A-Z0-9]{2,3}(?:-[A-Z0-9]{3})?$/;
const abbreviations='AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI AS GU MP UM'.split(' ');
const jurisdictions=new Set(abbreviations);
const effects=new Set('tornado|flash flood|flood|coastal flood|lakeshore flooding|landslide|debris flow|avalanche|storm surge|thunderstorm wind damage|non-thunderstorm wind damage|high surf|rip currents|ice storm|blizzard|snow squall|extreme cold|excessive heat|heat|tropical cyclone|wildfire|downburst|dust storm|blowing dust|dense fog|fog|other local storm report|waterspout|funnel cloud|landspout|marine high winds|tsunami|lightning|seiche|sneaker wave'.split('|'));
const types={
  snow:['snow','snowfall','Snowfall','in'], 'heavy snow':['snow','snowfall','Snowfall','in'], sleet:['snow','sleet','Sleet accumulation','in'],
  'freezing rain':['ice','iceAccretion','Ice accretion','in'], rainfall:['rain','rainfall','Rainfall','in'], 'heavy rainfall':['rain','rainfall','Rainfall','in'],
  'thunderstorm wind gust':['wind','windGust','Wind gust','mph'], 'non-thunderstorm wind gust':['wind','windGust','Wind gust','mph'],
  'marine thunderstorm wind':['wind','windSpeed','Wind speed','mph'], 'high winds over water':['wind','windSpeed','Wind speed','mph'],
  'high sustained winds':['wind','sustainedWind','Sustained wind','mph'], hail:['hail','hailDiameter','Hail diameter','in'],
  'wind chill':['cold','windChill','Wind chill','°F'], 'heat index':['heat','heatIndex','Heat index','°F']
};
const allowedFlags=new Set(['Road closure reported','Rescue reported','Stranded vehicles reported','Structural damage reported','Marine observation','Burn scar mentioned in report']);
function publicPlace(value) {
  if(typeof value!=='string')return null;
  const s=value.trim().replace(/\s+/g,' ');
  if(!s||s.length>75||!/^([\p{L}\p{N}_ .,'’()/&-]+)$/u.test(s)||/https?|www\.|@|\b(?:phone|mobile number|cell number|private residence|backyard|my house)\b|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/i.test(s)||/^\d{1,6}\s+(?![NSEW]{1,3}\s|miles?\s)/i.test(s))return null;
  return s;
}
const groundLabels={rescue:'Rescue reported',structuralDamage:'Structural damage reported',strandedVehicle:'Stranded vehicles reported',roadClosure:'Road closure reported'};
const leaderTypes={snow:'snowfall',ice:'iceAccretion',rain:'rainfall',wind:'windGust',hail:'hailDiameter',cold:'windChill',heat:'heatIndex'};
const latest=(rows,k)=>rows.reduce((best,r)=>Date.parse(r[k])>Date.parse(best||'1970-01-01')?r[k]:best,null);

function coordinates(row) {
  const {lat,lon,state}=row;
  const bounds={AT:[17,51,-83,-60],AK:[50,73,-180,-128],HI:[18,30,-180,-154],PR:[17,19.5,-68.5,-65],VI:[17,19.5,-65.5,-64],GU:[12,15,143,146],MP:[13,22,143,147],AS:[-16,-10,-173,-167]};
  const [s,n,w,e]=bounds[state]||[23,51,-130,-60];
  return Number.isFinite(lat)&&Number.isFinite(lon)&&s<=lat&&lat<=n&&((w<=lon&&lon<=e)||(state==='AK'&&lon>=170&&lon<=180))?[lat,lon]:[null,null];
}
function archiveRows(source, now) {
  const cutoff=Date.parse(source?.window_end), start=Date.parse(source?.window_start);
  if (!['ok','partial'].includes(source?.status)||!Array.isArray(source.events)||!Number.isFinite(start)||!(start<=cutoff&&cutoff<=now+120000&&now-cutoff<45*60000)) return null;
  let partial=source.status!=='ok'||source.query_complete!==true||source.count!==source.events.length||start>cutoff-48*HOUR;
  const rows=new Map();
  for(const item of source.events) {
    const issued=Date.parse(item?.issued),observed=Date.parse(item?.valid);
    if(!Number.isFinite(issued)||!Number.isFinite(observed)) {partial=true;continue;}
    if(observed<cutoff-48*HOUR||observed>cutoff||issued>cutoff||item.revision==='withdrawal')continue;
    const id=bulletin.exec(item.source_url)?.[1];
    if(!id||id!==stamp(issued).replace(/[-:T]/g,'').slice(0,12)||!item.id||(!jurisdictions.has(item.state)&&item.state!=='AT')||
      item.revision_match==='unmatched'||observed>issued||rows.has(item.id)) {partial=true;continue;}
    rows.set(item.id,item);
  }
  return {rows:[...rows.values()],cutoff,partial};
}
function observations(old,source,rows,cutoff,partial) {
  const asOf=source.window_end,windowStart=stamp(cutoff-48*HOUR),lsr=[];
  for (const r of rows) {
    const name=r.title?.toLowerCase(), spec=types[name];
    if (!spec&&!effects.has(name)) continue;
    const [category,measurementType,label,unit]=spec||['effect','event',r.title,null];
    const confirmedUnit=unit&&r.unit===unit?unit:null, trace=Boolean(r.trace&&confirmedUnit==='in');
    const valid=confirmedUnit&&Number.isFinite(r.magnitude)&&(r.magnitude>=0||unit==='°F'&&r.magnitude>-900);
    const [latitude,longitude]=coordinates(r),county=publicPlace(r.county);
    lsr.push({id:r.id,sourceType:'LSR',category,measurementType,label,phenomenon:r.title,unit:confirmedUnit,value:valid&&!trace?r.magnitude:null,trace,
      ...(r.state==='AT'?{marineArea:'Atlantic waters'}:{}),qualifier:trace?'Trace':['Measured','Estimated'].includes(r.qualifier)?r.qualifier:'Reported',place:publicPlace(r.city)||county||r.state,state:r.state,
      county,office:r.wfo,observedAt:r.valid,issuedAt:r.issued,latitude,longitude,url:r.source_url,
      durationHours:r.accumulation_hours>0?r.accumulation_hours:null,periodLabel:null,impactFlags:Array.isArray(r.impact_flags)?r.impact_flags.filter(f=>allowedFlags.has(f)):[]});
  }
  const pnsSource=old?.sources?.pns;
  const pns=new Map();
  for(const r of [...(old?.features||[]),...(old?.unlocated||[]),...Object.values(old?.leaders||{}).flat()]) {
    if(r?.sourceType==='PNS'&&r.id&&Date.parse(r.observedAt||r.issuedAt)>=cutoff-48*HOUR&&Date.parse(r.issuedAt)<=cutoff) pns.set(r.id,r);
  }
  const all=[...lsr,...pns.values()].sort((a,b)=>Date.parse(b.observedAt||b.issuedAt)-Date.parse(a.observedAt||a.issuedAt));
  const leaders={};
  for (const [cat,type] of Object.entries(leaderTypes)){
    const byPlace=new Map(), coords=new Set();
    const ranked=all.filter(r=>r.measurementType===type&&Number.isFinite(r.value)&&(r.value>0||['cold','heat'].includes(cat)))
      .sort((a,b)=>cat==='cold'?a.value-b.value:b.value-a.value);
    for (const r of ranked) {
      const place=(r.state+' '+r.place).toLowerCase(), pt=Number.isFinite(r.latitude)?r.latitude.toFixed(2)+'/'+r.longitude.toFixed(2):null;
      if (byPlace.has(place)||pt&&coords.has(pt))continue;
      byPlace.set(place,r);if(pt)coords.add(pt);if(byPlace.size===5)break;
    }
    leaders[cat]=[...byPlace.values()];
  }
  const located=all.filter(r=>Number.isFinite(r.latitude)), unlocated=all.filter(r=>!Number.isFinite(r.latitude));
  const locatedLSR=lsr.filter(r=>Number.isFinite(r.latitude)).length;
  const liveLSR={status:partial?'partial':'ok',source:'NWS Local Storm Reports via IEM',sourceUrl:source.source_url,asOf,queryEnd:asOf,windowStart,periodHours:48,
    latestIssuedAt:latest(lsr,'issuedAt'),count:partial?null:lsr.length,located:locatedLSR,unlocated:lsr.length-locatedLSR};
  return {...old,status:'partial',checkedAt:source.retrieved_at,asOf,windowStart,periodHours:48,
    sources:{lsr:liveLSR,pns:{...pnsSource,status:!pnsSource?.asOf?'unavailable':cutoff-Date.parse(pnsSource.asOf)>75*60000?'stale':'partial'}},features:located.slice(0,1000),unlocated:unlocated.slice(0,250),
    counts:{located:null,unlocated:null,availableLocated:located.length,availableUnlocated:unlocated.length,locatedLimit:1000,unlocatedLimit:250},
    leaders,leaderStatus:Object.fromEntries(Object.entries(leaders).map(([k,v])=>[k,v.length?'partial':'unknown'])),
    notes:[...(old?.notes||[]).filter(s=>!s.startsWith('The LSR archive')), 'The LSR archive has a newer cutoff. Available PNS measurements retain their original observation and bulletin times.']};
}
function groundReports(old,source,rows,cutoff,partial) {
  const supported=Object.keys(groundLabels).filter(k=>(source.impact_flag_types||[]).includes(groundLabels[k]));
  const counts=Object.fromEntries(Object.keys(groundLabels).map(k=>[k,supported.includes(k)?0:null])), items=[];
  for(const r of rows) {
    if(Date.parse(r.valid)<cutoff-24*HOUR)continue;
    const categories=Object.keys(groundLabels).filter(k=>(r.impact_flags||[]).includes(groundLabels[k]));
    if(!categories.length)continue;
    if(!jurisdictions.has(r.state)){partial=true;continue;}
    for(const k of categories)counts[k]=(counts[k]||0)+1;
    const [latitude,longitude]=coordinates(r), hazard=r.title||'Local storm report';
    items.push({id:r.id,title:categories.map(k=>groundLabels[k]).join(' · '),location:r.city||r.county||r.state,county:r.county,state:r.state,
      latitude,longitude,observedAt:r.valid,reportedAt:r.issued,categories,hazard,office:r.wfo,preliminary:true,detail:hazard+'. Preliminary NWS local storm report.',url:r.source_url});
  }
  const priority=r=>Math.min(...r.categories.map(k=>Object.keys(groundLabels).indexOf(k)));
  items.sort((a,b)=>priority(a)-priority(b)||Date.parse(b.observedAt)-Date.parse(a.observedAt));
  return {...old,status:partial?'partial':'ok',source:'Preliminary NWS Local Storm Reports via Iowa Environmental Mesonet',sourceUrl:source.source_url,periodHours:24,
    asOf:source.window_end,windowStart:stamp(cutoff-24*HOUR),latestIssuedAt:latest(items,'reportedAt'),total:partial?null:items.length,
    counts:partial?Object.fromEntries(Object.keys(counts).map(k=>[k,null])):counts,availableCount:items.length,availableCounts:counts,supportedCategories:supported,
    items:items.slice(0,60),displayLimit:60,summary:items.length+' available preliminary ground-impact reports in the 24 hours through the archive cutoff.'};
}
export function recoverReports(board,now) {
  const source=board.sources?.reports, archive=archiveRows(source,now);
  if (!archive||board.health?.reports?.retained||board.attempts?.reports?.retained) return board;
  const {rows,cutoff}=archive;
  const partial=archive.partial||!['ok','current'].includes(board.health?.reports?.status||source.status);
  const weather=board.weather||{}, impacts=board.impacts||{}, ground=impacts.ground||{};
  const oldWeather=weather.observations, oldGround=ground.reports;
  const newer=(prior)=>!prior||cutoff>Date.parse(prior.asOf||'1970-01-01');
  return {...board,weather:{...weather,observations:newer(oldWeather)?observations(oldWeather,source,rows,cutoff,partial):oldWeather},
    impacts:{...impacts,ground:{...ground,reports:newer(oldGround)?groundReports(oldGround,source,rows,cutoff,partial):oldGround}}};
}

const riverService='https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer/0';
const levels=['major','moderate','minor'];
function observationTime(t) {
  if (typeof t==='number') return t;
  if (typeof t!=='string' || !/^\d{4}-\d{2}-\d{2}[ T]/.test(t)) return NaN;
  return Date.parse(t.replace(' ','T')+(/Z|[+-]\d{2}:?\d{2}$/.test(t)?'':'Z'));
}
export async function recoverRivers(old, read, now) {
  const where='state IN ('+abbreviations.map(s=>"'"+s+"'").join(',')+')';
  const request=opts=>read(riverService+'/query?'+new URLSearchParams({f:'json',returnGeometry:'false',...opts}),2000000);
  const statistics=[['min','idp_filedate','file_min'],['max','idp_filedate','file_max'],['max','obstime','last_observation'],['count','objectid','site_count']].map(([statisticType,onStatisticField,outStatisticFieldName])=>({statisticType,onStatisticField,outStatisticFieldName}));
  const [a,b]=await Promise.all([request({where,groupByFieldsForStatistics:'status',outStatistics:JSON.stringify(statistics)}),
    request({where:where+" AND status IN ('major','moderate','minor')",outFields:'gaugelid,status,location,waterbody,state,obstime,observed,units,latitude,longitude,idp_filedate',orderByFields:'objectid ASC'})]);
  if(a?.error||b?.error||!Array.isArray(a?.features)||!a.features.length||!Array.isArray(b?.features)) return old;
  const stats=a.features.map(x=>x.attributes), expected=new Map(), clocks=new Set(),network=[];
  let partial=Boolean(a.exceededTransferLimit||b.exceededTransferLimit);
  for(const r of stats) {
    if(!r?.status||expected.has(r.status)||!Number.isInteger(r.site_count)||r.site_count<1||!Number.isFinite(r.file_min)||!Number.isFinite(r.file_max))return old;
    expected.set(r.status,r.site_count);clocks.add(r.file_min);clocks.add(r.file_max);
    const t=observationTime(r.last_observation);
    if([...levels,'action','no_flooding','low_threshold'].includes(r.status)&&t<=now)network.push(t);
  }
  const asOf=Math.max(...clocks), newest=Math.max(...network);
  if(!(asOf<=now&&now-asOf<=2*HOUR&&now-newest<=6*HOUR)||asOf<Date.parse(old?.asOf))return old;
  partial ||= clocks.size!==1;
  const available=Object.fromEntries(levels.map(l=>[l,0])), raw={...available}, ids=new Map(), conflicts=new Set(), older=new Set();
  let excludedOld=0;
  for(const {attributes:r} of b.features) {
    if(!r||!levels.includes(r.status)||!jurisdictions.has(r.state)){partial=true;continue;}
    raw[r.status]++;
    const t=observationTime(r.obstime), id=String(r.gaugelid||'').toUpperCase();
    if(!/^[A-Z0-9]{3,5}$/.test(id)||!Number.isFinite(t)||t>asOf||r.idp_filedate!==asOf){partial=true;continue;}
    if(now-t>6*HOUR){excludedOld++;if(ids.has(id)||older.has(id)){partial=true;conflicts.add(id);ids.delete(id);}older.add(id);continue;}
    if(older.has(id)||conflicts.has(id)){partial=true;conflicts.add(id);ids.delete(id);continue;}
    const coordinate=r.latitude!=null&&r.longitude!=null?coordinates({lat:Number(r.latitude),lon:Number(r.longitude),state:r.state}):[null,null];
    const hasValue=r.observed!=null&&Number.isFinite(Number(r.observed))&&Number(r.observed)>-900&&typeof r.units==='string'&&/^[A-Za-z0-9 /³°.-]{1,8}$/.test(r.units);
    const value=hasValue?Number(r.observed):null,unit=hasValue?r.units:null;
    const site={id,name:r.location&&r.waterbody&&r.location!==r.waterbody?r.waterbody+' · '+r.location:r.waterbody||r.location||id,waterbody:r.waterbody||null,location:r.location||null,type:'observed',state:r.state,
      latitude:coordinate[0],longitude:coordinate[1],category:r.status,observedAt:stamp(t),value,unit,url:'https://water.noaa.gov/gauges/'+id.toLowerCase()};
    if(ids.has(id)){partial=true;if(JSON.stringify(ids.get(id))!==JSON.stringify(site)){conflicts.add(id);ids.delete(id);continue;}}
    ids.set(id,site);
  }
  if(levels.some(l=>(expected.get(l)||0)!==raw[l]))partial=true;
  const ranked=[...ids.values()].sort((a,b)=>levels.indexOf(a.category)-levels.indexOf(b.category)||Date.parse(b.observedAt)-Date.parse(a.observedAt));
  for(const s of ranked)available[s.category]++;
  return {...old,source:'NOAA National Water Prediction Service',sourceUrl:'https://water.noaa.gov/',dataUrl:riverService,
    status:partial?'partial':'ok',asOf:stamp(asOf),latestNetworkObservedAt:stamp(newest),periodHours:6,total:partial?null:ranked.length,
    counts:partial?{major:null,moderate:null,minor:null}:available,availableCount:ranked.length,availableCounts:available,excludedOld,
    sites:ranked.slice(0,100),displayLimit:100,summary:ranked.length+' available U.S. gauges reported minor or higher flooding within six hours.'};
}
