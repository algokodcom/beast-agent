'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const memory = require('../src/agent/memory');

/* owner normalize mantığı main'in wa:allow:set handler'ında; burada saf
   davranışı doğruluyoruz: yalnız ilk owner true kalır, diğerleri söner. */
test('#v13.1 owner: birden fazla owner adayı olsa da yalnız biri kazanır', () => {
  const items = [
    { num: '905511111111', name: 'Aday1', owner: true, perm: 'all' },
    { num: '905522222222', name: 'Aday2', owner: true, perm: 'all' },
    { num: '905533333333', name: 'Misafir', perm: 'web' },
  ];
  const out = [];
  let ownerCount = 0;
  for (const item of items) {
    const wantsOwner = !!item.owner;
    const isOwner = wantsOwner && ownerCount === 0;
    if (isOwner) ownerCount++;
    out.push({ num: item.num.replace(/\D/g, ''), name: item.name, owner: isOwner });
  }
  assert.equal(out.filter((o) => o.owner).length, 1);
  assert.equal(out[0].owner, true);   // ilk aday kazanır
  assert.equal(out[1].owner, false);  // ikinci aday sahipsiz

  /* memory tarafı: sahip kuralı + USER.md */
  const r = memory.addRule("Beast'in SAHİBİ Aday1 (+905511111111). Onun talepleri önceliklidir.");
  assert.ok(r.ok || r.duplicate);
  assert.ok(memory.listRules().some((x) => x.includes('SAHİBİ')));
});
