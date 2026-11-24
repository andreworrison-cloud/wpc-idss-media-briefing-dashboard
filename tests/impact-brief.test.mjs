import assert from 'node:assert/strict';
import test from 'node:test';
import {addImpactEvidence, exposureRecords, residentCount, activeAirEvents} from '../site/assets/impact-logic.js';
const now=Date.parse('2026-11-24T23:00:00Z'), time=(m)=>new Date(now+m*60000).toISOString();
const record={id:'ero-d2',label:'Day 2 excessive rainfall',family:'Flood',status:'current',valid_end:time(100),fresh_until:time(30),population:1000,states:[{code:'FL',population:800},{code:'CA',population:200}],bands:[{id:'slight',label:'Slight',population:300,states:[{code:'FL',population:300}]}]};
const board={impacts:{exposure:{calculated_at:time(0),groups:{ero:[record]}},power:{status:'current',as_of:time(0),customers_out:7000,states_status:'current',states_as_of:time(0),states:[{state:'FL',name:'Florida',customers_out:50}]},aviation:{status:'ok',as_of:time(0),event_count:1,events:[{state:'CA',airport:'LAX',airport_name:'Los Angeles',kind:'departure_delay',label:'Departure delay',delay:'30 minutes'}]}}};
const make=(scope,at=now)=>addImpactEvidence(board,{states:[],wfos:[],family:'',...scope},at,()=>'',v=>v);
test('scoped brief cites only local accounts and the selected category',()=>{
 const result=make({states:['FL'],exposure_id:'ero-d2',band_id:'slight'});
 assert.match(result.lines.join(' '),/50 electric customer accounts/);assert.doesNotMatch(result.lines.join(' '),/7,000|Los Angeles/);
 assert.match(result.exposureLines.join(' '),/300 residents in FL/);
 assert.doesNotMatch(result.exposureLines.join(' '),/1,000/);
});
test('office-only and hazard-specific briefs preserve spatial and attribution limits',()=>{
 assert.deepEqual(make({wfos:['MFL']}),{lines:[],exposureLines:[]});
 assert.equal(make({states:['FL'],family:'flood'}).lines.length,0);
 assert.equal(residentCount({...record,status:'partial'},['AK']),null);
});
test('expired geometry and stale aviation are suppressed',()=>{
 assert.equal(exposureRecords(board,now+31*60000).length,0);
 assert.equal(activeAirEvents(board.impacts.aviation,now+31*60000).length,0);
});
