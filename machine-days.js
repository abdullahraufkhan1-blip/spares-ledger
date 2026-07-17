#!/usr/bin/env node
// Enter machine days per HD for a DATE RANGE.
// Usage: node machine-days.js 2026-07-01 2026-07-31 HD-1=280000 HD-2=530000 ...
const Database = require('better-sqlite3');
const db = new Database(require('path').join(__dirname, 'inventory.db'));
const [from, to, ...pairs] = process.argv.slice(2);
const D = /^\d{4}-\d{2}-\d{2}$/;
if (!D.test(from||'') || !D.test(to||'') || from > to || pairs.length === 0) {
  console.log('Usage: node machine-days.js YYYY-MM-DD YYYY-MM-DD HD-1=NNNN [HD-2=NNNN ...]');
  process.exit(1);
}
const ov = db.prepare('SELECT date_from, date_to FROM machine_days WHERE hd_code=? AND date_from<=? AND date_to>=?');
const ins = db.prepare('INSERT INTO machine_days (hd_code, date_from, date_to, machine_days) VALUES (?,?,?,?)');
for (const p of pairs) {
  const [hd, v] = p.split('=');
  if (!hd || isNaN(+v)) { console.log('Skipping bad entry:', p); continue; }
  const o = ov.get(hd, to, from);
  if (o) { console.log(`${hd}: overlaps existing ${o.date_from}..${o.date_to} — delete it in the Admin page first.`); continue; }
  ins.run(hd, from, to, +v);
  console.log(`${from}..${to} ${hd} = ${(+v).toLocaleString()}`);
}
console.log('Done.');
