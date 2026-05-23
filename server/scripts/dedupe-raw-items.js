// One-shot maintenance: collapse raw_items rows that point to the same
// article. "Same article" = same trimmed-lowercased TITLE (primary), or
// same normalized URL (fallback when title is missing/too-short).
//
// Title-first is essential because publishers mirror the same post under
// different paths (/blog/foo/, /blog-uk/foo-localized/) and feed proxies
// rewrite the host (feeds.feedblitz.com vs feeds.fortinet.com).
//
// Strategy: pick the OLDEST row per group as the keeper (preserves the
// first-seen fetched_at and any analysis_json that was generated for it),
// move foreign-key references over to that id, REWRITE the keeper's hash
// to the new ingest scheme so future polls collide via INSERT OR IGNORE,
// then DELETE the others. Wrapped in a transaction so it's all-or-nothing.
//
// Run with:  node scripts/dedupe-raw-items.js
// Add --dry to preview without writing.
const path = require('path');
const crypto = require('crypto');
const db = require(path.join(__dirname, '..', 'db'));

const DRY = process.argv.includes('--dry');

function normUrl(u) {
  if (!u) return '';
  let s = String(u).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('#')[0].split('?')[0];
  s = s.replace(/\/+$/, '');
  return s;
}
function dedupKey({ url, title }) {
  const t = String(title || '').trim().toLowerCase();
  if (t && t.length > 5) return 't:' + t;
  const u = normUrl(url);
  return u ? 'u:' + u : '';
}
function itemHash(it) {
  const k = dedupKey(it);
  return crypto.createHash('sha1')
    .update(k || crypto.randomBytes(8).toString('hex'))
    .digest('hex').slice(0, 16);
}

const rows = db.prepare('SELECT id, url, title, product_id FROM raw_items').all();
console.log('scanned', rows.length, 'raw_items rows');

// Group by (product_id, dedup-key). We DON'T merge across product_id because
// the same blog post legitimately belongs to multiple competitors in some
// setups. Within one product_id, dupes are always bugs.
const groups = new Map();
for (const r of rows) {
  const k = dedupKey(r);
  if (!k) continue;
  const gk = r.product_id + '\x1f' + k;
  if (!groups.has(gk)) groups.set(gk, []);
  groups.get(gk).push(r);
}

const dupGroups = [...groups.values()].filter(g => g.length > 1);
const totalDelete = dupGroups.reduce((n, g) => n + (g.length - 1), 0);
console.log('duplicate groups:', dupGroups.length, '| rows to delete:', totalDelete);
for (const g of dupGroups.slice(0, 10)) {
  console.log('  ', g.length + 'x', (g[0].title || '').slice(0, 80));
}

// Even when there are no dupes, we still want to rewrite hashes so future
// polls dedupe correctly. Count how many keepers need a hash refresh.
let hashRewrites = 0;
const allRowsWithHash = db.prepare('SELECT id, url, title, hash FROM raw_items').all();
const allKeepers = [];
for (const g of [...groups.values()]) {
  g.sort((a, b) => a.id - b.id);
  allKeepers.push(g[0]);
}
const keeperIds = new Set(allKeepers.map(k => k.id));
for (const r of allRowsWithHash) {
  if (!keeperIds.has(r.id)) continue;
  const want = itemHash({ url: r.url, title: r.title });
  if (r.hash !== want) hashRewrites += 1;
}
console.log('keepers needing hash rewrite:', hashRewrites, '/', keeperIds.size);

if (DRY) { console.log('\n--dry: not writing.'); process.exit(0); }
if (!totalDelete && !hashRewrites) { console.log('nothing to do.'); process.exit(0); }

// FK children of raw_items (analyses, etc.) — discover at runtime.
const fkChildren = [];
for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
  if (t.name === 'raw_items') continue;
  let fks = [];
  try { fks = db.prepare(`PRAGMA foreign_key_list(${t.name})`).all(); } catch (_) {}
  for (const fk of fks) {
    if (fk.table === 'raw_items') fkChildren.push({ table: t.name, column: fk.from });
  }
}
console.log('FK children of raw_items:', fkChildren);

const updateChildStmts = fkChildren.map(c =>
  db.prepare(`UPDATE OR IGNORE ${c.table} SET ${c.column} = ? WHERE ${c.column} = ?`));
const deleteStmt = db.prepare('DELETE FROM raw_items WHERE id = ?');
const updateHashStmt = db.prepare('UPDATE raw_items SET hash = ? WHERE id = ?');

const tx = db.transaction(() => {
  let kept = 0, deleted = 0, rewrote = 0;
  // 1) Collapse dupes.
  for (const g of dupGroups) {
    g.sort((a, b) => a.id - b.id);
    const keeper = g[0];
    for (const dup of g.slice(1)) {
      for (const s of updateChildStmts) s.run(keeper.id, dup.id);
      deleteStmt.run(dup.id);
      deleted += 1;
    }
    kept += 1;
  }
  // 2) Rewrite every keeper's hash to the new url+title-aware scheme so a
  //    future poll inserting the same article collides via INSERT OR IGNORE.
  //    Two keepers might end up colliding on the same hash (unlikely — would
  //    only happen if they share title+URL but were grouped under different
  //    product_ids on purpose). Use INSERT OR IGNORE pattern: try the update
  //    and on UNIQUE-violation, just skip — the row is already deduped.
  const allKeepersFresh = db.prepare('SELECT id, url, title, hash FROM raw_items').all();
  for (const r of allKeepersFresh) {
    const want = itemHash({ url: r.url, title: r.title });
    if (r.hash === want) continue;
    try { updateHashStmt.run(want, r.id); rewrote += 1; }
    catch (e) {
      if (!/UNIQUE/i.test(e.message)) throw e;
      // Hash already exists on another row — that means another keeper
      // already owns the canonical hash for this article. Delete this one
      // (its FK children, if any, would have already been merged in step 1).
      for (const s of updateChildStmts) {
        // Find the canonical row that owns this hash, point children there.
        const winner = db.prepare('SELECT id FROM raw_items WHERE hash=?').get(want);
        if (winner) s.run(winner.id, r.id);
      }
      deleteStmt.run(r.id);
      deleted += 1;
    }
  }
  return { groups: kept, deleted, hashRewrites: rewrote };
});

const res = tx();
console.log('done:', res);
process.exit(0);
