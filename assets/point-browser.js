import {pointCounts,pointCountLabel,pointKey,pointSources,utc} from './map-points.js?v=20261127';
import {safeURL} from './logic.js';

const pageSize=4;
const sourceNames={NWPS:'National Water Prediction Service',LSR:'Local Storm Report',PNS:'Public Information Statement',FAA:'FAA airport notice'};
const capitalize=text=>text?text[0].toUpperCase()+text.slice(1):'';
const timestamp=p=>Date.parse(p.observedAt||p.issuedAt)||0;

export function newestFirst(points) {
  return [...points].sort((a,b)=>timestamp(b)-timestamp(a)||String(a.place||'').localeCompare(String(b.place||''))||
    (Date.parse(b.issuedAt)||0)-(Date.parse(a.issuedAt)||0)||pointKey(a).localeCompare(pointKey(b)));
}
export function matchingPoints(rows,source,query) {
  const words=query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(p=>{
    if(source&&p.source!==source)return false;
    if(!words.length)return true;
    const text=[p.place,p.county,p.stationId,p.office,p.measure,p.hazard,p.impacts,p.source,p.title].filter(Boolean).join(' ').toLowerCase();
    return words.every(word=>text.includes(word));
  });
}
function titleFor(points) {
  if(points.every(p=>p.source==='NWPS'))return 'Nearby river gauges';
  if(points.every(p=>p.source==='FAA'))return 'Nearby airport notices';
  if(points.every(p=>p.source==='LSR'||p.source==='PNS'))return 'Nearby storm reports';
  return 'Nearby observations';
}
function element(tag,cls,text) {
  const e=document.createElement(tag);
  if(cls)e.className=cls;
  if(text!=null)e.textContent=text;
  return e;
}
function button(action,label,value='') {
  const b=element('button','',label);b.type='button';b.dataset.action=action;b.dataset.value=value;return b;
}
function link(href,label) {
  const url=safeURL(href);if(!url)return null;
  const a=element('a','',label);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;
}
function issueNote(p) {
  return p.verificationNote||(p.record?.eligibleForBrief===false?'Excluded from briefing highlights.':'');
}
function what(p) {
  const q=p.qualifier;
  return [p.value,p.measure||p.title,p.period,q&&!/^(reported|trace)$/i.test(q)?q:''].filter(Boolean).join(' · ');
}
function rowFor(p) {
  const row=button('read','',pointKey(p));row.className='nearby-row';
  const top=element('span','nearby-meta');
  top.append(element('b','nearby-source',[pointSources[p.source]?.badge||p.source,p.office].filter(Boolean).join(' · ')));
  const stamp=utc(p.observedAt)||utc(p.issuedAt);
  if(stamp)top.append(element('span','',(p.observedAt?'':'Issued ')+stamp));
  const place=element('strong','nearby-place',p.place||p.title);
  const observation=element('span','nearby-measure',what(p));
  const cue=element('i','nearby-swatch');cue.style.backgroundColor=p.color||'var(--muted)';cue.setAttribute('aria-hidden','true');
  observation.prepend(cue);row.append(top,place,observation);
  if(issueNote(p))row.append(element('span','nearby-caution','Verification note'));
  return row;
}
function detailFor(p) {
  const box=element('div','nearby-reading');
  const name=element('strong','nearby-place',p.place||p.title);
  const measurement=element('div','nearby-reading-value');
  if(p.value)measurement.append(element('strong','',p.value));
  measurement.append(element('span','',p.measure||p.title));
  measurement.style.setProperty('--reading-color',p.color||'var(--muted)');
  box.append(name,measurement);
  const fields=element('dl','nearby-fields');
  const values=[['Source',[sourceNames[p.source]||p.source,p.office].filter(Boolean).join(' · ')],
    ['Station',p.stationId],['County / parish',p.county],['Observed',utc(p.observedAt)],['Issued',utc(p.issuedAt)],['Period',p.period],
    ['Qualifier',p.qualifier],['Hazard',p.hazard],['Reported impacts',p.impacts],['Notice',p.noticeDetail]];
  for(const [label,value] of values)if(value)fields.append(element('dt','',label),element('dd','',value));
  box.append(fields);const note=issueNote(p);if(note)box.append(element('p','nearby-caution',note));
  const actions=element('div','nearby-actions');
  const original=link(p.url,p.source==='NWPS'?'NWPS gauge page':p.source==='FAA'?'FAA notice':'Original NWS bulletin');
  const evidence=link(p.verificationUrl,'Supporting observation');
  if(original)actions.append(original);if(evidence)actions.append(evidence);
  actions.append(button('locate','Show on map'));box.append(actions);
  return box;
}

export function mountPointBrowser(panel,{pin,fit,restore,clear}) {
  let rows=[],anchor=null,selected='',filter='',query='',page=0,active=false;
  let signature='';
  function rowSignature(points) {
    return JSON.stringify(points.map(p=>[pointKey(p),p.place,p.value,p.measure,p.qualifier,p.period,p.observedAt,p.issuedAt,
      p.office,p.county,p.hazard,p.impacts,p.noticeDetail,p.stationId,p.url,p.verificationUrl,issueNote(p),p.lat,p.lon,p.color]));
  }
  function focusTitle(){panel.querySelector('h3')?.focus({preventScroll:true});}
  function findAction(action,value) {
    return [...panel.querySelectorAll('button[data-action]')].find(b=>b.dataset.action===action&&b.dataset.value===value);
  }
  function renderResults(results) {
    results.replaceChildren();
    const shown=matchingPoints(rows,filter,query);
    page=Math.max(0,Math.min(page,Math.ceil(shown.length/pageSize)-1));
    const offset=page*pageSize,list=element('ol','nearby-rows');list.start=offset+1;
    for(const p of shown.slice(offset,offset+pageSize)){
      const li=element('li');li.append(rowFor(p));list.append(li);
    }
    const bar=element('div','nearby-list-tools');
    const count=element('span','',query.trim()?shown.length+' matching '+(shown.length===1?'entry':'entries')+' · Newest first':'Newest first');
    count.setAttribute('role','status');
    const zoom=button('fit','Zoom to group');zoom.disabled=!shown.length;
    bar.append(count,zoom);results.append(bar,list);
    if(!shown.length)results.append(element('p','nearby-empty','No matching entries. Try another location, office or hazard.'));
    if(shown.length>pageSize){
      const pager=element('nav','nearby-pager');pager.setAttribute('aria-label','Nearby observation pages');
      const prev=button('previous','Previous'),next=button('next','Next');
      prev.disabled=page===0;next.disabled=offset+pageSize>=shown.length;
      const position=element('span','',(offset+1)+'–'+Math.min(shown.length,offset+pageSize)+' of '+shown.length);
      position.setAttribute('role','status');pager.append(prev,position,next);results.append(pager);
    }
  }
  function render() {
    const previous=document.activeElement;
    const held=panel.contains(previous)?{action:previous.dataset.action,value:previous.dataset.value}:null;
    const searching=previous.id==='nearby-search';
    const cursor=searching?[previous.selectionStart,previous.selectionEnd]:null;
    const current=rows.find(p=>pointKey(p)===selected),counts=pointCounts(rows);
    const head=element('header','nearby-head'),intro=element('div');
    const title=element('h3','',current?capitalize(pointSources[current.source]?.one||'Observation'):rows.length?titleFor(rows):'Nearby observations');
    title.id='nearby-title';title.tabIndex=-1;
    const sub=element('p','');
    if(current)sub.textContent=current.source==='NWPS'?'Observed river stage':current.source==='FAA'?'Airport operations':'NWS storm observation';
    else sub.textContent=[...counts].map(([s,n])=>pointCountLabel(s,n)).join(' · ');
    intro.append(title);if(sub.textContent)intro.append(sub);
    const close=button('close','Close');close.setAttribute('aria-label','Close nearby observations');head.append(intro,close);
    panel.replaceChildren(head);
    if(!rows.length){
      panel.append(element('p','nearby-empty','These entries are no longer in the current map data.'));
    }else if(current){
      if(rows.length>1){const back=button('back','Back to list');back.className='nearby-back';panel.append(back);}
      panel.append(detailFor(current));
    }else{
      if(counts.size>1){
        const choices=element('div','nearby-types');choices.setAttribute('role','group');choices.setAttribute('aria-label','Filter these entries by source');
        for(const [id,n] of [['',rows.length],...counts]){
          const b=button('filter',(id||'All')+' ('+n+')',id);b.setAttribute('aria-pressed',String(filter===id));choices.append(b);
        }
        panel.append(choices);
      }
      if(rows.length>pageSize||query){
        const label=element('label','nearby-search','Search this group');
        const input=element('input');input.id='nearby-search';input.type='search';input.autocomplete='off';
        input.placeholder='Location, office or hazard';input.value=query;label.append(input);panel.append(label);
      }
      const results=element('div','nearby-results');panel.append(results);renderResults(results);
    }
    if(searching&&panel.querySelector('#nearby-search')){
      const input=panel.querySelector('#nearby-search');input.focus({preventScroll:true});input.setSelectionRange(...cursor);
    }else if(held){
      const next=findAction(held.action,held.value);
      if(next&&!next.disabled)next.focus({preventScroll:true});else focusTitle();
    }
  }
  function open(points,primary,origin) {
    if(!points.length)return;
    rows=newestFirst(points);anchor={point:primary||rows[0],origin};selected=rows.length===1?pointKey(rows[0]):'';
    filter='';query='';page=0;active=true;signature=rowSignature(rows);panel.hidden=false;render();focusTitle();
    pin(anchor.point,true);
    const frame=panel.previousElementSibling;
    if(frame&&panel.getBoundingClientRect().top>=frame.getBoundingClientRect().bottom-1)panel.scrollIntoView({block:'nearest'});
  }
  function close(returnFocus=false) {
    if(!active)return;
    const last=anchor;active=false;rows=[];anchor=null;selected='';signature='';
    panel.hidden=true;panel.replaceChildren();clear();
    if(returnFocus)restore(last);
  }
  function refresh(points) {
    if(!active||!rows.length)return;
    const available=new Map(points.map(p=>[pointKey(p),p]));
    const next=newestFirst(rows.map(p=>available.get(pointKey(p))).filter(Boolean));
    const nextSignature=rowSignature(next);if(nextSignature===signature)return;
    rows=next;signature=nextSignature;
    const detail=rows.find(p=>pointKey(p)===selected);
    if(!detail)selected='';if(!rows.some(p=>p.source===filter))filter='';
    if(anchor)anchor.point=available.get(pointKey(anchor.point))||rows[0]||anchor.point;
    if(rows.length)pin(detail||anchor.point,false);else clear();
    render();
  }
  panel.addEventListener('click',event=>{
    const b=event.target.closest('button[data-action]');if(!b||!panel.contains(b))return;
    switch(b.dataset.action){
      case 'close':close(true);return;
      case 'filter':filter=b.dataset.value;page=0;render();return;
      case 'previous':page--;render();return;
      case 'next':page++;render();return;
      case 'fit':fit(matchingPoints(rows,filter,query));return;
      case 'locate':fit(rows.filter(p=>pointKey(p)===selected));return;
      case 'read':{
        const p=rows.find(r=>pointKey(r)===b.dataset.value);if(!p)return;
        selected=pointKey(p);pin(p,true);render();focusTitle();return;
      }
      case 'back':{
        const prior=selected;selected='';render();
        findAction('read',prior)?.focus({preventScroll:true});return;
      }
    }
  });
  panel.addEventListener('input',e=>{
    if(e.target.id==='nearby-search'){
      query=e.target.value;page=0;renderResults(panel.querySelector('.nearby-results'));
    }
  });
  panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close(true);}});
  return {open,close,refresh};
}

