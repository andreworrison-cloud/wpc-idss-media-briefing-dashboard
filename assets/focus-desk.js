import {briefingFocus} from './briefing-focus.js';
import {loadReference} from './geographic-base.js';
import {safeURL} from './logic.js';
import {WSSI_COLORS} from './hazard-palette.js';
import {reportAmount, reportPeriod} from './observed-graphics.js';

const byId = id => document.getElementById(id);
const numbers = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', {notation: 'compact', maximumSignificantDigits: 3});
const clock = new Intl.DateTimeFormat('en-GB', {timeZone:'UTC', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hourCycle:'h23'});
const list = new Intl.ListFormat('en-US', {style:'long', type:'conjunction'});
const areaName = {watch:'watch', warning:'warning', advisory:'advisory'};
const words = ['zero','one','two','three','four','five','six','seven','eight','nine','ten'];
const territories = new Set(['AS','DC','GU','MP','PR','VI']);
const reportIcons = new Set(['snow','ice','hail','rain','wind','cold','heat']);

function utc(value) {
  return Number.isFinite(Date.parse(value)) ? clock.format(new Date(value)).replace(',', '')+' UTC' : '';
}
function item(tag, text, className) {
  const el = document.createElement(tag);
  if (text != null) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function sourceLink(url, label) {
  const href = safeURL(url);
  if (!href) return item('span', label);
  const el = item('a', label);
  el.href = href;
  el.target = '_blank';
  el.rel = 'noopener';
  return el;
}
function marker(category) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', '#i-'+(reportIcons.has(category) ? category : 'observe'));
  svg.append(use);
  return svg;
}
function areaLabel(choice) {
  if (choice?.kind === 'ero') return 'risk area';
  if (choice?.kind === 'mpd') return 'discussion area';
  const ending = (choice?.label || '').split(' ').pop().toLowerCase();
  return areaName[ending] ? areaName[ending]+' area' : 'mapped area';
}
function statesWithResidents(choice) {
  return (choice?.states || []).filter(row => typeof row.code === 'string' && Number.isFinite(row.population) && row.population > 0)
    .sort((a,b) => b.population-a.population);
}
function focusHeadline(choice, nameFor) {
  if (!choice) return '';
  const codes = Array.isArray(choice.footprintStates) ? [...new Set(choice.footprintStates)] : [];
  if (!codes.length || choice.geometryComplete === false || choice.kind !== 'alert') return choice.label;
  if (codes.length <= 3) {
    const rank = new Map(statesWithResidents(choice).map((row,i)=>[row.code,i]));
    codes.sort((a,b)=>(rank.get(a)??100)-(rank.get(b)??100));
    return choice.label+' for parts of '+list.format(codes.map(nameFor));
  }
  if (codes.some(c=>territories.has(c))) return choice.label;
  return choice.label+' across parts of '+(words[codes.length] || codes.length)+' states';
}
function estimate(value) {
  if (value < 1e6) return numbers.format(value);
  return new Intl.NumberFormat('en-US', {maximumFractionDigits:2}).format(value/1e6)+' million';
}
function siteLabel(row) { return [row.place,row.state].filter(Boolean).join(', ') || 'Location unspecified'; }
function observationLine(row) {
  const type = (row.label || row.phenomenon || 'measurement').toLowerCase();
  const when = utc(row.observedAt);
  const period = reportPeriod(row);
  const amount = (/estimated/i.test(row.qualifier || '') ? 'estimated ' : '')+reportAmount(row);
  return [amount+' '+type+' at '+siteLabel(row),period,when ? 'observed '+when : '',[row.sourceType,row.office].filter(Boolean).join(' / ')].filter(Boolean).join(' · ');
}

export function mountFocusDesk({onChange, onScopeChange, onLocate, onFit}) {
  const picker = byId('focus-product');
  const scopes = [...document.querySelectorAll('[data-focus-scope]')];
  const stateNames = new Map();
  let snapshot, model, requestedId = '', preferredScope = null, shown = [];
  const nameFor = code => stateNames.get(code) || code;

  function renderPopulation(choice) {
    const holder = byId('focus-population');
    const values = byId('focus-states');
    holder.replaceChildren();
    values.replaceChildren();
    if (!choice) return;
    if (!Number.isFinite(choice.population)) {
      holder.append(item('p','Population estimate unavailable for this footprint.','focus-missing'));
      return;
    }
    const value = item('strong', compact.format(choice.population), 'focus-number');
    value.title = numbers.format(choice.population)+' estimated residents';
    value.setAttribute('aria-label', value.title);
    const description = item('span', 'Estimated residents inside the '+areaLabel(choice), 'focus-unit');
    holder.append(value,description);
    if (choice.geometryComplete === false) holder.append(item('small','Some boundaries for this estimate are missing from the map.','coverage-note'));
    const all = statesWithResidents(choice);
    if (!all.length || choice.population <= 0) return;
    const figure = item('figure',null,'state-evidence');
    const l = item('ol');
    for (const s of all.slice(0,3)) {
      const li = item('li');
      const geography = item('span',nameFor(s.code),'state-place');
      const track = item('span',null,'state-track');
      const bar = item('i');
      bar.style.width = Math.min(100, 100*s.population/choice.population)+'%';
      track.setAttribute('aria-hidden','true');
      track.append(bar);
      const total = item('strong', compact.format(s.population));
      total.title = numbers.format(s.population)+' estimated residents';
      li.append(geography,track,total);
      l.append(li);
    }
    figure.append(item('figcaption', all.length > 3 ? 'Largest state and territory estimates' : 'Residents by state or territory'), l);
    values.append(figure);
  }

  function renderReports() {
    const e = model?.evidence;
    const choice = model?.selected;
    const mode = preferredScope || (choice && e?.local?.length ? 'local' : 'national');
    const local = mode === 'local';
    for (const btn of scopes) {
      btn.disabled = btn.dataset.focusScope === 'local' && !choice;
      btn.setAttribute('aria-pressed',String(btn.dataset.focusScope === mode));
    }
    byId('focus-window').textContent = 'Past '+(e?.windowHours || 48)+' hours';
    byId('focus-evidence-title').textContent = local ? 'Reported in the '+areaLabel(choice) : 'Reported nationwide';
    const note = byId('focus-report-note');
    let message = '';
    if (e?.status === 'unavailable') message = 'Current LSR and PNS measurements are unavailable.';
    else if (choice && !e?.local?.length) {
      if (e?.geometryComplete === false) message = 'Partial hazard boundaries limit the search for local observations.';
      else if (e?.status === 'partial') message = 'No matching local measurement in the available, geolocated reports.';
      else message = 'No measured LSR or PNS report located inside this '+areaLabel(choice)+' in the past 48 hours.';
    } else if (local && e?.geometryComplete === false) message = 'Reports cover the available portion of the hazard area.';
    else if (e?.status === 'partial') message = 'Available measurements cover part of the report inventory or mapped area.';
    note.textContent = message;
    shown = (local ? e?.local : e?.national) || [];
    const glance = byId('focus-glance');
    const top = shown[0];
    glance.textContent = top ? [(local ? 'In area' : 'Nationwide')+' · past 48 h', top.label || top.phenomenon, reportAmount(top), siteLabel(top)].join(' · ') : '';
    const mount = byId('focus-reports');
    mount.replaceChildren();
    for (const [index, row] of shown.slice(0,3).entries()) {
      const article = item('article',null,'focus-reading');
      article.dataset.category = row.category || '';
      const badge = item('span',null,'reading-mark'); badge.append(marker(row.category));
      const qty = item('strong',(/estimated/i.test(row.qualifier || '')?'≈ ':'')+reportAmount(row),'reading-amount');
      const button = item('button',null,'reading-place');
      button.type = 'button'; button.dataset.focusRow = String(index);
      const type = row.label || row.phenomenon || 'Weather report';
      button.append(item('span',type,'reading-type'),item('span',siteLabel(row),'reading-location'));
      button.setAttribute('aria-label','Locate '+observationLine(row));
      const meta = item('div', null, 'reading-meta');
      meta.append(document.createTextNode([utc(row.observedAt),reportPeriod(row)].filter(Boolean).join(' · ')));
      if (meta.textContent) meta.append(document.createTextNode(' · '));
      meta.append(sourceLink(row.url,[row.sourceType,row.office].filter(Boolean).join(' / ') || 'NWS bulletin'));
      article.append(badge,button,qty,meta);
      mount.append(article);
    }
    if (!shown.length && !message) mount.append(item('p', 'No qualifying measurements in this selection.','focus-report-note'));
  }

  function renderSummary() {
    const c = model?.selected;
    const h = byId('focus-headline');
    h.textContent = focusHeadline(c, nameFor) || (model?.status === 'none' ? 'No active hazard in the monitored briefing products' : 'Current hazard briefing unavailable');
    const accent = /^#[0-9a-f]{6}$/i.test(c?.color || '') ? c.color : '#4682b4';
    byId('weather-spread').style.setProperty('--focus-hazard',accent);
    renderPopulation(c);
    const validity=byId('focus-validity');
    const forecast=Boolean(c && (c.kind==='ero' || c.kind==='wssi' || c.kind==='mpd'));
    validity.hidden=!forecast;
    validity.textContent=forecast ? 'Valid '+utc(c.validStart)+' – '+utc(c.validEnd) : '';
    const src = byId('focus-source');
    src.replaceChildren();
    if (c) src.append(sourceLink(c.sourceUrl,c.sourceLabel || 'Official product'));
    const stamp = byId('focus-asof');
    const t = c?.asOf || snapshot?.revision;
    stamp.textContent = utc(t) ? 'As of '+utc(t) : '';
    if (t) stamp.dateTime = t;
    byId('focus-fit').disabled = !c?.features?.length;
    byId('focus-copy').disabled = !c;
    renderReports();
  }

  function update(data) {
    snapshot = data;
    const old = model?.selected?.id;
    model = briefingFocus(data, requestedId);
    if (requestedId && !model.choices.some(c=>c.id===requestedId)) requestedId='';
    if (old !== model.selected?.id) resetActions();
    const opts = model.choices.map(c=>new Option(c.label,c.id));
    picker.replaceChildren(...(opts.length ? opts : [new Option('No current footprint','')]));
    picker.value = model.selected?.id || '';
    picker.disabled = !opts.length;
    renderSummary();
  }

  function resetActions() {
    preferredScope=null;
    byId('focus-feedback').replaceChildren();
  }
  picker.addEventListener('change', () => {
    requestedId=picker.value;
    update(snapshot);
    onChange();
  });
  for (const button of scopes) button.addEventListener('click', () => {
    preferredScope=button.dataset.focusScope;
    renderReports();
    onScopeChange();
  });
  byId('focus-fit').onclick = onFit;
  byId('focus-reports').onclick = (event) => {
    const btn = event.target.closest('button[data-focus-row]');
    if (btn && shown[Number(btn.dataset.focusRow)]) onLocate(shown[Number(btn.dataset.focusRow)]);
  };
  byId('focus-copy').onclick = async () => {
    const c = model?.selected;
    if (!c) return;
    const places=Array.isArray(c.footprintStates) ? [...new Set(c.footprintStates)] : [];
    const where = places.length && places.length <= 3 ? ' in parts of '+list.format(places.map(nameFor)) : '';
    let sentence;
    if (!Number.isFinite(c.population)) sentence = focusHeadline(c,nameFor)+'.';
    else if (c.kind==='alert') {
      const article=/^[aeiou]/i.test(c.label) ? 'an ' : 'a ';
      sentence = 'An estimated '+estimate(c.population)+' residents live in areas under '+article+c.label+where+'.';
    } else {
      sentence = 'An estimated '+estimate(c.population)+' residents live in the area covered by '+c.label+where+'.';
    }
    if (model.evidence?.local?.length) {
      const r=model.evidence.local[0], period=reportPeriod(r);
      const type=(r.label || r.phenomenon || 'weather measurement').toLowerCase();
      const measured=r.measurementType==='windGust' ? 'a wind gust of '+reportAmount(r) : type+' of '+reportAmount(r);
      sentence += ' At '+siteLabel(r)+', NWS '+(r.office||'observers')+' reported '+measured;
      sentence += (period ? ' ('+period+')' : '')+', observed '+utc(r.observedAt)+'.';
    }
    const lines = [sentence, c.asOf ? 'As of '+utc(c.asOf) : '', safeURL(c.sourceUrl), safeURL(model.evidence?.local?.[0]?.url)].filter(Boolean);
    const copy = lines.join('\n');
    const feedback = byId('focus-feedback');
    try {
      await navigator.clipboard.writeText(copy);
      feedback.textContent='Briefing line and sources copied.';
    } catch {
      const field = item('textarea');
      field.readOnly=true;
      field.value=copy;
      field.setAttribute('aria-label','Briefing line to copy');
      feedback.replaceChildren(field);field.focus();field.select();
    }
  };
  loadReference().then(ref=>{
    for (const s of ref.states) stateNames.set(s.code,s.name);
    if (model) renderSummary();
  }).catch(()=>{});

  return {
    update,
    mapContext() {
      const c=model?.selected;
      if (!c?.features?.length) return null;
      return {id:c.id,label:c.label,color:c.color,features:c.features,reports:shown.slice(0,3),
        reportScope:preferredScope || (model.evidence?.local?.length?'local':'national'),
        source_url:c.sourceUrl,valid_start:c.validStart,valid_end:c.validEnd,fresh_until:c.freshUntil};
    },
    syncMapKey(product) {
      const c=model?.selected, key=byId('map-focus-key');
      key.hidden=product!=='radar' || !c?.features?.length;
      key.textContent=key.hidden?'':c.label;
      const wssi=c?.kind==='wssi';
      const colors=Object.values(WSSI_COLORS);
      key.style.setProperty('--focus-swatch',wssi ? 'linear-gradient(to right,'+colors.map((v,i)=>v+' '+(100*i/colors.length)+'% '+(100*(i+1)/colors.length)+'%').join(',')+')' : 'var(--focus-hazard)');
    }
  };
}
