import {eligibleReport} from './report-evidence.js';
// The opening map, Census estimate and local observations share the same selected footprint.
import {activeDay, currentAlerts, moduleState, safeURL} from './logic.js';
import {exposureRecords, recent} from './impact-logic.js';
import {alertStyle, ERO_COLORS} from './hazard-palette.js';
import {availableRows} from './observed-graphics.js';

const HOUR = 3600000;
const supported = status => ['ok', 'partial', 'current'].includes(status);
const during = (start, end, now) => Date.parse(start) <= now && now < Date.parse(end);
const freshLayer = (item, now) => item && supported(item.status) && Date.parse(item.fresh_until) > now;
const polygon = feature => ['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type);
const sameTime = (a, b) => Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);

function choice(record, source, details) {
  const {band = null, ...extra} = details;
  const estimate = band || record;
  return {
    id: record.id + (band ? '-' + band.id : ''), recordId: record.id, bandId: band?.id || null,
    label: record.label, family: record.family, population: estimate.population,
    states: estimate.states || [], asOf: record.as_of, validStart: record.valid_start, validEnd: record.valid_end,
    coverage: record.coverage || '', freshUntil:record.fresh_until, sourceUrl: safeURL(source || record.source_url), geometryComplete: true,
    phase: 'in_effect', ...extra
  };
}

// The order is an editorial opening-view choice. Immediately hazardous warnings and
// active WPC nowcasts take precedence over forecasts; population does not set this order.
function warningPriority(name, emergency) {
  if (emergency) return 0;
  const style = alertStyle(name);
  if (/Tornado Warning|Extreme Wind Warning|Flash Flood Warning|Tsunami Warning|Severe Thunderstorm Warning|Snow Squall Warning|Storm Surge Warning|Hurricane Warning|Typhoon Warning|Blizzard Warning|Ice Storm Warning/i.test(name)) return 5 + style.priority / 100;
  if (/Winter Storm Warning|Lake Effect Snow Warning/i.test(name)) return 20 + style.priority / 100;
  if (/Winter Storm Watch|Hurricane Watch|Storm Surge Watch|Typhoon Watch/i.test(name)) return 40 + style.priority / 100;
  if (/warning/i.test(name)) return 45 + style.priority / 100;
  return 62 + style.priority / 100;
}

function winterWarning(record, layer, now) {
  if (!freshLayer(layer, now)) return null;
  const ids = new Set(record.alert_ids || []);
  const members = (layer.events || []).filter(e => ids.has(e.id) && during(e.effective || e.valid_start, e.valid_end, now));
  const features = (layer.features || []).filter(f => {
    const p = f.properties || {};
    return polygon(f) && ids.has(p.event_id) && p.event === record.label && during(p.effective || p.valid_start, p.valid_end, now);
  });
  const areas = new Map();
  for (const f of features) {
    const p = f.properties;
    if (!areas.has(p.event_id)) areas.set(p.event_id, new Set());
    areas.get(p.event_id).add(p.ugc);
  }
  // A forecast-zone issuance may have several polygons. One polygon for an
  // issuance does not establish complete geographic coverage for that issuance.
  const complete = ids.size > 0 && members.length === ids.size && members.every(e => {
    const zones = areas.get(e.id);
    if (!zones?.size || e.missing_geometry_ugc?.length) return false;
    return Boolean(e.geometry) || (e.ugc || []).length > 0 && e.ugc.every(code => zones.has(code));
  });
  if (!features.length) return null;
  return choice(record, members.length === 1 ? members[0].source_url : layer.source_url, {
    kind:'alert', sourceLabel:'NWS winter alerts', color:alertStyle(record.label).color, features,
    priority:warningPriority(record.label, false), geometryComplete:complete, issuanceCount:ids.size,
    footprintStates:members.every(e=>e.states?.length) ? [...new Set(members.flatMap(e=>e.states))] : null
  });
}

function nationalWarning(record, liveAlerts) {
  const ids = new Set(record.alert_ids || []);
  const members = liveAlerts.filter(a => ids.has(a.id) && a.title === record.label);
  if (!members.length) return null;
  const features = [];
  let complete = members.length === ids.size;
  for (const a of members) {
    const shapes = Array.isArray(a.geometry) ? a.geometry : a.geometry ? [a.geometry] : [];
    const pieces = shapes.map(geometry => ({type:'Feature', geometry, properties:{
      event_id:a.id, event:a.title, area:a.area, source_url:a.source_url, valid_end:a.ends || a.expires
    }})).filter(polygon);
    if (!pieces.length || pieces.length !== shapes.length || /partial|incomplete/i.test(a.geometry_status || '')) complete = false;
    features.push(...pieces);
  }
  if (!features.length) return null;
  return choice(record, members.length === 1 ? members[0].source_url : record.source_url, {
    kind:'alert', sourceLabel:'National Weather Service', features, color:alertStyle(record.label).color,
    geometryComplete:complete, priority:warningPriority(record.label, members.some(a => a.ffe === true)), issuanceCount:ids.size,
    footprintStates:members.every(e=>e.states?.length) ? [...new Set(members.flatMap(e=>e.states))] : null
  });
}

function rainfall(record, board, now) {
  const day = activeDay(board, record.day, now);
  if (!day || !sameTime(record.issued, day.issued) || !sameTime(record.valid_start, day.valid_start) ||
      !sameTime(record.valid_end, day.valid_end)) return null;
  const rank = Math.max(0, ...(day.features || []).map(f => Number(f.properties?.rank) || 0));
  const band = (record.bands || []).find(b => b.rank === rank);
  if (!band || !Number.isFinite(band.population)) return null;
  const areas = day.features.filter(f => f.properties?.rank === rank);
  const features = areas.filter(polygon);
  if (!features.length) return null;
  const upcoming = Date.parse(day.valid_start) > now;
  return choice(record, day.source_url, {
    band, kind:'ero', label:'Day ' + record.day + ' ' + band.label + ' Risk of excessive rainfall',
    day:record.day, sourceLabel:'WPC Excessive Rainfall Outlook', color:ERO_COLORS[band.label],
    features, geometryComplete:features.length === areas.length, phase:upcoming ? 'upcoming' : 'in_effect',
    priority:upcoming ? 80 + record.day - rank/10 : rank >= 3 ? 19-rank : rank === 2 ? 48 : 63
  });
}

function discussion(record, layer, now) {
  if (!freshLayer(layer, now)) return null;
  const features = (layer.features || []).filter(f => {
    const p = f.properties || {};
    return polygon(f) && 'mpd-' + String(p.number ?? '').padStart(4,'0') === record.id &&
      sameTime(p.valid_start, record.valid_start) && sameTime(p.valid_end, record.valid_end) && during(p.valid_start, p.valid_end, now);
  });
  if (!features.length) return null;
  return choice(record, features[0].properties.source_url, {
    kind:'mpd', sourceLabel:'WPC Mesoscale Precipitation Discussion', color:'#661B9E', features, priority:12,
    footprintStates:features.every(f=>f.properties.states?.length) ? [...new Set(features.flatMap(f=>f.properties.states))] : null
  });
}

function winterIndex(record, layer, now) {
  if (!freshLayer(layer,now) || !sameTime(layer.issued,record.issued) ||
      !sameTime(layer.valid_start,record.valid_start) || !sameTime(layer.valid_end,record.valid_end)) return null;
  const features = (layer.features || []).filter(polygon);
  if (!features.length) return null;
  const drawn = new Set(features.map(f => f.properties?.objectid));
  const complete = features.length === layer.features.length && !layer.collapsed_display_rings &&
    (layer.expected_objectids || []).every(id => drawn.has(id));
  return choice(record, layer.source_url, {
    kind:'wssi', label:'Days 1–3 Winter Storm Severity Index', sourceLabel:'WPC Winter Storm Severity Index',
    color:'#596D92', features, geometryComplete:complete, priority:61
  });
}

function collectChoices(board, now) {
  const layers = board?.weather?.winter?.layers || [];
  const winterAlerts = layers.find(l => l.id === 'winter_alerts');
  const wssi = layers.find(l => l.id === 'wssi_d1_3');
  const active = currentAlerts(board, now);
  const records = exposureRecords(board, now).filter(r => !r.isEvent &&
    ['ok','current'].includes(r.status) && Number.isFinite(r.population));
  // Prefer the winter aggregator when it supplies the same alert's authoritative zones.
  const choices = new Map();
  for (const r of records) {
    let option;
    if (r.group === 'winter_alerts') option = winterWarning(r, winterAlerts, now);
    if (r.group === 'alerts') option = nationalWarning(r, active);
    if (r.group === 'mpd') option = discussion(r, board.weather?.mpd, now);
    if (r.group === 'ero') option = rainfall(r, board, now);
    if (r.group === 'winter' && r.map_product === 'wssi_d1_3') option = winterIndex(r, wssi, now);
    if (!option) continue;
    const key = option.kind + ':' + option.label;
    if (!choices.has(key) || option.geometryComplete && (!choices.get(key).geometryComplete || r.group === 'winter_alerts')) choices.set(key,option);
  }
  const ordered = [...choices.values()].sort((a,b) => a.priority-b.priority || a.label.localeCompare(b.label));
  const day = activeDay(board,1,now), mpd = board?.weather?.mpd;
  // An empty menu is affirmative only if the source inventories actually verified no
  // applicable areas. Missing native boundaries or a stale Census calculation are unknown.
  const verifiedInventory = l => ['ok','none','current'].includes(l?.status) && Date.parse(l.fresh_until)>now;
  const unresolvedRain = (board?.sources?.ero?.days || []).some(d=>activeDay(board,d.day,now)?.features?.length);
  const noActive = verifiedInventory(mpd) && mpd.explicit_no_mpd === true && mpd.count === 0 &&
    verifiedInventory(winterAlerts) && winterAlerts.event_count === 0 && day?.no_risk_area === true && !unresolvedRain &&
    moduleState(board,'alerts',now) === 'ok' && !active.some(a => /warning/i.test(a.title) && !/marine/i.test(a.family)) &&
    verifiedInventory(wssi) && wssi.features?.length === 0;
  return {choices:ordered,status:ordered.length ? 'ready' : noActive ? 'none' : 'unavailable'};
}

// Unwrap each ring into a continuous longitude range before testing. An Alaska
// polygon that crosses ±180° must not also select points near Greenwich.
function indexedRing(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 4) return null;
  const points = [];
  let xMin=Infinity, xMax=-Infinity, yMin=Infinity, yMax=-Infinity;
  for (const position of coordinates) {
    if (!Array.isArray(position) || !Number.isFinite(position[0]) || !Number.isFinite(position[1])) return null;
    const [longitude,latitude] = position;
    const last = points.at(-1)?.[0] ?? longitude;
    const x = longitude + 360*Math.round((last-longitude)/360);
    xMin=Math.min(xMin,x); xMax=Math.max(xMax,x);
    yMin=Math.min(yMin,latitude); yMax=Math.max(yMax,latitude);
    points.push([x,latitude]);
  }
  if (points[0][0] !== points.at(-1)[0] || points[0][1] !== points.at(-1)[1]) return null;
  return {points,xMin,xMax,yMin,yMax};
}

function indexAreas(features) {
  const areas=[];
  let complete=true;
  for (const f of features) {
    const g=f.geometry;
    const polygons=g.type==='Polygon' ? [g.coordinates] : g.coordinates || [];
    for (const coordinates of polygons) {
      const rings=Array.isArray(coordinates) ? coordinates.map(indexedRing) : [];
      if (!rings.length || rings.some(r=>!r)) complete=false;
      else areas.push(rings);
    }
  }
  return {areas,complete:complete && areas.length>0};
}

// 0 is outside, 1 inside, 2 on the boundary. Polygon and hole boundaries are covered.
function ringPosition(ring, longitude, latitude) {
  const x=longitude+360*Math.round(((ring.xMin+ring.xMax)/2-longitude)/360);
  if (x<ring.xMin || x>ring.xMax || latitude<ring.yMin || latitude>ring.yMax) return 0;
  let inside=false;
  const points=ring.points;
  for (let i=1;i<points.length;i++) {
    const [a,b]=points[i-1], [c,d]=points[i];
    const cross=(x-a)*(d-b)-(latitude-b)*(c-a);
    if (Math.abs(cross)<1e-10 && x>=Math.min(a,c) && x<=Math.max(a,c) && latitude>=Math.min(b,d) && latitude<=Math.max(b,d)) return 2;
    if ((b>latitude)!==(d>latitude) && x<a+(latitude-b)*(c-a)/(d-b)) inside=!inside;
  }
  return inside ? 1 : 0;
}

function contains(areas, row) {
  if (!Number.isFinite(row.longitude) || !Number.isFinite(row.latitude)) return false;
  return areas.some(([outer,...holes]) => ringPosition(outer,row.longitude,row.latitude)>0 &&
    !holes.some(h => ringPosition(h,row.longitude,row.latitude)===1));
}

const units={snowfall:'in',iceAccretion:'in',rainfall:'in',windGust:'mph',hailDiameter:'in',windChill:'°F',heatIndex:'°F'};
const leadTypes={
  winter:['snowfall','iceAccretion','windGust'], flood:['rainfall'], coastal:['windGust','rainfall'],
  wind:['windGust'], severe:['windGust','hailDiameter','rainfall'], cold:['windChill'], heat:['heatIndex'],
  tropical:['windGust','rainfall']
};

function measured(row, now) {
  const t=Date.parse(row.observedAt);
  return eligibleReport(row) && ['LSR','PNS'].includes(row.sourceType) && Boolean(row.place && safeURL(row.url)) &&
    t<=now && t>=now-48*HOUR && (!row.issuedAt || Date.parse(row.issuedAt)<=now) &&
    units[row.measurementType]===row.unit && !(row.trace || /estimated/i.test(row.qualifier || '')) &&
    Number.isFinite(row.value) && (row.value>0 || ['heatIndex','windChill'].includes(row.measurementType));
}

function leaders(rows, family) {
  // Select only within like measurement types and units. The category order is
  // editorial, so a rain amount is never numerically compared with a wind gust.
  const types=new Set([...(leadTypes[String(family || '').toLowerCase()] || []),...Object.keys(units)]);
  const byType=new Map();
  for (const r of rows) {
    const old=byType.get(r.measurementType);
    const direction=r.measurementType==='windChill' ? -1 : 1;
    if (!old || direction*r.value>direction*old.value ||
        r.value===old.value && Date.parse(r.observedAt)>Date.parse(old.observedAt)) byType.set(r.measurementType,r);
  }
  return [...types].map(type=>byType.get(type)).filter(Boolean).slice(0,4);
}

function observationEvidence(board, selected, now) {
  const obs=board?.weather?.observations;
  const geometry=selected ? indexAreas(selected.features) : {areas:[],complete:false};
  const geometryComplete=Boolean(geometry.complete && selected?.geometryComplete);
  const empty={local:[], national:[], localCount:null, availableLocalCount:0, geometryComplete, windowHours:48};
  if (!obs || !supported(obs.status) || !recent(obs.asOf || obs.checkedAt,now,75))
    return {...empty,status:'unavailable',note:'The 48-hour observation collection is unavailable.'};
  const rows=availableRows(obs,now).filter(r=>measured(r,now));
  const local=rows.filter(r=>contains(geometry.areas,r));
  // Census state totals can omit a state with zero centers inside its polygon.
  // Only a jurisdiction explicitly supplied by the hazard can exclude an unlocated report.
  const states=new Set(selected?.footprintStates || []);
  const missingLocation=rows.some(r=>(!Number.isFinite(r.longitude) || !Number.isFinite(r.latitude)) &&
    (!r.state || !states.size || states.has(r.state)));
  const truncated=obs.counts?.truncated || (obs.counts?.availableLocated ?? 0)>(obs.features?.length ?? 0) ||
    (obs.counts?.availableUnlocated ?? 0)>(obs.unlocated?.length ?? 0);
  const partial=obs.status==='partial' || truncated || Object.values(obs.sources || {}).some(s=>!['ok','current'].includes(s.status));
  const completeCount=geometryComplete && !missingLocation && !partial;
  const notes=[];
  if (!geometryComplete && selected) notes.push('Only available mapped boundaries can be checked.');
  if (missingLocation) notes.push('An observation could not be placed inside or outside this area.');
  if (partial) notes.push('The available report collection is incomplete.');
  notes.push('Preliminary measurements over the preceding 48 hours, matched against the displayed boundaries. Reports may precede issuance. Accumulation periods can differ.');
  return {...empty, status:partial || (selected && !completeCount) ? 'partial' : 'ok',
    local:leaders(local,selected?.family), national:leaders(rows,selected?.family),
    availableLocalCount:local.length, localCount:completeCount ? local.length : null, note:notes.join(' ')};
}

/** Use the current clock for a live view. Historical replays must explicitly supply their reference time.
 * localCount counts qualifying published observation records, before reducing them to one leader per
 * measurement type. An observation can be carried in more than one bulletin. A missing or incomplete
 * geometry, collection, or location yields null, with availableLocalCount preserving known matches.
 */
export function briefingFocus(board, requestedId='', now=Date.now()) {
  const {choices,status}=collectChoices(board,now);
  const selected=choices.find(item=>item.id===requestedId) || choices[0] || null;
  return {status, choices, selected, evidence:observationEvidence(board,selected,now)};
}

// Shared with the exposure worker so resident and observation footprints use identical ring rules.
export {indexAreas, contains};
