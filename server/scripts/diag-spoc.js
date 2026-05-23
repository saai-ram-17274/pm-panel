const db = require('../db');

// Schema first
const cols = db.prepare("PRAGMA table_info(spoc_entries)").all();
console.log('=== spoc_entries columns ===');
console.table(cols.map(c => ({ name: c.name, type: c.type })));

// Pick a timestamp column we can group on.
const tsCol = cols.find(c => /imported|created|ingested|inserted/i.test(c.name))?.name
           || cols.find(c => /time|date/i.test(c.name))?.name
           || null;
console.log('\nGroup column:', tsCol);

if (tsCol) {
  const rows = db.prepare(`SELECT date(${tsCol}) d, COUNT(*) n FROM spoc_entries GROUP BY date(${tsCol}) ORDER BY d DESC LIMIT 10`).all();
  console.log('\n=== rows per day ===');
  console.table(rows);
}

// Last 5 rows ordered by rowid
const recent = db.prepare("SELECT * FROM spoc_entries ORDER BY rowid DESC LIMIT 5").all();
console.log('\n=== last 5 rows ===');
for (const r of recent) {
  console.log('---');
  for (const k of Object.keys(r)) {
    const v = r[k];
    const s = v == null ? '<null>' : (typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : v);
    console.log(`  ${k}: ${s}`);
  }
}

// Count null fields in last 24h
if (tsCol) {
  const recent24 = db.prepare(`SELECT * FROM spoc_entries WHERE ${tsCol} >= datetime('now','-2 days') ORDER BY rowid DESC`).all();
  console.log(`\n=== null/empty field counts in last 2 days (${recent24.length} rows) ===`);
  if (recent24.length) {
    const nullCounts = {};
    for (const r of recent24) {
      for (const k of Object.keys(r)) {
        if (r[k] == null || r[k] === '') nullCounts[k] = (nullCounts[k] || 0) + 1;
      }
    }
    console.table(Object.entries(nullCounts).map(([f, n]) => ({ field: f, empty: n, pct: Math.round(100*n/recent24.length)+'%' })));
  }
}
