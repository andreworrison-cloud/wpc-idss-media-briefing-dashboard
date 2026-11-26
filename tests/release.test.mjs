import assert from 'node:assert/strict';
import test from 'node:test';
import {readRelease} from '../assets/release.js';
const now=Date.parse('2026-11-24T23:00:00Z');
const board=delta=>({schema:1,revision:new Date(now-delta*60000).toISOString(),sources:{},health:{},impacts:{},weather:{radar:{},mpd:{},winter:{},observations:{}}});
const response=body=>body?Response.json(body):new Response('Missing',{status:404});
test('the static branch reads the current data from its own public repository',async()=>{
 const calls=[];const b=await readRelease('board',async url=>{calls.push(url);return response(url.startsWith('./')?null:board(0));},now);
 assert.equal(b.revision,board(0).revision);assert.match(calls[1],/andreworrison-cloud\/wpc-idss-media-briefing-dashboard\/idss-public-current\//);
});
test('the artifact uses one request when fresh and preserves a later verified local copy',async()=>{
 let calls=0;await readRelease('board',async()=>{calls++;return response(board(1))},now);assert.equal(calls,1);
 const b=await readRelease('board',async url=>response(board(url.startsWith('./')?15:20)),now);assert.equal(b.revision,board(15).revision);
});

test('first paint receives the complete saved board before a late GitHub pointer responds',async()=>{
 const local=board(20),newer=board(1);
 let finish,seen;
 const pointer=new Promise(resolve=>{finish=resolve;});
 const work=readRelease('board',async url=>url.startsWith('./')?response(local):pointer,now,{onSaved:value=>{seen=value;}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(seen.revision,local.revision);
 finish(response(newer));
 assert.equal((await work).revision,newer.revision);
});
