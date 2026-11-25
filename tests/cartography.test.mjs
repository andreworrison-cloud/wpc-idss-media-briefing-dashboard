import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import test from 'node:test';

const assets = existsSync(new URL('./hazard-palette.js', import.meta.url)) ?
  new URL('./', import.meta.url) : new URL('../assets/', import.meta.url);
const {WWA, ERO_COLORS, ERO_OUTLINES, WSSI_COLORS, EXTENDED_COLORS, alertStyle, alertDrawOrder, inkFor, appendAlertPath} =
  await import(new URL('hazard-palette.js', assets));
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
