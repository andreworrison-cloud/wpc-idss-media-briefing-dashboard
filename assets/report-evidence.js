// A public archive identifier can refer to more than one local storm report issued in the same minute.
export const eligibleReport = row => Boolean(row) && row.eligibleForBrief!==false && row?.verificationStatus!=='conflicting' && row?.evidenceStatus!=='ambiguous';

export function reportEvidence(events, observations) {
  const reviewed=new Map(), locations=new Map(), shared=new Set();
  for(const row of [...(observations?.features||[]),...(observations?.unlocated||[]),...Object.values(observations?.leaders||{}).flat()]) {
    if(row?.sourceType==='LSR' && row.id && (row.evidenceStatus || row.verificationNote || row.eligibleForBrief===false))reviewed.set(row.id,row);
  }
  for(const event of events){
    if(!event.source_url)continue;
    const place=[event.city,event.state,event.lat,event.lon].join('|');
    if(locations.has(event.source_url) && locations.get(event.source_url)!==place)shared.add(event.source_url);
    else locations.set(event.source_url,place);
  }
  return event=>{
    const old=reviewed.get(event.id);
    if(old && (!old.revision || old.revision===(event.revision||'original')) && old.office===event.wfo && old.state===event.state && Date.parse(old.observedAt)===Date.parse(event.valid) &&
       (old.value==null ? event.magnitude==null || old.trace : old.value===event.magnitude && old.unit===event.unit)){
      return Object.fromEntries(['url','issuedAt','evidenceStatus','verificationStatus','verificationNote','verificationUrl','eligibleForBrief','preliminary','revision']
        .filter(k=>Object.hasOwn(old,k)).map(k=>[k,old[k]]));
    }
    if(shared.has(event.source_url))return {evidenceStatus:'ambiguous',eligibleForBrief:false,preliminary:true,
      verificationNote:'Several reports share this archive identifier. The original bulletin for this entry has not been matched.',url:null};
    return null;
  };
}
