const db = require('../db');

// Per-day import counts using first_seen + last_seen
console.log('=== rows per first_seen day (last 14) ===');
console.table(db.prepare(`SELECT substr(first_seen,1,10) d, COUNT(*) n FROM spoc_entries GROUP BY d ORDER BY d DESC LIMIT 14`).all());

console.log('\n=== rows per last_seen day (last 14) ===');
console.table(db.prepare(`SELECT substr(last_seen,1,10) d, COUNT(*) n FROM spoc_entries GROUP BY d ORDER BY d DESC LIMIT 14`).all());

console.log('\n=== source files seen (last 14) ===');
console.table(db.prepare(`SELECT source_file, COUNT(*) n, MIN(first_seen) first, MAX(last_seen) last FROM spoc_entries GROUP BY source_file ORDER BY last DESC LIMIT 14`).all());

console.log('\n=== sheets seen ===');
console.table(db.prepare(`SELECT sheet, COUNT(*) n FROM spoc_entries GROUP BY sheet ORDER BY n DESC`).all());

// Field coverage for the latest day's rows
const lastDay = db.prepare(`SELECT substr(first_seen,1,10) d FROM spoc_entries ORDER BY first_seen DESC LIMIT 1`).get();
if (lastDay) {
  const rows = db.prepare(`SELECT data_json FROM spoc_entries WHERE substr(first_seen,1,10)=?`).all(lastDay.d);
  console.log(`\n=== field coverage for ${lastDay.d} (${rows.length} rows) ===`);
  const counts = {};
  for (const r of rows) {
    try {
      const o = JSON.parse(r.data_json || '{}');
      for (const k of Object.keys(o)) {
        if (o[k] != null && String(o[k]).trim() !== '') {
          counts[k] = (counts[k] || 0) + 1;
        }
      }
    } catch (_) {}
  }
  const total = rows.length;
  const arr = Object.entries(counts)
    .map(([k, n]) => ({ field: k, present: n, missing: total - n, pct: Math.round(100*n/total)+'%' }))
    .sort((a, b) => b.present - a.present);
  console.table(arr);
}

// Compare with previous day
const prevDay = db.prepare(`SELECT DISTINCT substr(first_seen,1,10) d FROM spoc_entries ORDER BY d DESC LIMIT 5`).all();
console.log('\n=== distinct import days (latest 5) ===');
console.table(prevDay);

// Also dump the most recent 3 rows fully
console.log('\n=== most recent 3 rows (full JSON) ===');
const rec = db.prepare(`SELECT id, dedup_key, sheet, first_seen, last_seen, data_json FROM spoc_entries ORDER BY first_seen DESC, id DESC LIMIT 3`).all();
for (const r of rec) {
  console.log(`\n--- id=${r.id}  dedup=${r.dedup_key}  sheet=${r.sheet}`);
  console.log(`    first_seen=${r.first_seen}  last_seen=${r.last_seen}`);
  try { console.log('   ', JSON.stringify(JSON.parse(r.data_json), null, 2).split('\n').join('\n    ')); }
  catch { console.log('    (bad json)'); }
}
