const NS = 'http://www.w3.org/2000/svg';
const number = new Intl.NumberFormat('en-US');
const compiled = new WeakMap();
let defaultAtlas;
let instance = 0;

// These are customer-count intervals for this impact map. NWS hazard colors are defined separately.
export const OUTAGE_LEGEND = Object.freeze([
  {id: 'missing', label: 'No mapped report', color: null},
  {id: 'zero', label: '0 reported', min: 0, color: '#32566B'},
  {id: 'low', label: '1–99', min: 1, color: '#FFF1B2'},
  {id: 'hundreds', label: '100–999', min: 100, color: '#FEC65B'},
  {id: 'thousands', label: '1,000–9,999', min: 1000, color: '#F58A39'},
  {id: 'ten-thousands', label: '10,000–99,999', min: 10000, color: '#C74822'},
  {id: 'hundred-thousands', label: '100,000+', min: 100000, color: '#831F19'}
].map(Object.freeze));

export function outageBand(count) {
  if (!Number.isSafeInteger(count) || count < 0) return OUTAGE_LEGEND[0];
  for (let i = OUTAGE_LEGEND.length - 1; i > 0; i--) {
    if (count >= OUTAGE_LEGEND[i].min) return OUTAGE_LEGEND[i];
  }
}

/** Retry cleanly after a failed request. The main desk need only call this on the power layer. */
export function loadOutageAtlas(url) {
  const read = async target => {
    const response = await fetch(target);
    if (!response.ok) throw new Error('County boundaries could not be loaded');
    const atlas = await response.json();
    if (atlas.schema !== 1 || !Array.isArray(atlas.arcs) || !Array.isArray(atlas.counties) ||
        !Array.isArray(atlas.states) || !Array.isArray(atlas.legacyCT) || atlas.scale !== 100) {
      throw new Error('County boundaries use an unsupported format');
    }
    return atlas;
  };
  if (url) return read(url);
  if (!defaultAtlas) {
    defaultAtlas = read(new URL('./outage-atlas.json', import.meta.url)).catch(error => {
      defaultAtlas = undefined;
      throw error;
    });
  }
  return defaultAtlas;
}

function unpackArc(encoded, scale) {
  let pos = 0;
  function delta() {
    let shift = 0, value = 0, unit;
    do {
      if (pos >= encoded.length || shift > 25) throw new Error('Corrupt county boundary arc');
      unit = encoded.charCodeAt(pos++) - 63;
      if (unit < 0 || unit > 63) throw new Error('Corrupt county boundary arc');
      value |= (unit & 31) << shift;
      shift += 5;
    } while (unit >= 32);
    return value & 1 ? -((value >>> 1) + 1) : value >>> 1;
  }
  const points = [];
  let x = 0, y = 0;
  while (pos < encoded.length) {
    x += delta();
    y += delta();
    points.push((x / scale) + ',' + (y / scale));
  }
  return points;
}

function boundaryModel(atlas) {
  if (compiled.has(atlas)) return compiled.get(atlas);
  const stateCode = new Map(atlas.states.map(([fips, state]) => [fips, state]));
  const states = atlas.states.map(([fips, state, name, x, y, rings]) =>
    ({fips, state, name, center: [x, y], rings}));
  const county = ([fips, name, x, y, rings]) =>
    ({fips, state: stateCode.get(fips.slice(0, 2)), name, center: [x, y], rings});
  const counties = atlas.counties.map(county);
  const legacy = atlas.legacyCT.map(county);
  const modernCT = new Set(counties.filter(row => row.state === 'CT').map(row => row.fips));
  const legacyCodes = new Set(legacy.map(row => row.fips));
  const arcs = [];
  function path(area) {
    if (area.d !== undefined) return area.d;
    area.d = area.rings.map(ring => {
      const coordinates = [];
      for (const index of ring) {
        const id = index < 0 ? ~index : index;
        const arc = arcs[id] || (arcs[id] = unpackArc(atlas.arcs[id], atlas.scale));
        if (index < 0) {
          for (let i = arc.length - (coordinates.length ? 2 : 1); i >= 0; i--) coordinates.push(arc[i]);
        } else {
          for (let i = coordinates.length ? 1 : 0; i < arc.length; i++) coordinates.push(arc[i]);
        }
      }
      if (coordinates[0] === coordinates[coordinates.length - 1]) coordinates.pop();
      return 'M' + coordinates.join('L') + 'Z';
    }).join('');
    return area.d;
  }
  const model = {states, counties, legacy, modernCT, legacyCodes, stateCode, path};
  compiled.set(atlas, model);
  return model;
}

function placeKey(key, level, model) {
  if (key === undefined || key === null) return null;
  const value = String(key).trim().toUpperCase();
  if (level === 'state') {
    if (/^[A-Z]{2}$/.test(value)) return value;
    return /^\d{1,2}$/.test(value) ? model.stateCode.get(value.padStart(2, '0')) || null : null;
  }
  return /^\d{1,5}$/.test(value) ? value.padStart(5, '0') : null;
}

function observations(data, level, model) {
  const field = level === 'state' ? 'states' : 'counties';
  const status = data[field + '_status'];
  const usable = value => !value || ['ok', 'current', 'partial'].includes(value);
  const byId = new Map();
  if (!usable(data.status) || !usable(status)) return byId;
  const raw = data[field] || {};
  const records = Array.isArray(raw) ? raw.map(row => [
    level === 'state' ? row?.state || row?.fips : row?.fips, row
  ]) : raw instanceof Map ? raw.entries() : Object.entries(raw);
  for (const [key, input] of records) {
    const id = placeKey(key, level, model);
    if (!id) continue;
    const row = typeof input === 'number' ? {customers_out: input} : input || {};
    const count = row.customers_out;
    const verified = Number.isSafeInteger(count) && count >= 0 &&
      row.customers_tracked !== 0 && row.coverage_percent !== 0;
    const incoming = {count: verified ? count : null, row};
    const existing = byId.get(id);
    // A contradictory duplicate has no unambiguous count for this polygon.
    if (existing && existing.count !== incoming.count) byId.set(id, {count: null, row: {}});
    else if (!existing) byId.set(id, incoming);
  }
  return byId;
}

function countyEdition(model, byId) {
  const reported = [...byId].filter(([, info]) => info.count !== null);
  const historical = reported.some(([key]) => model.legacyCodes.has(key));
  if (!historical) return {areas: model.counties, connecticut: '2025'};
  const modern = reported.some(([key]) => model.modernCT.has(key));
  if (modern) return {areas: model.counties, connecticut: 'conflicting boundaries'};
  return {
    areas: model.counties.filter(a => a.state !== 'CT').concat(model.legacy),
    connecticut: '2021'
  };
}

function svg(group, name, attrs = {}, content) {
  const element = group.ownerDocument.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  if (content !== undefined) element.textContent = content;
  group.append(element);
  return element;
}

function accessibleSelection(layer, detailByKey, initial, onSelect) {
  if (!initial || typeof onSelect !== 'function') return;
  let current = initial;
  current.setAttribute('tabindex', '0');
  const focus = item => {
    current.setAttribute('tabindex', '-1');
    current = item;
    current.setAttribute('tabindex', '0');
  };
  layer.addEventListener('focusin', event => {
    const path = event.target.closest?.('[data-power-fips]');
    if (path) focus(path);
  });
  layer.addEventListener('click', event => {
    const path = event.target.closest?.('[data-power-fips]');
    if (!path) return;
    event.stopPropagation();
    focus(path);
    onSelect(detailByKey.get(path.getAttribute('data-power-fips')), event);
  });
  layer.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      onSelect(detailByKey.get(current.getAttribute('data-power-fips')), event);
      return;
    }
    const keys = new Set(['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']);
    if (!keys.has(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const areas = layer.querySelectorAll('[data-power-fips]');
    const index = Array.prototype.indexOf.call(areas, current);
    let next = index;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = areas.length - 1;
    else next = (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + areas.length) % areas.length;
    focus(areas[next]);
    current.focus?.();
  });
}

/**
 * Render independently reported customers without power at one resolution.
 * Pass the mounted SVG overlay group, loaded atlas, and a source with states/counties arrays
 * (state or FIPS, customers_out, optional tracking/coverage fields) or keyed count dictionaries.
 * A missing row, an unverified count, and a stale section all use the no-report hatch.
 * No state statistic is distributed among its counties. The returned summary is for display QA.
 */
export function renderOutageOverlay(group, atlas, data = {}, {level = 'state', onSelect} = {}) {
  if (level !== 'state' && level !== 'county') throw new Error('Unknown outage map resolution');
  data = data || {};
  const model = boundaryModel(atlas);
  const byId = observations(data, level, model);
  const {areas, connecticut} = level === 'county' ? countyEdition(model, byId) :
    {areas: model.states, connecticut: null};
  const layer = group.ownerDocument.createElementNS(NS, 'g');
  layer.setAttribute('data-outage-overlay', level);
  layer.setAttribute('role', 'group');
  layer.setAttribute('aria-label', (level === 'county' ? 'County' : 'State') + ' reports of customers without power');
  const defs = svg(layer, 'defs');
  const patternId = 'wpc-power-missing-' + (++instance);
  const hatch = svg(defs, 'pattern', {id: patternId, width: 5, height: 5, patternUnits: 'userSpaceOnUse'});
  svg(hatch, 'rect', {width: 5, height: 5, fill: '#263A50'});
  svg(hatch, 'path', {d: 'M-1,1L1,-1M0,5L5,0M4,6L6,4', fill: 'none', stroke: '#74869A', 'stroke-width': 0.8});
  svg(defs, 'style', {}, '[data-power-fips]:focus-visible { outline: none; stroke: #fff; stroke-width: 2.5px; }');
  const asOf = level === 'county' ? data.counties_as_of : data.states_as_of;
  const unmatched = new Set([...byId].filter(([, info]) => info.count !== null).map(([key]) => key));
  const detailByKey = new Map();
  let first, firstKnown, reported = 0, zero = 0;
  for (const area of areas) {
    const lookup = level === 'county' ? area.fips : area.state;
    const conflict = connecticut === 'conflicting boundaries' && area.state === 'CT';
    const observed = conflict ? null : byId.get(lookup);
    if (!conflict) unmatched.delete(lookup);
    const count = observed?.count ?? null;
    const band = outageBand(count);
    if (count !== null) reported++;
    if (count === 0) zero++;
    const place = level === 'county' ? area.name + ', ' + area.state : area.name;
    const label = place + ' · ' + (count === null ? 'No mapped report' :
      number.format(count) + (count === 1 ? ' customer reported' : ' customers reported') + ' without power');
    const path = svg(layer, 'path', {
      d: model.path(area), fill: band.color || 'url(#' + patternId + ')',
      stroke: level === 'county' ? '#354B5B' : '#A4BCCB', 'stroke-width': level === 'county' ? 0.28 : 0.75,
      'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke', 'fill-rule': 'evenodd',
      'data-power-fips': area.fips, 'data-power-band': band.id, 'aria-label': label,
      role: onSelect ? 'button' : 'img', ...(onSelect ? {tabindex: -1, cursor: 'pointer'} : {})
    });
    svg(path, 'title', {}, label);
    if (!first) first = path;
    if (!firstKnown && count !== null) firstKnown = path;
    if (typeof onSelect === 'function') {
      detailByKey.set(area.fips, {
        level, state: area.state, fips: area.fips, name: area.name, center: area.center, customers_out: count,
        customers_tracked: observed?.row.customers_tracked ?? null,
        coverage_percent: observed?.row.coverage_percent ?? null, as_of: asOf || null, label
      });
    }
  }
  // A state outline separates regions even when neighboring counties have the same color.
  if (level === 'county') {
    svg(layer, 'path', {
      d: model.states.map(model.path).join(''), fill: 'none', stroke: '#ABBFCB', 'stroke-width': 0.64,
      'stroke-linejoin': 'round', 'pointer-events': 'none', 'aria-hidden': 'true', 'vector-effect': 'non-scaling-stroke'
    });
  }
  accessibleSelection(layer, detailByKey, firstKnown || first, onSelect);
  const prior = [...group.children].find(child => child.hasAttribute('data-outage-overlay'));
  if (prior) group.replaceChild(layer, prior);
  else group.append(layer);
  return {level, reported, zero, missing: areas.length - reported, unmatched: [...unmatched], connecticut, as_of: asOf || null};
}
