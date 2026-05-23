// Look for raw_items dated in the future relative to "now".
const db = require('../db');

const now = new Date().toISOString();
console.log('Now:', now);

const rows = db.prepare(`
  SELECT r.id, r.title, r.url, r.published_at, r.source_id,
         s.url AS source_url, s.kind AS source_kind, s.label AS source_label,
         p.name AS product, p.kind AS prod_kind
  FROM raw_items r
  LEFT JOIN sources  s ON s.id = r.source_id
  LEFT JOIN products p ON p.id = r.product_id
  WHERE r.published_at IS NOT NULL
    AND r.published_at > datetime('now')
  ORDER BY r.published_at DESC
  LIMIT 50
`).all();

console.log(`\nFound ${rows.length} future-dated items:\n`);
for (const r of rows) {
  console.log(`  id=${r.id}  pub=${r.published_at}`);
  console.log(`    title:    ${(r.title || '').slice(0, 100)}`);
  console.log(`    product:  ${r.product || '(?)'} (${r.prod_kind || '?'})`);
  console.log(`    source:   ${r.source_label || '-'}  [${r.source_kind || '?'}]  ${r.source_url || ''}`);
  console.log(`    url:      ${r.url}`);
  console.log('');
}
