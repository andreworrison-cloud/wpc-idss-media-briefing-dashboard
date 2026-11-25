import test from 'node:test';
import assert from 'node:assert/strict';
import {timeBins} from '../assets/observed-graphics.js';

test('report time chart uses actual observation times and preserves source counts at both edges',()=>{
  const end=Date.parse('2026-11-25T00:00:00Z');
  const r=(hours,sourceType)=>({sourceType,observedAt:new Date(end-hours*3600000).toISOString()});
  const bins=timeBins([r(48,'LSR'),r(44,'PNS'),r(0,'PNS'),r(50,'LSR'),{sourceType:'PNS',issuedAt:new Date(end).toISOString()}],end,48);
  assert.equal(bins[0].LSR,1);
  assert.equal(bins[1].PNS,1);
  assert.equal(bins.at(-1).rows.length,1);
  assert.equal(bins.flatMap(b=>b.rows).length,3);
});
