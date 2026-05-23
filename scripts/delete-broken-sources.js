// Delete two RSS sources that no longer return parseable feeds.
//
//   id=39  feedblitz Fortinet     -> Fortinet retired all RSS endpoints
//   id=55  BleepingComputer       -> Cloudflare 403 (interactive-only)
//
// These were producing repeated "Unexpected close tag" and HTTP 403 errors in
// the ingest job, and the error classifier was bubbling them into the UI as
// generic "auth" failures. Removing them silences the noise; if either site
// restores a working feed, just re-add the URL from Catalog -> Sources.

const db = require('../db');

const targets = [
  { id: 39, expected_url: 'https://feeds.feedblitz.com/fortinet/blog/threat-research' },
  { id: 55, expected_url: 'https://www.bleepingcomputer.com/feed/' },
];

for (const t of targets) {
  const row = db.prepare("SELECT id, url, label, kind FROM sources WHERE id=?").get(t.id);
  if (!row) { console.log(`  id=${t.id}: not found, skipping`); continue; }
  if (row.url !== t.expected_url) {
    console.log(`  id=${t.id}: URL changed to '${row.url}', skipping for safety`);
    continue;
  }
  // Detach any raw_items that referenced it so the FK doesn't bite.
  const orphan = db.prepare("UPDATE raw_items SET source_id=NULL WHERE source_id=?").run(t.id);
  const del = db.prepare("DELETE FROM sources WHERE id=?").run(t.id);
  console.log(`  id=${t.id}  ${row.label || '(no label)'}  ->  deleted (${del.changes} source, ${orphan.changes} raw_items detached)`);
}

console.log('\nRemaining sources by kind:');
console.table(db.prepare("SELECT kind, COUNT(*) n FROM sources GROUP BY kind ORDER BY kind").all());
