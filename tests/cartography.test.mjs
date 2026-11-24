import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import test from 'node:test';

const assets = existsSync(new URL('./hazard-palette.js', import.meta.url)) ?
  new URL('./', import.meta.url) : new URL('../assets/', import.meta.url);
const {WWA, ERO_COLORS, ERO_OUTLINES, WSSI_COLORS, EXTENDED_COLORS, alertStyle, alertDrawOrder, inkFor, appendAlertPath} =
  await import(new URL('hazard-palette.js', assets));
const {OUTAGE_LEGEND, outageBand, loadOutageAtlas, renderOutageOverlay} = await import(new URL('outage-map.js', assets));
const atlas = JSON.parse(readFileSync(new URL('outage-atlas.json', assets), 'utf8'));

function makeGroup() {
  class Element {
    constructor(name) { this.name = name; this.children = []; this.attributes = new Map(); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    hasAttribute(key) { return this.attributes.has(key); }
    getAttribute(key) { return this.attributes.get(key) || null; }
    append(child) { this.children.push(child); }
    replaceChild(child, previous) { this.children.splice(this.children.indexOf(previous), 1, child); }
    get ownerDocument() { return {createElementNS: (_, name) => new Element(name)}; }
  }
  return new Element('g');
}
const overlay = group => group.children.find(it => it.hasAttribute('data-outage-overlay'));
const area = (group, fips) => overlay(group).children.find(el => el.getAttribute('data-power-fips') === fips);

test('all 111 weather.gov rows retain the published name, priority, hex and transparent status', () => {
  const hash = createHash('sha256').update(JSON.stringify(WWA)).digest('hex');
  // Independent extraction of the March 10, 2025 weather.gov HTML table.
  assert.equal(hash, '56888bff89bd48e9fa88afd039ffd07a764f512a4e50046cafdbdf8083a8a4bc');
  assert.equal(alertStyle(' flash flood warning ').color, '#8B0000');
  assert.equal(alertStyle({title: 'Winter Storm Warning'}).color, '#FF69B4');
  assert.equal(alertStyle('Unrecognized Product').known, false);
  assert.equal(alertStyle('Blue Alert').visible, false);
  assert.deepEqual(['Tornado Warning','Flood Warning','Flash Flood Warning'].sort(alertDrawOrder),
    ['Flood Warning','Flash Flood Warning','Tornado Warning']);
});

test('WPC display colors stay product-specific and ERO has its own outline colors', () => {
  assert.deepEqual(Object.values(ERO_COLORS), ['#38A800','#FFFE00','#F50000','#FF69C5']);
  assert.deepEqual(Object.values(ERO_OUTLINES), ['#00734C','#E69800','#8A0000','#FF00FF']);
  assert.deepEqual(Object.values(WSSI_COLORS), ['#D2DFE7','#FAF5A3','#F7962F','#E61F26','#7853A1']);
  assert.equal(Object.keys(EXTENDED_COLORS).length, 15);
  assert.equal(EXTENDED_COLORS['Heavy Rain'], '#267300');
  assert.equal(EXTENDED_COLORS['Heavy Snow'], '#0084A8');
  assert.equal(EXTENDED_COLORS['High Winds'], '#CDAA66');
});

test('dark and light warnings keep their exact foreground edge and a contrasting casing', () => {
  assert.equal(inkFor('#8B0000'), '#FFFFFF');
  assert.equal(inkFor('#FFFE00'), '#000000');
  const group = makeGroup();
  const path = appendAlertPath(group, 'M0,0L2,0L2,2Z', 'Flash Flood Warning');
  assert.equal(group.children[0].getAttribute('stroke'), '#FFFFFF');
  assert.equal(path.getAttribute('stroke'), '#8B0000');
  assert.equal(path.getAttribute('fill'), 'transparent');
  assert.equal(appendAlertPath(group, 'M0,0Z', 'Blue Alert'), null);
});

test('count legend splits zero, missing, and each positive threshold', () => {
  for (const invalid of [null, undefined, NaN, -1, false, '0', 0.2]) assert.equal(outageBand(invalid), OUTAGE_LEGEND[0]);
  for (const [count,index] of [[0,1],[1,2],[99,2],[100,3],[999,3],[1000,4],[9999,4],[10000,5],[99999,5],[100000,6]]) {
    assert.equal(outageBand(count), OUTAGE_LEGEND[index]);
  }
});

test('state and county observations remain independent; stale and missing values hatch', () => {
  const group = makeGroup();
  const background = group.ownerDocument.createElementNS('', 'path');
  group.append(background);
  const source = {states:[{state:'CA', customers_out:412},{fips:'72', customers_out:0, customers_tracked:300},
                          {state:'HI', customers_out:0, coverage_percent:0}],
    counties:[{fips:'06023', customers_out:83},{fips:'11001', customers_out:0}]};
  const states = renderOutageOverlay(group, atlas, source);
  assert.deepEqual([states.reported, states.zero, states.missing], [2,1,54]);
  assert.equal(area(group,'06').getAttribute('data-power-band'),'hundreds');
  assert.equal(area(group,'72').getAttribute('data-power-band'),'zero');
  assert.equal(area(group,'15').getAttribute('data-power-band'),'missing');
  const counties = renderOutageOverlay(group, atlas, source, {level:'county'});
  assert.equal(group.children.length, 2);
  assert.equal(group.children[0], background);
  assert.deepEqual([counties.reported,counties.zero,counties.missing], [2,1,3233]);
  assert.equal(area(group,'06023').getAttribute('data-power-band'),'low');
  assert.equal(area(group,'06001').getAttribute('data-power-band'),'missing');
  assert.match(area(group,'06001').getAttribute('fill'), /^url\(#wpc-power-missing-/);
  assert.equal(area(group,'11001').getAttribute('data-power-band'),'zero');
  assert.match(area(group,'11001').getAttribute('aria-label'), /0 customers reported/);
  assert.equal(renderOutageOverlay(group, atlas, {...source,counties_status:'stale'}, {level:'county'}).reported,0);
  assert.equal(renderOutageOverlay(group, atlas, {...source,status:'unavailable'}).reported,0);
});

test('county matching uses the Connecticut vintage supplied by the source', () => {
  const group = makeGroup();
  const legacy = renderOutageOverlay(group,atlas,{counties:{'09001':10,'09009':1,'99233':8}}, {level:'county'});
  assert.equal(legacy.connecticut,'2021'); assert.equal(legacy.reported,2); assert.deepEqual(legacy.unmatched,['99233']);
  assert.equal(area(group,'09001').getAttribute('data-power-band'), 'low');
  assert.equal(area(group,'09120'),undefined);
  const current = renderOutageOverlay(group,atlas,{counties:new Map([['09120',20]])},{level:'county'});
  assert.equal(current.connecticut,'2025'); assert.equal(current.reported,1); assert.equal(area(group,'09001'),undefined);
  const mixed = renderOutageOverlay(group,atlas,{counties:{'09001':10,'09120':20}},{level:'county'});
  assert.equal(mixed.reported,0);
  assert.deepEqual(mixed.unmatched.sort(),['09001','09120']);
});

test('contradictory duplicate observations stay unknown and unknown FIPS is never assigned to another place', () => {
  const group=makeGroup();
  const source={counties:[{fips:'06023',customers_out:10},{fips:'06023',customers_out:20},
    {fips:'28001',customers_out:1},{fips:'28001',customers_out:1},{fips:'99999',customers_out:42}]};
  const result=renderOutageOverlay(group,atlas,source,{level:'county'});
  assert.equal(result.reported,1);assert.deepEqual(result.unmatched,['99999']);
  assert.equal(area(group,'06023').getAttribute('data-power-band'),'missing');
});

test('the national atlas loads on demand, retries a failed fetch and caches a successful response', async t => {
  const originalFetch=globalThis.fetch; t.after(()=>{globalThis.fetch=originalFetch;});
  let calls=0;
  globalThis.fetch=async()=>++calls===1?{ok:false}:{ok:true,json:async()=>atlas};
  await assert.rejects(loadOutageAtlas(),/could not be loaded/);
  assert.equal(await loadOutageAtlas(),atlas);
  assert.equal(await loadOutageAtlas(),atlas);
  assert.equal(calls,2);
});

test('all domestic state, county and territory features have FIPS IDs, projected geometry and representative points', () => {
  assert.equal(atlas.states.length,56);
  assert.equal(atlas.counties.length,3235);
  assert.equal(atlas.legacyCT.length,8);
  assert.equal(new Set(atlas.counties.map(row=>row[0])).size,3235);
  for (const [fips,name,x,y,rings] of [...atlas.counties,...atlas.legacyCT]) {
    assert.match(fips,/^\d{5}$/); assert.ok(name.length>0); assert.ok(x>=0&&x<=1000&&y>=0&&y<=590);
    assert.ok(rings.length>0&&rings.every(r=>r.length>0&&r.every(i=>!!atlas.arcs[i<0?~i:i])));
  }
  for(const [fips,minimum,maximum] of [['02020',12,257],['15003',266,418],['72127',427,655],
    ['78030',427,655],['66010',664,834],['69110',664,834],['60030',843,988]]) {
    const row=atlas.counties.find(r=>r[0]===fips);
    assert.ok(row[2]>=minimum&&row[2]<=maximum&&row[3]>483);
  }
});
