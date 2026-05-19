// Load .env from this directory before anything else requires process.env
// (mailer.js reads ZOHO_MAIL_* at import time).
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(require('path').join(__dirname, 'public'), {
  // app.jsx is transpiled in-browser by @babel/standalone, so a cached copy
  // means the user runs stale code after a deploy. Serve all .jsx / .html
  // files with no-cache so a normal reload always picks up the latest UI.
  setHeaders: (res, filePath) => {
    if (/\.(jsx|html)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

const PORT = process.env.PORT || 4000;

function crud(resource, table, fields, opts = {}) {
  app.get(`/api/${resource}`, (req, res) => {
    res.json(db.prepare(`SELECT * FROM ${table} ORDER BY ${opts.orderBy || 'id DESC'}`).all());
  });
  app.get(`/api/${resource}/:id`, (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  });
  app.post(`/api/${resource}`, (req, res) => {
    const cols = fields.join(',');
    const placeholders = fields.map(() => '?').join(',');
    const values = fields.map(f => req.body[f] ?? null);
    try {
      const r = db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`).run(...values);
      res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(r.lastInsertRowid));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.put(`/api/${resource}/:id`, (req, res) => {
    const sets = fields.map(f => `${f} = ?`).join(',');
    const values = fields.map(f => req.body[f] ?? null);
    try {
      db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`).run(...values, req.params.id);
      res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete(`/api/${resource}/:id`, (req, res) => {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  });
}

crud('products', 'products', ['name', 'is_own', 'vendor', 'website', 'notes', 'kind', 'pros', 'cons', 'roadmap'], { orderBy: 'is_own DESC, name' });

// Releases are only meaningful for real products (own + competitor). Analyst
// firms and news sources sometimes get spurious release rows from the
// analyzer when an article mentions a version number, so we filter them out
// of the list/get endpoints here. POST/PUT/DELETE still go through the
// generic crud helper below.
app.get('/api/releases', (_req, res) => {
  res.json(db.prepare(`
    SELECT r.* FROM releases r
    JOIN products p ON p.id = r.product_id
    WHERE COALESCE(p.kind, 'product') = 'product'
    ORDER BY r.release_date DESC, r.id DESC
  `).all());
});
app.get('/api/releases/:id', (req, res) => {
  const row = db.prepare(`
    SELECT r.* FROM releases r
    JOIN products p ON p.id = r.product_id
    WHERE r.id = ? AND COALESCE(p.kind, 'product') = 'product'
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});
crud('releases', 'releases', ['product_id', 'version', 'release_date', 'highlights', 'url'], { orderBy: 'release_date DESC' });
crud('features', 'features', ['name', 'category', 'description'], { orderBy: 'category, name' });
crud('feature-requests', 'feature_requests', ['feature_id', 'title', 'source_product_id', 'priority', 'status', 'notes'], { orderBy: 'created_at DESC' });

// Conferences enriched with firm name (for the Analysts tab table).
// Must be registered BEFORE the generic crud('/api/conferences/:id') so this
// more specific path takes precedence.
app.get('/api/conferences/enriched', (req, res) => {
  const params = [];
  let where = '';
  if (req.query.product_id) { where = 'WHERE c.product_id = ?'; params.push(req.query.product_id); }
  if (req.query.upcoming === '1') {
    where += (where ? ' AND ' : 'WHERE ') + "(c.start_date IS NULL OR c.start_date >= date('now'))";
  }
  const rows = db.prepare(`SELECT c.*, p.name AS firm_name, p.kind AS firm_kind
                           FROM conferences c
                           JOIN products p ON p.id = c.product_id
                           ${where}
                           ORDER BY COALESCE(c.start_date, '9999-12-31') ASC, c.name ASC`).all(...params);
  res.json(rows);
});
crud('conferences', 'conferences', ['product_id', 'name', 'region', 'location', 'start_date', 'end_date', 'url', 'topics', 'notes'], { orderBy: "COALESCE(start_date, '9999-12-31') ASC" });


// product_features: composite key — custom handlers
app.get('/api/product-features', (req, res) => {
  res.json(db.prepare('SELECT * FROM product_features').all());
});
app.put('/api/product-features', (req, res) => {
  const { product_id, feature_id, supported, since_version, notes } = req.body;
  db.prepare(`INSERT INTO product_features (product_id, feature_id, supported, since_version, notes)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(product_id, feature_id) DO UPDATE SET
                supported = excluded.supported,
                since_version = excluded.since_version,
                notes = excluded.notes`)
    .run(product_id, feature_id, supported ? 1 : 0, since_version ?? null, notes ?? null);
  res.json({ ok: true });
});

// Bulk-import features for a product (typically own product). Body: { product_id, lines:[{name,category?,since_version?,notes?}] | text }
app.post('/api/product-features/bulk', (req, res) => {
  const { product_id } = req.body || {};
  if (!product_id) return res.status(400).json({ error: 'product_id required' });
  let lines = req.body.lines;
  if (!Array.isArray(lines)) {
    const text = String(req.body.text || '');
    lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
      // Accept "Name | Category | v1.0 | notes" or "Name, Category, v1.0, notes" or just "Name"
      const parts = l.split(/\s*\|\s*|\s*,\s*/);
      return { name: parts[0], category: parts[1] || 'Other', since_version: parts[2] || null, notes: parts[3] || null };
    });
  }
  const findFeat = db.prepare('SELECT id FROM features WHERE LOWER(name) = LOWER(?)');
  const insertFeat = db.prepare('INSERT INTO features (name, category, description) VALUES (?,?,?)');
  const upsert = db.prepare(`INSERT INTO product_features (product_id, feature_id, supported, since_version, notes)
                             VALUES (?, ?, 1, ?, ?)
                             ON CONFLICT(product_id, feature_id) DO UPDATE SET supported=1, since_version=excluded.since_version, notes=excluded.notes`);
  let inserted = 0, updated = 0, createdFeatures = 0;
  const tx = db.transaction((rows) => {
    for (const l of rows) {
      if (!l || !l.name) continue;
      let f = findFeat.get(l.name);
      if (!f) {
        const r = insertFeat.run(l.name, l.category || 'Other', '');
        f = { id: r.lastInsertRowid };
        createdFeatures++;
      }
      const pre = db.prepare('SELECT supported FROM product_features WHERE product_id=? AND feature_id=?').get(product_id, f.id);
      upsert.run(product_id, f.id, l.since_version || null, l.notes || null);
      if (pre) updated++; else inserted++;
    }
  });
  tx(lines);
  res.json({ ok: true, inserted, updated, createdFeatures, total: lines.length });
});

// Compatibility matrix: features × products (analyst firms excluded)
app.get('/api/analysis/matrix', (req, res) => {
  const products = db.prepare("SELECT * FROM products WHERE COALESCE(kind,'product') = 'product' ORDER BY is_own DESC, name").all();
  const features = db.prepare('SELECT * FROM features ORDER BY category, name').all();
  const pf = db.prepare('SELECT * FROM product_features').all();
  const map = {};
  for (const r of pf) map[`${r.product_id}:${r.feature_id}`] = r;
  res.json({ products, features, support: map });
});

// Gap analysis: features competitors support but our product doesn't
app.get('/api/analysis/gaps', (req, res) => {
  const ownIds = db.prepare('SELECT id FROM products WHERE is_own = 1').all().map(r => r.id);
  if (ownIds.length === 0) return res.json([]);
  const placeholders = ownIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT f.id AS feature_id, f.name AS feature, f.category,
           GROUP_CONCAT(p.name, ', ') AS competitors_supporting,
           COUNT(*) AS competitor_count
    FROM features f
    JOIN product_features pf ON pf.feature_id = f.id AND pf.supported = 1
    JOIN products p ON p.id = pf.product_id AND p.is_own = 0 AND COALESCE(p.kind,'product') = 'product'
    WHERE NOT EXISTS (
      SELECT 1 FROM product_features mine
      WHERE mine.feature_id = f.id AND mine.product_id IN (${placeholders}) AND mine.supported = 1
    )
    GROUP BY f.id
    ORDER BY competitor_count DESC, f.name
  `).all(...ownIds);
  res.json(rows);
});

// Per-feature evidence: for each competitor that supports a given feature,
// return the best evidence links (release URL, raw_item URLs whose analysis
// mentioned this feature, plus the curated note/since_version).
app.get('/api/analysis/feature-evidence/:featureId', (req, res) => {
  const fid = +req.params.featureId;
  const feature = db.prepare('SELECT id, name, category FROM features WHERE id = ?').get(fid);
  if (!feature) return res.status(404).json({ error: 'Feature not found' });
  const supporters = db.prepare(`
    SELECT pf.product_id, p.name AS product_name, p.is_own, p.website,
           pf.notes, pf.since_version
    FROM product_features pf
    JOIN products p ON p.id = pf.product_id
    WHERE pf.feature_id = ? AND pf.supported = 1
      AND COALESCE(p.kind, 'product') = 'product'
    ORDER BY p.is_own DESC, p.name
  `).all(fid);
  const isUrl = (s) => typeof s === 'string' && /^https?:\/\/\S+$/i.test(s.trim());
  const STOP = new Set(['the','a','an','and','or','of','for','to','with','in','on','by','via','at','from','as','is','be','&']);
  const tokens = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(t => t && t.length > 2 && !STOP.has(t));
  const fname = feature.name.toLowerCase();
  const ftokens = new Set(tokens(feature.name));
  // Need ~half of meaningful tokens to overlap, with a floor of 1 for short names.
  const minOverlap = Math.max(1, Math.ceil(ftokens.size / 2));
  const matches = (text) => {
    if (!text) return false;
    const lc = text.toLowerCase();
    if (ftokens.size <= 2) {
      // Short feature names: require all tokens present (substring match)
      for (const t of ftokens) if (!lc.includes(t)) return false;
      return ftokens.size > 0;
    }
    let hit = 0;
    for (const t of ftokens) if (lc.includes(t)) hit++;
    return hit >= minOverlap;
  };
  // Pull every analyzed raw_item per product, scan analysis_json + title/content for this feature.
  const stmt = db.prepare(`SELECT id, url, title, content, published_at, fetched_at, analysis_json
                           FROM raw_items
                           WHERE product_id = ? AND status = 'analyzed' AND analysis_json IS NOT NULL`);
  const releaseStmt = db.prepare(`SELECT id, version, release_date, url, highlights
                                  FROM releases WHERE product_id = ? AND url IS NOT NULL AND url != ''
                                  ORDER BY COALESCE(release_date, '') DESC LIMIT 30`);
  const result = supporters.map(s => {
    const evidence = [];
    const seen = new Set();
    const push = (e) => {
      const key = (e.url || '') + '|' + (e.title || '');
      if (key === '|' || seen.has(key)) return;
      seen.add(key);
      evidence.push(e);
    };
    // 1) Curated note URL on product_features
    if (isUrl(s.notes)) push({ kind: 'note', url: s.notes.trim(), title: 'Curated source' });
    // 2) Raw items that mention this feature — by extracted feature names, by article title,
    //    by release_summary/highlights or by content body.
    for (const it of stmt.iterate(s.product_id)) {
      let aj;
      try { aj = JSON.parse(it.analysis_json); } catch (_) { continue; }
      const ex = (aj && aj.extracted) || {};
      const feats = Array.isArray(ex.features) ? ex.features : [];
      const featBlob = feats.map(f => (f && f.name || '') + ' ' + (f && f.summary || '')).join(' | ');
      const releaseBlob = (ex.release_summary || '') + ' ' + (ex.version || '');
      const hit =
        feats.some(f => (f && (f.name || '')).toLowerCase() === fname) ||
        matches(featBlob) ||
        matches(it.title) ||
        matches(releaseBlob) ||
        matches(it.content);
      if (hit && it.url) {
        push({
          kind: 'article',
          url: it.url,
          title: it.title || '(untitled)',
          date: (it.published_at || it.fetched_at || '').slice(0, 10) || null,
        });
      }
      if (evidence.length >= 8) break;
    }
    // 3) Release URLs (best-effort, keyword-anchored)
    if (evidence.length < 5) {
      const rels = releaseStmt.all(s.product_id);
      for (const r of rels) {
        const blob = (r.highlights || '') + ' ' + (r.version || '');
        if (matches(blob)) {
          push({
            kind: 'release',
            url: r.url,
            title: r.version ? `Release v${r.version}` : 'Release',
            date: (r.release_date || '').slice(0, 10) || null,
          });
        }
        if (evidence.length >= 8) break;
      }
    }
    // 4) Fallback to product website
    if (evidence.length === 0 && s.website) {
      push({ kind: 'website', url: s.website, title: 'Product website (no specific article matched)' });
    }
    return {
      product_id: s.product_id,
      product_name: s.product_name,
      is_own: !!s.is_own,
      since_version: s.since_version || null,
      notes: isUrl(s.notes) ? null : (s.notes || null),
      evidence,
    };
  });
  res.json({ feature, supporters: result });
});

// Trend analysis: hot features, category trends, release velocity, emerging keywords
const { computeTrends, computeCompetitorReport } = require('./lib/trends');
app.get('/api/analysis/trends', (req, res) => {
  try { res.json(computeTrends(db, { months: req.query.months })); }
  catch (e) { console.error('trends error', e); res.status(500).json({ error: e.message }); }
});
app.get('/api/analysis/competitor-report', (req, res) => {
  try { res.json(computeCompetitorReport(db, { months: req.query.months })); }
  catch (e) { console.error('report error', e); res.status(500).json({ error: e.message }); }
});

// Dashboard summary
app.get('/api/analysis/summary', (req, res) => {
  const counts = {
    // 'products' = our own + competitor products only (analysts excluded — they have their own card / page).
    products: db.prepare("SELECT COUNT(*) c FROM products WHERE COALESCE(kind,'product') = 'product'").get().c,
    competitors: db.prepare("SELECT COUNT(*) c FROM products WHERE is_own = 0 AND COALESCE(kind,'product') = 'product'").get().c,
    analysts: db.prepare("SELECT COUNT(*) c FROM products WHERE COALESCE(kind,'product') = 'analyst'").get().c,
    features: db.prepare('SELECT COUNT(*) c FROM features').get().c,
    releases: db.prepare('SELECT COUNT(*) c FROM releases').get().c,
    open_requests: db.prepare("SELECT COUNT(*) c FROM feature_requests WHERE status = 'open'").get().c,
  };
  const recent_releases = db.prepare(`
    SELECT r.*, p.name AS product_name FROM releases r
    JOIN products p ON p.id = r.product_id
    ORDER BY release_date DESC LIMIT 5`).all();
  res.json({ counts, recent_releases });
});

// === Sources / Ingestion / AI analysis ===
const { ingestRss, ingestHtml, ingestManual } = require('./lib/ingest');
const { extractFeatures, scoreImplementability } = require('./lib/analyzer');
const llm = require('./lib/llm');
const spoc = require('./lib/spoc');
const featureRequests = require('./lib/feature-requests');
const mailer = require('./lib/mailer');
const dailyDigest = require('./lib/daily-digest');
const chatTools = require('./lib/chat-tools');

// In-memory tracker for the SPOC import job so the UI can render a progress
// bar while runImport (download → parse → DB write) is in flight.
const spocJobs = new Map();
// Same pattern for the Feature Request sheet import.
const frJobs = new Map();

crud('sources', 'sources', ['product_id', 'kind', 'url', 'label'], { orderBy: 'product_id, id DESC' });

app.get('/api/llm/status', (req, res) => res.json(llm.status()));

// Save model preference (token management is via /api/llm/tokens endpoints).
app.post('/api/llm/config', (req, res) => {
  try {
    const { model } = req.body || {};
    llm.saveConfig({ model });
    res.json(llm.status());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// === Token management (multi-token fallback chain) =========================
app.get('/api/llm/tokens', (req, res) => res.json(llm.listTokens()));

app.post('/api/llm/tokens', (req, res) => {
  try {
    const { label, token, expiresAt, priority } = req.body || {};
    const id = llm.addToken({ label, token, expiresAt, priority });
    res.json({ id, status: llm.status() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/llm/tokens/:id', (req, res) => {
  try {
    llm.updateToken(+req.params.id, req.body || {});
    res.json(llm.status());
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/llm/tokens/:id', (req, res) => {
  try { llm.deleteToken(+req.params.id); res.json(llm.status()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/llm/tokens/:id/move', (req, res) => {
  try {
    llm.moveToken(+req.params.id, req.body?.direction === 'up' ? 'up' : 'down');
    res.json(llm.status());
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/llm/tokens/:id/reset', (req, res) => {
  try { llm.clearExhausted(+req.params.id); res.json(llm.status()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Promote a token to the top of the fallback chain — makes it the active one.
app.post('/api/llm/tokens/:id/use', (req, res) => {
  try { llm.promoteToken(+req.params.id); res.json(llm.status()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Per-row connection test — verifies one specific token without touching others.
app.post('/api/llm/tokens/:id/test', async (req, res) => {
  try {
    const result = await llm.testToken(+req.params.id);
    res.json(result);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Legacy endpoint kept as a no-op (UI uses /tokens now).
app.delete('/api/llm/config', (req, res) => res.json(llm.status()));

// Lightweight connectivity test — single tiny chat call, no DB writes.
// Returns { ok, model, latency_ms, sample? } or { ok:false, error, kind }.
app.post('/api/llm/test', async (req, res) => {
  if (!llm.hasToken()) {
    // Differentiate "no tokens at all" from "tokens exist but all unavailable"
    // so the UI can give an actionable message instead of "No token configured".
    const st = llm.status();
    const toks = (st && st.tokens) || [];
    if (toks.length > 0) {
      const exhausted = toks.filter(t => t.state === 'exhausted');
      const expired   = toks.filter(t => t.state === 'expired');
      if (exhausted.length === toks.length) {
        const soonest = exhausted
          .map(t => t.exhaustedUntil)
          .filter(Boolean)
          .sort()[0];
        return res.status(200).json({
          ok: false,
          kind: 'rate_limit',
          error: soonest
            ? `All ${toks.length} token${toks.length === 1 ? ' is' : 's are'} cooling down after a rate-limit. Earliest one resumes at ${soonest} UTC.`
            : `All configured tokens are cooling down after a rate-limit.`,
        });
      }
      if (expired.length === toks.length) {
        return res.status(200).json({
          ok: false,
          kind: 'auth',
          error: 'All configured tokens have expired. Edit a row to update its expiry or paste a fresh PAT.',
        });
      }
      return res.status(200).json({
        ok: false,
        kind: 'other',
        error: 'No usable tokens right now — some are cooling down, some have expired. Reset or replace at least one.',
      });
    }
    return res.status(400).json({ ok: false, error: 'No tokens configured. Add a GitHub PAT below first.', kind: 'no_token' });
  }
  const started = Date.now();
  try {
    const reply = await llm.chatRaw([
      { role: 'system', content: 'Reply with exactly the word: pong' },
      { role: 'user',   content: 'ping' },
    ], { temperature: 0 });
    const latency_ms = Date.now() - started;
    const text = (reply && reply.content || '').toString().trim().slice(0, 40);
    res.json({ ok: true, model: llm.getModel(), latency_ms, sample: text });
  } catch (e) {
    const msg = e.message || String(e);
    const m = msg.toLowerCase();
    let kind = 'other';
    if (m.includes('429') || m.includes('rate limit')) kind = 'rate_limit';
    else if (m.includes('401') || m.includes('403') || m.includes('unauthor') || m.includes('forbidden')) kind = 'auth';
    else if (m.includes('timeout') || m.includes('econnreset') || m.includes('enotfound') || m.includes('network')) kind = 'network';
    res.status(200).json({ ok: false, error: msg, kind, latency_ms: Date.now() - started });
  }
});

// Chat with the configured LLM. Tool-calling agent: the model can invoke
// read-only DB tools (see lib/chat-tools.js) to drill into specific data
// instead of relying solely on the precomputed workspace summary.
// Accepts { messages: [{role, content}], context?: object, debug?: bool }.
app.post('/api/chat', async (req, res) => {
  try {
    if (!llm.hasToken()) return res.status(400).json({ error: 'AI is disabled — paste a GitHub token in Settings.' });
    const { messages = [], context, debug = false } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }
    // Build a compact workspace summary so simple questions need zero tool calls.
    let ctx = '';
    try {
      const products = db.prepare("SELECT id, name, vendor, is_own, COALESCE(kind,'product') AS kind FROM products ORDER BY is_own DESC, name").all();
      const own = products.filter(p => p.is_own && p.kind === 'product');
      const competitors = products.filter(p => !p.is_own && p.kind === 'product');
      const analysts = products.filter(p => p.kind === 'analyst');

      const counts = {
        features:     db.prepare('SELECT COUNT(*) c FROM features').get().c,
        releases:     db.prepare('SELECT COUNT(*) c FROM releases').get().c,
        raw_items:    db.prepare('SELECT COUNT(*) c FROM raw_items').get().c,
        pending:      db.prepare("SELECT COUNT(*) c FROM raw_items WHERE status != 'analyzed'").get().c,
        open_reqs:    db.prepare("SELECT COUNT(*) c FROM feature_requests WHERE status = 'open'").get().c,
      };
      let spocLine = '';
      try {
        const spocCount = db.prepare("SELECT COUNT(*) c FROM spoc_entries").get().c;
        const spocImports = db.prepare("SELECT COUNT(*) c FROM spoc_imports").get().c;
        spocLine = `SPOC: ${spocCount} ticket entries from ${spocImports} import(s). Use get_spoc_summary / search_spoc / count_spoc to query them.\n`;
      } catch (_) { /* spoc tables may not exist yet */ }

      ctx =
        `\n\n=== WORKSPACE SNAPSHOT ===\n` +
        `Own products (id·name): ${own.map(p => `${p.id}·${p.name}`).join(', ') || '(none)'}\n` +
        `Competitors (${competitors.length}): ${competitors.map(p => `${p.id}·${p.name}`).join(', ') || '(none)'}\n` +
        `Analyst firms (${analysts.length}): ${analysts.map(p => `${p.id}·${p.name}`).join(', ') || '(none)'}\n` +
        `Counts: ${counts.features} features · ${counts.releases} releases · ${counts.raw_items} feed items (${counts.pending} pending) · ${counts.open_reqs} open backlog items.\n` +
        spocLine +
        `=== END SNAPSHOT ===\n` +
        `Use the product ids above when calling tools that take product_id.`;
    } catch (e) { console.warn('chat ctx build failed', e.message); }

    const sys = {
      role: 'system',
      content:
        `You are the PM Panel assistant for a competitive-intelligence dashboard.\n` +
        `You are powered by the "${llm.getModel()}" model, served via the GitHub Models inference API ` +
        `(https://models.github.ai). The PM Panel itself is a local Express + SQLite app; you have ` +
        `read-only tool access to its database. If the user asks who/what you are, answer truthfully ` +
        `with this information.\n\n` +
        `You can call READ-ONLY tools to inspect the SQLite workspace: list_products, ` +
        `get_product_features, find_features, get_gaps, get_feature_evidence, get_releases, ` +
        `count_feed_items, search_feed, get_feed_item, get_competitor_report, get_open_requests, compare_products, ` +
        `get_spoc_summary, search_spoc, count_spoc (SPOC = daily customer ticket sheet ingested from Zoho).\n` +
        `You can also call two WRITE tools to extend the catalog when the user explicitly asks: ` +
        `add_product (idempotent insert into products) and add_source (idempotent insert into sources). ` +
        `Both are insert-only — they never overwrite or delete. Workflow when user asks "add X": ` +
        `(1) call list_products to confirm X isn't already there, (2) call add_product with the exact ` +
        `name the user gave, (3) if the user provided or you can ask for a feed/release-notes URL, ` +
        `call add_source for it, (4) tell the user to click Refresh in the UI to start polling.\n\n` +
        `You can also call TWO COMMUNICATION tools — pick the right one based on what the user wants emailed:\n` +
        `  • send_chat_transcript — emails THIS conversation (the messages in the chat window). Use ONLY ` +
        `when the user explicitly says "email/send/share this chat / this conversation / our discussion / the transcript".\n` +
        `  • send_daily_digest — emails the PM digest. Has a "sections" parameter (any subset of ` +
        `["spoc","competitive","analyst","news"]) so the user can ask for a slice. Examples: ` +
        `"only SPOC data" → sections=["spoc"]; "just the news" → sections=["news"]; ` +
        `"competitive and analyst feeds" → sections=["competitive","analyst"]; ` +
        `"last 24 hours summary" / "the digest" / no specific subset → omit sections (full digest). ` +
        `Use when the user asks to send aggregated workspace data, NOT the chat itself.\n` +
        `If you are unsure which one they mean, ask ONE short clarifying question; do not guess. ` +
        `DO NOT ASK "are you sure?" OR "shall I send it?" — just call the chosen tool with the recipient(s). ` +
        `CRITICAL: the UI dialog only opens when you ACTUALLY INVOKE the tool. You must emit a function/tool ` +
        `call this turn — never reply with text like "please confirm in the dialog" unless you also called ` +
        `the tool in the same turn. If you only have text in your reply with no tool call, NO dialog appears ` +
        `and the user is stuck.\n` +
        `When the tool returns needs_confirmation, reply with ONE short sentence like ` +
        `"I've prepared the email — please confirm in the dialog." Do not list recipients/contents again. ` +
        `NEVER set the "confirmed" parameter yourself — leave it out. ` +
        `If a tool returns an allow-list error, relay it verbatim.\n\n` +
        `=== ANTI-HALLUCINATION RULES (HIGHEST PRIORITY) ===\n` +
        `1. GROUND EVERY CLAIM. Every product name, vendor, version, date, feature, gap, URL, count, ` +
        `or release detail in your reply MUST come from (a) the WORKSPACE SNAPSHOT block below, or ` +
        `(b) a tool result you just received in this turn. If neither source contains it, you do not know it.\n` +
        `2. CALL A TOOL FIRST when the question is about specific data (a product, feature, gap, ` +
        `release, feed item, competitor activity, counts, comparisons). Never answer from memory or ` +
        `general knowledge about the SIEM market — you have no internet access and your training data ` +
        `is unrelated to this user's catalog.\n` +
        `3. NEVER FABRICATE: product names, version numbers, release dates, source URLs, vendor names, ` +
        `feature names, gap titles, or numeric counts. Do not "round to a plausible number." Do not ` +
        `infer a feature exists because a product "probably" has it.\n` +
        `4. IF A TOOL RETURNS [] OR { error }: say so explicitly ("I don't see any matching X in the ` +
        `workspace") and stop. Do not substitute generic knowledge.\n` +
        `5. IF THE USER ASKS ABOUT SOMETHING NOT IN THE WORKSPACE (e.g. a competitor we don't track, ` +
        `a public news item, market share, pricing): say plainly that this data is not in the panel ` +
        `and offer to add it. Do not guess.\n` +
        `5a. NEVER SILENTLY SUBSTITUTE. If the user names a specific product, vendor, feature, or ` +
        `entity, you MUST verify it exists by calling list_products or find_features first. If the ` +
        `exact name (or an obvious alias like "MS Sentinel" → "Microsoft Sentinel") is NOT in the ` +
        `result, you MUST reply: "I don't see [exact name as the user wrote it] in the panel — ` +
        `tracked products are: [list 3-5 closest names]. Want me to add it, or did you mean one of ` +
        `these?" Do NOT proceed to answer the question using a different product than the one named.\n` +
        `6. ATTRIBUTE EVERY CITATION. When you mention a feature/release/gap, name the source — e.g. ` +
        `"per the release notes for Splunk ES 8.0 (URL)" or "from feed item #1234". If you don't have ` +
        `a URL or id from a tool result, don't fabricate one — just omit the citation.\n` +
        `7. NUMBERS COME FROM TOOLS, NOT ESTIMATES. Counts ("8 competitors support X") must match a ` +
        `tool result exactly. If you have to estimate, say "approximately" and explain the basis. ` +
        `For "how many feed items in the last N days" specifically, ALWAYS call count_feed_items — ` +
        `do NOT count rows from search_feed (it is row-limited and will give the wrong answer).\n` +
        `8. CHAIN TOOLS when needed: e.g. find_features → get_feature_evidence; list_products → ` +
        `get_product_features → compare_products. One tool call rarely answers a comparison question.\n` +
        `9. PRESERVE EXACT NAMES. Quote product names, feature names, and gap titles verbatim from ` +
        `tool results — do not paraphrase ("Microsoft Sentinel" not "MS Sentinel"; "ManageEngine ` +
        `Log360 Cloud" not "Log360").\n` +
        `10. NO JSON, NO MARKDOWN CODE FENCES around the final answer. Use Markdown bold/lists for ` +
        `formatting only. If you cannot answer with grounded facts, say "I don't have that data" and ` +
        `suggest which tool or which manual entry would help.\n\n` +
        `STYLE: concise. Bullet points for lists. Quote source URLs inline when present.` +
        ctx + (context ? `\n\nUI context: ${JSON.stringify(context).slice(0, 1500)}` : ''),
    };

    // Agent loop: call → execute tool calls → call again → ... until plain text reply.
    const convo = [sys, ...messages.slice(-12).map(m => ({ role: m.role, content: m.content }))];
    const trace = [];
    const MAX_STEPS = 6;
    let final = '';
    let pendingConfirmation = null;
    for (let step = 0; step < MAX_STEPS; step++) {
      const msg = await llm.chatRaw(convo, { tools: chatTools.toolSpecs, temperature: 0.1 });
      const toolCalls = msg.tool_calls || [];
      // Push the assistant turn (must be present before its tool responses).
      convo.push({
        role: 'assistant',
        content: msg.content || '',
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      if (!toolCalls.length) {
        final = msg.content || '';
        // Guard #1: did the model hallucinate the email-confirmation pattern
        // ("please confirm in the dialog", "I've prepared the email", etc.)
        // without ever calling send_chat_transcript / send_daily_digest?
        // That happens because the system prompt teaches it the exact reply
        // wording. If so, push back and let the loop continue.
        const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
        const looksLikeEmailAck = /confirm in (the )?dialog|prepared the email|opened (the )?(dialog|confirmation)/i.test(final);
        const askedToEmail = /\b(send|mail|email|forward|share)\b.*\b(to|@)\b/i.test(lastUser)
          || /@[\w.-]+\.[a-z]{2,}/i.test(lastUser);
        const calledEmailTool = trace.some(t => t.tool === 'send_chat_transcript' || t.tool === 'send_daily_digest');
        if (looksLikeEmailAck && askedToEmail && !calledEmailTool) {
          convo.push({
            role: 'system',
            content:
              'STOP. You replied "please confirm in the dialog" but you DID NOT call any email tool ' +
              'this turn. The UI dialog only appears when you actually invoke send_chat_transcript ' +
              'or send_daily_digest. Discard your previous draft and call the correct tool NOW ' +
              '(send_daily_digest for digest/summary/SPOC/feeds/news requests; send_chat_transcript ' +
              'for "send this chat"). Pass the recipient address(es) the user named. Never set ' +
              '"confirmed" yourself.',
          });
          final = '';
          continue;
        }
        // One-shot anti-hallucination guard: if the user asked something data-specific
        // but the model answered without ever consulting a tool, push back once and let
        // the loop continue. A "data-specific" question mentions concrete catalog terms.
        const looksDataSpecific = /\b(product|competitor|feature|gap|release|version|sentinel|splunk|qradar|securonix|chronicle|log360|exabeam|sumo|elastic|vendor|backlog|request|feed|article|ingest|category|since|coverage|matrix|analyst|gartner|forrester|spoc|ticket|customer|reseller|module|tracker|read|unread|saairam|abinayasri|athivignesh|insalatta|janapreethi|madathi|mari|pradeep|sakthi|sundar|surya)\b/i.test(lastUser);
        if (looksDataSpecific && trace.length === 0 && step === 0) {
          convo.push({
            role: 'system',
            content:
              'STOP. You answered without calling any tool, but the user asked a data-specific ' +
              'question. Per the anti-hallucination rules you must ground every claim in a tool ' +
              'result or the workspace snapshot. Discard your previous draft, call the appropriate ' +
              'tool(s) now (find_features, get_product_features, get_gaps, get_releases, ' +
              'compare_products, search_feed, etc.), and only then answer. If a tool returns ' +
              'nothing, say so plainly instead of guessing.',
          });
          continue;
        }
        break;
      }
      // Execute each tool call and append a `tool` message with the result.
      for (const tc of toolCalls) {
        let args = {};
        try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch (_) { args = {}; }
        const name = tc.function?.name;
        // Context passed to write/communication tools that need more than just
        // their JSON args (e.g. send_chat_transcript needs the chat history).
        const toolCtx = { messages, getDailyRecipients };
        const result = await chatTools.runTool(name, args, toolCtx);
        // If a tool wants the UI to prompt the user before completing (e.g.
        // send_chat_transcript), capture the request — the client will render
        // a Yes/No dialog and call /api/mail/send-transcript on Confirm.
        if (result && result.needs_confirmation && !pendingConfirmation) {
          pendingConfirmation = {
            tool: name,
            args,
            kind: result.kind || (name === 'send_daily_digest' ? 'digest' : 'transcript'),
            to: result.to,
            subject: result.subject,
            note: result.note || null,
            message_count: result.message_count,
            hours: result.hours,
            sections: result.sections || null,
            stats: result.stats || null,
          };
        }
        trace.push({ step, tool: name, args, rows: Array.isArray(result) ? result.length : undefined });
        const payload = JSON.stringify(result);
        convo.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: payload.length > 12000 ? payload.slice(0, 12000) + '…(truncated)' : payload,
        });
      }
    }
    if (!final) final = '(I ran out of tool-call steps before producing an answer. Try asking a more specific question.)';
    res.json({ reply: final, ...(pendingConfirmation ? { pendingConfirmation } : {}), ...(debug ? { trace } : {}) });
  } catch (e) {
    console.error('chat error', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/raw-items', (req, res) => {
  const where = req.query.product_id ? 'WHERE ri.product_id = ?' : '';
  const params = req.query.product_id ? [req.query.product_id] : [];
  const rows = db.prepare(`SELECT ri.id, ri.source_id, ri.product_id, ri.hash, ri.title, ri.url, ri.published_at, ri.fetched_at, ri.status, s.kind AS source_kind, p.is_own AS is_own_product FROM raw_items ri LEFT JOIN sources s ON s.id = ri.source_id LEFT JOIN products p ON p.id = ri.product_id ${where} ORDER BY COALESCE(ri.published_at, ri.fetched_at) DESC, ri.id DESC LIMIT 200`).all(...params);
  res.json(rows);
});

app.get('/api/raw-items/pending-count', (req, res) => {
  // "Pending" means competitor items still awaiting LLM analysis.
  // Analyst and news items intentionally stay at status='new' (we don't run
  // the LLM on them), so excluding them here keeps the badge meaningful.
  const params = [];
  let where = `WHERE ri.status = 'new'
                 AND (p.kind IS NULL OR p.kind = 'product')
                 AND COALESCE(p.is_own, 0) = 0`;
  if (req.query.product_id) {
    where += ' AND ri.product_id = ?';
    params.push(req.query.product_id);
  }
  const r = db.prepare(`SELECT COUNT(*) as n
                        FROM raw_items ri
                        JOIN products p ON p.id = ri.product_id
                        ${where}`).get(...params);
  res.json({ count: r.n });
});

app.get('/api/raw-items/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM raw_items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.analysis_json) try { row.analysis = JSON.parse(row.analysis_json); } catch (_) {}
  res.json(row);
});

app.delete('/api/raw-items/:id', (req, res) => {
  db.prepare('DELETE FROM raw_items WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Run a source: fetch + dedupe-insert raw_items (auto-analyze new ones unless ?auto=0)
app.post('/api/sources/:id/run', async (req, res) => {
  const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'Source not found' });
  const auto = req.query.auto !== '0' && req.body?.auto !== false;
  try {
    let items = [];
    if (src.kind === 'rss') items = await ingestRss(src.url);
    else if (src.kind === 'html') items = await ingestHtml(src.url);
    else return res.status(400).json({ error: 'Use POST /api/ingest/manual for manual entries' });
    const insert = db.prepare(`INSERT OR IGNORE INTO raw_items (source_id, product_id, hash, title, url, content, published_at) VALUES (?,?,?,?,?,?,?)`);
    let inserted = 0;
    const newIds = [];
    for (const it of items) {
      const r = insert.run(src.id, src.product_id, it.hash, it.title, it.url, it.content, it.published_at);
      if (r.changes) { inserted++; newIds.push(r.lastInsertRowid); }
    }
    db.prepare('UPDATE sources SET last_polled = datetime(\'now\') WHERE id = ?').run(src.id);
    const analysis = auto ? await autoAnalyzeIds(newIds) : null;
    res.json({ fetched: items.length, inserted, analysis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manual paste ingestion (auto-analyze unless auto:false)
app.post('/api/ingest/manual', async (req, res) => {
  const { product_id, title, content, url, auto } = req.body;
  if (!product_id || !content) return res.status(400).json({ error: 'product_id and content required' });
  const items = ingestManual({ title, content, url });
  const insert = db.prepare(`INSERT OR IGNORE INTO raw_items (source_id, product_id, hash, title, url, content, published_at) VALUES (NULL,?,?,?,?,?,?)`);
  const it = items[0];
  const r = insert.run(product_id, it.hash, it.title, it.url, it.content, it.published_at);
  const doAuto = auto !== false;
  let analysis = null;
  if (r.changes && doAuto) analysis = await autoAnalyzeIds([r.lastInsertRowid]);
  res.json({ inserted: r.changes ? 1 : 0, raw_item_id: r.lastInsertRowid, analysis });
});

// Run all sources for one product (or all products) — auto-analyze unless auto:false
// Internal: poll every source (optionally scoped to a single product or to a
// product-kind category) and auto-analyze new items if requested. Returns the
// usual {results, analysis} shape. Throws if an ingest is already running.
async function ingestRunAll({ product_id, product_kind, auto = true } = {}) {
  if (ingestJob.running) {
    const e = new Error('ingest already running');
    e.code = 'BUSY';
    throw e;
  }
  const params = [];
  const whereParts = ["s.kind IN ('rss','html')"];
  if (product_id) { whereParts.push('s.product_id = ?'); params.push(product_id); }
  if (product_kind === 'product') {
    whereParts.push("(p.kind IS NULL OR p.kind = 'product')");
  } else if (product_kind === 'analyst' || product_kind === 'news') {
    whereParts.push('p.kind = ?');
    params.push(product_kind);
  }
  const where = 'WHERE ' + whereParts.join(' AND ');
  const sources = db.prepare(`SELECT s.*, p.name AS product_name FROM sources s JOIN products p ON p.id = s.product_id ${where}`).all(...params);
  resetIngestJob(sources.length);
  const results = [];
  const newIds = [];
  try {
    for (const src of sources) {
      ingestJob.currentSourceId = src.id;
      ingestJob.currentSourceName = `${src.product_name}${src.label ? ' · ' + src.label : ''}`;
      try {
        const items = src.kind === 'rss' ? await ingestRss(src.url) : await ingestHtml(src.url);
        const insert = db.prepare(`INSERT OR IGNORE INTO raw_items (source_id, product_id, hash, title, url, content, published_at) VALUES (?,?,?,?,?,?,?)`);
        let inserted = 0;
        for (const it of items) {
          const rr = insert.run(src.id, src.product_id, it.hash, it.title, it.url, it.content, it.published_at);
          if (rr.changes) { inserted++; newIds.push(rr.lastInsertRowid); }
        }
        db.prepare('UPDATE sources SET last_polled = datetime(\'now\') WHERE id = ?').run(src.id);
        results.push({ source_id: src.id, fetched: items.length, inserted });
        ingestJob.fetched += items.length;
        ingestJob.inserted += inserted;
      } catch (e) {
        results.push({ source_id: src.id, error: e.message });
        ingestJob.errors++;
        ingestJob.lastError = e.message;
        ingestJob.lastErrorKind = classifyError(e.message);
      }
      ingestJob.done++;
    }
  } finally {
    ingestJob.running = false;
    ingestJob.finishedAt = Date.now();
    ingestJob.currentSourceId = null;
    ingestJob.currentSourceName = '';
  }
  const analysis = auto ? await autoAnalyzeIds(newIds) : null;
  return { results, analysis };
}

app.post('/api/ingest/run-all', async (req, res) => {
  const startedAt = Date.now();
  const productKind = req.body?.product_kind;
  try {
    const out = await ingestRunAll({
      product_id: req.body?.product_id,
      product_kind: productKind,
      auto: req.body?.auto !== false,
    });
    // Refresh the matching Scheduler row(s) so a manual rerun clears any
    // stale error from the previous scheduled run.
    // Scoped to a single product (product_id) intentionally skips this — the
    // scheduler row tracks full-kind polls, not single-product ones.
    if (!req.body?.product_id) {
      try { refreshSchedulerResultsFromIngest({ startedAt, out, productKind }); }
      catch (e) { console.error('[scheduler] refresh after manual run-all failed:', e.message); }
    }
    res.json(out);
  } catch (e) {
    if (e.code === 'BUSY') return res.status(409).json({ error: 'ingest already running', progress: ingestSnapshot() });
    res.status(500).json({ error: e.message });
  }
});

// Analyze all raw items still in 'new' status (catches items that were ingested
// before AI was enabled, or whose previous analyze failed). Optionally scoped to a product.
app.post('/api/ingest/analyze-pending', async (req, res) => {
  if (analyzeJob.running) {
    return res.status(409).json({ error: 'analysis already running', progress: progressSnapshot() });
  }
  const product_id = req.body?.product_id;
  const limit = Math.max(1, Math.min(500, +(req.body?.limit) || 100));
  // If caller passes an explicit ids array (e.g. Feed page passes only the
  // competitor items it's showing), honor it — but still filter to status='new'
  // so we never re-analyze already-done items.
  const requestedIds = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : null;
  let ids;
  if (requestedIds && requestedIds.length) {
    const placeholders = requestedIds.map(() => '?').join(',');
    ids = db.prepare(`SELECT id FROM raw_items WHERE status = 'new' AND id IN (${placeholders}) ORDER BY id ASC LIMIT ?`)
      .all(...requestedIds, limit).map(r => r.id);
  } else {
    // Match the same filter as /api/raw-items/pending-count so the loader's
    // total stays consistent with the badge: only competitor product items
    // (skip analyst firms, industry-news firms, and our own product).
    const params = [];
    let where = `WHERE ri.status = 'new'
                   AND (p.kind IS NULL OR p.kind = 'product')
                   AND COALESCE(p.is_own, 0) = 0`;
    if (product_id) { where += ' AND ri.product_id = ?'; params.push(product_id); }
    params.push(limit);
    ids = db.prepare(`SELECT ri.id FROM raw_items ri
                      JOIN products p ON p.id = ri.product_id
                      ${where} ORDER BY ri.id ASC LIMIT ?`).all(...params).map(r => r.id);
  }
  if (ids.length === 0) return res.json({ analyzed: 0, requirements: 0, releases: 0, errors: 0, pending: 0 });
  const result = await autoAnalyzeIds(ids);
  // Recount pending using the same filter.
  const remParams = [];
  let remWhere = `WHERE ri.status = 'new'
                    AND (p.kind IS NULL OR p.kind = 'product')
                    AND COALESCE(p.is_own, 0) = 0`;
  if (product_id) { remWhere += ' AND ri.product_id = ?'; remParams.push(product_id); }
  const remaining = db.prepare(`SELECT COUNT(*) as n FROM raw_items ri
                                JOIN products p ON p.id = ri.product_id
                                ${remWhere}`).get(...remParams).n;
  res.json({ ...result, pending: remaining });
});

// === Analyze logic (reusable from ingest auto-analyze) ===
async function analyzeRawItem(itemId) {
  const item = db.prepare('SELECT * FROM raw_items WHERE id = ?').get(itemId);
  if (!item) throw new Error('Not found');
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
  const own = db.prepare('SELECT * FROM products WHERE is_own = 1').get();
  const ourFeatures = db.prepare(`
    SELECT f.* FROM features f
    JOIN product_features pf ON pf.feature_id = f.id
    WHERE pf.product_id = ? AND pf.supported = 1`).all(own?.id || 0);

  const extracted = await extractFeatures(item, product.name);
  let releaseId = null;
  // Only real products have releases. Skip auto-creating release rows for
  // analyst firms and news sources — their items live in the Feed sub-tabs,
  // not under Releases.
  const isProductKind = !product.kind || product.kind === 'product';
  if (isProductKind && (extracted.version || extracted.release_date)) {
    const r = db.prepare(`INSERT INTO releases (product_id, version, release_date, highlights, url, auto_generated, raw_item_id) VALUES (?,?,?,?,?,1,?)`).run(
      product.id,
      extracted.version || 'unknown',
      extracted.release_date || null,
      extracted.release_summary || item.title,
      extracted.release_url || item.url || '',
      item.id,
    );
    releaseId = r.lastInsertRowid;
  }

  const created_requests = [];
  const isHttpUrl = (s) => typeof s === 'string' && /^https?:\/\/\S+$/i.test(s.trim());
  for (const f of (extracted.features || [])) {
    const score = await scoreImplementability(f, own?.name || 'our product', ourFeatures);
    if (score?.is_gap === false) continue;
    let featureRow = db.prepare('SELECT * FROM features WHERE LOWER(name) = LOWER(?)').get(f.name);
    if (!featureRow) {
      const r = db.prepare('INSERT INTO features (name, category, description) VALUES (?,?,?)').run(f.name, f.category || 'Other', f.summary || '');
      featureRow = { id: r.lastInsertRowid, name: f.name, category: f.category };
    }
    // Per-feature evidence URL: prefer LLM-extracted source_url, fall back to article URL.
    const featureUrl = isHttpUrl(f.source_url) ? f.source_url.trim() : (item.url || '');
    // Upsert: refresh notes only when it's empty OR previously stored a URL (auto value).
    // Manually-curated text notes are preserved.
    const existing = db.prepare('SELECT notes FROM product_features WHERE product_id = ? AND feature_id = ?').get(product.id, featureRow.id);
    const keepNotes = existing && existing.notes && existing.notes.trim() && !isHttpUrl(existing.notes);
    db.prepare(`INSERT INTO product_features (product_id, feature_id, supported, since_version, notes)
                VALUES (?, ?, 1, ?, ?)
                ON CONFLICT(product_id, feature_id) DO UPDATE SET
                  supported = 1,
                  since_version = COALESCE(excluded.since_version, product_features.since_version),
                  notes = CASE WHEN ? = 1 THEN product_features.notes ELSE excluded.notes END`).run(
      product.id, featureRow.id, extracted.version || null, featureUrl,
      keepNotes ? 1 : 0);
    const fr = db.prepare(`INSERT INTO feature_requests
      (feature_id, title, source_product_id, priority, status, notes, confidence, effort, rationale, auto_generated, raw_item_id)
      VALUES (?,?,?,?,?,?,?,?,?,1,?)`).run(
      featureRow.id, f.name, product.id,
      (score?.confidence ?? 50) >= 70 ? 'high' : (score?.confidence ?? 50) >= 40 ? 'medium' : 'low',
      'open', f.summary || '',
      score?.confidence ?? null, score?.effort ?? null, score?.rationale ?? null,
      item.id);
    created_requests.push({ id: fr.lastInsertRowid, name: f.name, confidence: score?.confidence, recommendation: score?.recommendation, source_url: featureUrl });
  }

  const analysis = { extracted, created_requests, release_id: releaseId };
  db.prepare(`UPDATE raw_items SET status = 'analyzed', analysis_json = ? WHERE id = ?`).run(JSON.stringify(analysis), item.id);
  return analysis;
}

// Live-progress tracker for AI analysis batches. Single-tenant local app, so
// one in-memory job slot is fine. The UI polls /api/ingest/analyze-progress
// while the job is running so the user can see a progress bar.
const analyzeJob = {
  running: false,
  total: 0,
  done: 0,
  analyzed: 0,
  errors: 0,
  releases: 0,
  requirements: 0,
  currentId: null,
  currentTitle: '',
  startedAt: null,
  finishedAt: null,
  lastError: null,
  lastErrorKind: null, // 'rate_limit' | 'auth' | 'network' | 'other'
  abortRequested: false,
};
function classifyError(msg) {
  if (!msg) return 'other';
  const m = msg.toLowerCase();
  if (m.includes('429') || m.includes('rate limit') || m.includes('too many requests')) return 'rate_limit';
  if (m.includes('401') || m.includes('403') || m.includes('unauthor') || m.includes('forbidden')) return 'auth';
  if (m.includes('llm_not_configured')) return 'no_token';
  if (m.includes('timeout') || m.includes('econnreset') || m.includes('enotfound') || m.includes('network')) return 'network';
  return 'other';
}
function resetAnalyzeJob(total) {
  analyzeJob.running = true;
  analyzeJob.total = total;
  analyzeJob.done = 0;
  analyzeJob.analyzed = 0;
  analyzeJob.errors = 0;
  analyzeJob.releases = 0;
  analyzeJob.requirements = 0;
  analyzeJob.currentId = null;
  analyzeJob.currentTitle = '';
  analyzeJob.startedAt = Date.now();
  analyzeJob.finishedAt = null;
  analyzeJob.lastError = null;
  analyzeJob.lastErrorKind = null;
  analyzeJob.abortRequested = false;
}
function progressSnapshot() {
  const elapsed_ms = analyzeJob.startedAt ? (analyzeJob.finishedAt || Date.now()) - analyzeJob.startedAt : 0;
  const rate = analyzeJob.done > 0 && elapsed_ms > 0 ? analyzeJob.done / (elapsed_ms / 1000) : 0;
  const remaining = Math.max(0, analyzeJob.total - analyzeJob.done);
  const eta_ms = rate > 0 ? Math.round(remaining / rate * 1000) : null;
  return {
    kind: 'analyze',
    running: analyzeJob.running,
    total: analyzeJob.total,
    done: analyzeJob.done,
    analyzed: analyzeJob.analyzed,
    errors: analyzeJob.errors,
    releases: analyzeJob.releases,
    requirements: analyzeJob.requirements,
    currentId: analyzeJob.currentId,
    currentTitle: analyzeJob.currentTitle,
    startedAt: analyzeJob.startedAt,
    finishedAt: analyzeJob.finishedAt,
    elapsed_ms,
    eta_ms,
    percent: analyzeJob.total > 0 ? Math.round((analyzeJob.done / analyzeJob.total) * 100) : 0,
    lastError: analyzeJob.lastError,
    lastErrorKind: analyzeJob.lastErrorKind,
    abortRequested: analyzeJob.abortRequested,
  };
}

// Live-progress tracker for ingest polling (run-all of RSS/HTML sources).
const ingestJob = {
  running: false, total: 0, done: 0, fetched: 0, inserted: 0, errors: 0,
  currentSourceId: null, currentSourceName: '',
  startedAt: null, finishedAt: null, lastError: null, lastErrorKind: null,
};
function resetIngestJob(total) {
  ingestJob.running = true; ingestJob.total = total; ingestJob.done = 0;
  ingestJob.fetched = 0; ingestJob.inserted = 0; ingestJob.errors = 0;
  ingestJob.currentSourceId = null; ingestJob.currentSourceName = '';
  ingestJob.startedAt = Date.now(); ingestJob.finishedAt = null;
  ingestJob.lastError = null; ingestJob.lastErrorKind = null;
}
function ingestSnapshot() {
  const elapsed_ms = ingestJob.startedAt ? (ingestJob.finishedAt || Date.now()) - ingestJob.startedAt : 0;
  const rate = ingestJob.done > 0 && elapsed_ms > 0 ? ingestJob.done / (elapsed_ms / 1000) : 0;
  const remaining = Math.max(0, ingestJob.total - ingestJob.done);
  const eta_ms = rate > 0 ? Math.round(remaining / rate * 1000) : null;
  return {
    kind: 'ingest',
    running: ingestJob.running,
    total: ingestJob.total, done: ingestJob.done,
    fetched: ingestJob.fetched, inserted: ingestJob.inserted, errors: ingestJob.errors,
    currentSourceId: ingestJob.currentSourceId, currentSourceName: ingestJob.currentSourceName,
    startedAt: ingestJob.startedAt, finishedAt: ingestJob.finishedAt,
    elapsed_ms, eta_ms,
    percent: ingestJob.total > 0 ? Math.round((ingestJob.done / ingestJob.total) * 100) : 0,
    lastError: ingestJob.lastError, lastErrorKind: ingestJob.lastErrorKind,
  };
}

app.get('/api/ingest/analyze-progress', (req, res) => res.json(progressSnapshot()));
app.post('/api/ingest/analyze-abort', (req, res) => {
  if (!analyzeJob.running) return res.json({ ok: false, reason: 'not_running' });
  analyzeJob.abortRequested = true;
  res.json({ ok: true });
});
app.get('/api/ingest/run-all-progress', (req, res) => res.json(ingestSnapshot()));
app.get('/api/ingest/all-progress', (req, res) => res.json({
  ingest: ingestSnapshot(),
  analyze: progressSnapshot(),
}));

async function autoAnalyzeIds(ids) {
  const out = { analyzed: 0, requirements: 0, releases: 0, errors: 0, aborted: false, lastErrorKind: null, lastError: null };
  // Initialize the live-progress job. (For tiny ad-hoc batches — e.g. one new
  // item from a fresh ingest — we still report progress; UI just won't poll.)
  resetAnalyzeJob(ids.length);
  // Early-abort: if we hit several rate-limit errors in a row, retrying the
  // remaining items will just produce more 429s and waste the user's time.
  // Stop and surface the error instead.
  let consecutiveRateLimits = 0;
  const RATE_LIMIT_ABORT_THRESHOLD = 3;
  try {
    for (const id of ids) {
      if (analyzeJob.abortRequested) {
        out.aborted = true;
        analyzeJob.lastError = `Stopped by user. ${ids.length - analyzeJob.done} item${ids.length - analyzeJob.done === 1 ? '' : 's'} not analyzed.`;
        analyzeJob.lastErrorKind = 'aborted';
        out.lastErrorKind = 'aborted';
        out.lastError = analyzeJob.lastError;
        break;
      }
      analyzeJob.currentId = id;
      try {
        const titleRow = db.prepare('SELECT title FROM raw_items WHERE id = ?').get(id);
        analyzeJob.currentTitle = (titleRow?.title || '').slice(0, 120);
      } catch (_) {}
      try {
        const a = await analyzeRawItem(id);
        out.analyzed++;
        analyzeJob.analyzed++;
        const reqs = (a.created_requests || []).length;
        out.requirements += reqs;
        analyzeJob.requirements += reqs;
        if (a.release_id) { out.releases++; analyzeJob.releases++; }
        consecutiveRateLimits = 0;
      } catch (e) {
        out.errors++;
        analyzeJob.errors++;
        analyzeJob.lastError = e.message;
        const kind = classifyError(e.message);
        analyzeJob.lastErrorKind = kind;
        out.lastErrorKind = kind;
        out.lastError = e.message;
        if (kind === 'rate_limit') consecutiveRateLimits++;
        else consecutiveRateLimits = 0;
        console.error('auto-analyze failed for', id, e.message);
        if (consecutiveRateLimits >= RATE_LIMIT_ABORT_THRESHOLD) {
          out.aborted = true;
          analyzeJob.lastError = `Aborted after ${consecutiveRateLimits} consecutive rate-limit errors. ${ids.length - analyzeJob.done - 1} items not attempted. Wait a few minutes and retry — already-analyzed items are kept.`;
          analyzeJob.done++;
          break;
        }
        // For non-rate-limit failures (or until threshold), pace ourselves a
        // bit so we don't hammer the API on a partial outage.
        if (kind === 'rate_limit') await new Promise(r => setTimeout(r, 1500));
      }
      analyzeJob.done++;
    }
  } finally {
    analyzeJob.running = false;
    analyzeJob.finishedAt = Date.now();
    analyzeJob.currentId = null;
    analyzeJob.currentTitle = '';
  }
  return out;
}

// Analyze a raw item: extract features, score, persist as release + auto feature_requests
app.post('/api/raw-items/:id/analyze', async (req, res) => {
  try { res.json(await analyzeRawItem(+req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Hourly scheduler ────────────────────────────────────────────────────────
// Polls each category at a different offset within the hour so they never run
// concurrently — concurrent runs would compete for the same LLM tokens and
// burn through the per-minute rate-limit. Slots:
//   :00  catalog (own + competitor products)
//   :20  analyst firms
//   :40  industry news
// Each run respects ingestJob.running and skips if a job is in progress.
const SCHEDULER_KINDS = [
  { key: 'catalog',  label: 'Catalog (products)', product_kind: 'product', minute: 0 },
  { key: 'analysts', label: 'Analyst firms',      product_kind: 'analyst', minute: 20 },
  { key: 'industry', label: 'Industry news',      product_kind: 'news',    minute: 40 },
  // Daily SPOC sheet sync. `hour` makes the slot daily-at-HH:MM instead of hourly-at-:MM.
  { key: 'spoc',     label: 'SPOC sheet sync',    minute: 10, hour: 0,
    run: async () => spoc.runImport() },
  // Daily Feature Request sheet sync (10 min after SPOC).
  { key: 'feature_requests', label: 'Feature Request sheet sync', minute: 20, hour: 0,
    run: async () => featureRequests.runImport() },
  // Daily digest email. Defaults to 00:15 IST (right after SPOC sync at 00:10)
  // so the digest covers the freshly-imported sheet. The fire time is editable
  // from Settings → Email digest; the getters below read from `settings` on
  // every scheduler tick, so changes apply without a restart.
  { key: 'digest',   label: 'Daily digest email',
    get minute() { const v = +readSettingRaw('mail_digest_minute'); return Number.isFinite(v) ? v : 15; },
    get hour()   { const v = +readSettingRaw('mail_digest_hour');   return Number.isFinite(v) ? v : 0; },
    run: async () => {
      if (!mailer.isConfigured()) return { skipped: true, reason: 'mailer not configured' };
      const to = getDailyRecipients();
      if (!to || !String(to).trim()) return { skipped: true, reason: 'no recipients saved' };
      const d = dailyDigest.build();
      const r = await mailer.sendMail({ to: to.split(',').map(s => s.trim()).filter(Boolean),
        subject: d.subject, html: d.html });
      return { sent: true, to, messageId: r.messageId || null, ...d.stats };
    } },
];

function schedulerSettingKey(jobKey, field) { return `scheduler_${jobKey}_${field}`; }
function readJson(key) { try { const v = db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value; return v ? JSON.parse(v) : null; } catch (_) { return null; } }
function writeJson(key, val) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).run(key, JSON.stringify(val));
}
function readSettingRaw(key) { try { return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || null; } catch (_) { return null; } }
function writeSettingRaw(key, val) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).run(key, String(val));
}

function nextRunFor(job) {
  const jobMinute = typeof job === 'object' ? job.minute : job;
  const jobHour = (typeof job === 'object' && Number.isInteger(job.hour)) ? job.hour : null;
  const now = new Date();
  const next = new Date(now);
  if (jobHour != null) {
    next.setHours(jobHour, jobMinute, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  } else {
    next.setMinutes(jobMinute, 0, 0);
    if (next.getTime() <= now.getTime()) next.setHours(next.getHours() + 1);
  }
  return next.getTime();
}

function schedulerEnabled() { return readSettingRaw('scheduler_enabled') === '1'; }
function setSchedulerEnabled(on) { writeSettingRaw('scheduler_enabled', on ? '1' : '0'); }

// Build the scheduler `lastresult` payload for a given scheduler kind from a
// raw ingestRunAll() output. If `productKind` is supplied, only results whose
// source belongs to a product of that kind are counted (so manual run-all
// invocations that span multiple kinds can refresh each scheduler row
// independently). Analyze stats are attributed only to the 'product' kind
// since autoAnalyzeIds() skips analyst/news items.
function buildSchedulerPayloadFromIngest({ startedAt, out, productKind }) {
  const allResults = out.results || [];
  const allIds = allResults.map(r => r.source_id).filter(x => x != null);
  const srcRows = allIds.length
    ? db.prepare(`SELECT s.id, s.label, s.url, p.name AS product_name, COALESCE(p.kind,'product') AS kind
                  FROM sources s JOIN products p ON p.id = s.product_id
                  WHERE s.id IN (${allIds.map(() => '?').join(',')})`).all(...allIds)
    : [];
  const byId = Object.fromEntries(srcRows.map(r => [r.id, r]));
  const filtered = productKind
    ? allResults.filter(r => (byId[r.source_id]?.kind || 'product') === productKind)
    : allResults;
  if (!filtered.length) return null;
  const inserted = filtered.reduce((a, r) => a + (r.inserted || 0), 0);
  const errorResults = filtered.filter(r => r.error);
  const errorDetails = errorResults.map(r => {
    const s = byId[r.source_id] || {};
    return {
      source_id: r.source_id,
      source: s.label || s.url || `source #${r.source_id}`,
      product: s.product_name || '',
      message: String(r.error || '').slice(0, 500),
    };
  });
  const analyzeApplies = productKind === 'product' || productKind == null;
  return {
    startedAt, finishedAt: Date.now(),
    sources: filtered.length, inserted, errors: errorResults.length,
    analyzed: analyzeApplies ? (out.analysis?.analyzed || 0) : 0,
    requirements: analyzeApplies ? (out.analysis?.requirements || 0) : 0,
    releases: analyzeApplies ? (out.analysis?.releases || 0) : 0,
    aborted: analyzeApplies ? (out.analysis?.aborted || false) : false,
    errorDetails,
  };
}

// Refresh scheduler `lastresult`/`lastrun` for every scheduler kind covered by
// a manual /api/ingest/run-all invocation. This keeps the Scheduler UI in sync
// with manual reruns so a previous error doesn't linger after a clean retry.
function refreshSchedulerResultsFromIngest({ startedAt, out, productKind }) {
  const targets = SCHEDULER_KINDS
    .filter(j => typeof j.run !== 'function')
    .filter(j => !productKind || j.product_kind === productKind);
  for (const job of targets) {
    const payload = buildSchedulerPayloadFromIngest({
      startedAt, out, productKind: job.product_kind,
    });
    if (!payload) continue;
    writeJson(schedulerSettingKey(job.key, 'lastresult'), payload);
    writeSettingRaw(schedulerSettingKey(job.key, 'lastrun'), String(startedAt));
  }
}

async function runScheduledJob(job) {
  const startedAt = Date.now();
  // Concurrency skip: don't persist lastrun so the job retries on the next tick.
  // Custom jobs (e.g. SPOC) don't touch the ingest/analyze pipelines so they
  // can run alongside other work.
  if (typeof job.run !== 'function' && (ingestJob.running || analyzeJob.running)) {
    writeJson(schedulerSettingKey(job.key, 'lastresult'), {
      startedAt, finishedAt: Date.now(), skipped: true, reason: 'another job running',
    });
    return;
  }
  try {
    if (typeof job.run === 'function') {
      // Custom job (e.g. SPOC). The job handler returns its own result payload
      // which we just persist verbatim alongside the standard timing fields.
      const custom = await job.run();
      writeJson(schedulerSettingKey(job.key, 'lastresult'), {
        startedAt, finishedAt: Date.now(), ...(custom || {}),
      });
      console.log(`[scheduler] ${job.key}:`, JSON.stringify(custom || {}));
      return;
    }
    const out = await ingestRunAll({ product_kind: job.product_kind, auto: true });
    const payload = buildSchedulerPayloadFromIngest({
      startedAt, out, productKind: job.product_kind,
    }) || { startedAt, finishedAt: Date.now(), sources: 0, inserted: 0, errors: 0,
            analyzed: 0, requirements: 0, releases: 0, aborted: false, errorDetails: [] };
    writeJson(schedulerSettingKey(job.key, 'lastresult'), payload);
    console.log(`[scheduler] ${job.key}: ${payload.sources} sources · ${payload.inserted} new · ${payload.analyzed} analyzed${payload.errors?` · ${payload.errors} err`:''}`);
  } catch (e) {
    writeJson(schedulerSettingKey(job.key, 'lastresult'), {
      startedAt, finishedAt: Date.now(), error: e.message || String(e),
    });
    console.error(`[scheduler] ${job.key} failed:`, e.message);
  } finally {
    writeSettingRaw(schedulerSettingKey(job.key, 'lastrun'), String(startedAt));
  }
}

// Most recent slot time (<= now) for a scheduled job. If `hour` is defined the
// slot is daily at HH:MM; otherwise hourly at :MM.
function mostRecentSlot(job, now = new Date()) {
  const jobMinute = typeof job === 'object' ? job.minute : job;
  const jobHour = (typeof job === 'object' && Number.isInteger(job.hour)) ? job.hour : null;
  const slot = new Date(now);
  if (jobHour != null) {
    slot.setHours(jobHour, jobMinute, 0, 0);
    if (slot.getTime() > now.getTime()) slot.setDate(slot.getDate() - 1);
  } else {
    slot.setMinutes(jobMinute, 0, 0);
    if (slot.getTime() > now.getTime()) slot.setHours(slot.getHours() - 1);
  }
  return slot.getTime();
}

let schedulerTimer = null;
function schedulerTick() {
  schedulerTimer = setTimeout(schedulerTick, 60 * 1000); // every minute
  // Housekeeping: any LLM token whose `exhausted_until` has elapsed gets its
  // exhausted_until / last_error cleared so the UI flips back to 'active'
  // without a manual Reset click. The token would already be reused on the
  // next call (pickActiveTokenRow only blocks while exhausted_until > now);
  // this just keeps the bookkeeping honest.
  try {
    const cleared = llm.autoReleaseExpired();
    if (cleared) console.log(`[scheduler] auto-released ${cleared} expired LLM token(s)`);
  } catch (e) { console.warn('[scheduler] autoReleaseExpired failed:', e.message); }
  if (!schedulerEnabled()) return;
  const now = Date.now();
  // Fire any job whose most-recent slot hasn't been served yet. This both
  // handles the normal on-the-minute case AND catches up after the process
  // was down across a slot. To avoid running all three jobs concurrently after
  // a long downtime, fire at most one per tick — the next missed job will run
  // on the following minute's tick.
  for (const job of SCHEDULER_KINDS) {
    const slot = mostRecentSlot(job);
    const last = +readSettingRaw(schedulerSettingKey(job.key, 'lastrun')) || 0;
    if (last >= slot) continue; // already ran for this slot
    // Debounce against double-fire inside the same minute.
    if (now - last < 55 * 1000) continue;
    runScheduledJob(job); // fire and forget
    break;
  }
}
// Start the heartbeat. Run one tick almost immediately on startup so any
// missed slots are picked up without waiting up to a minute, then align the
// recurring heartbeat to the top of the next minute.
setTimeout(() => schedulerTick(), 2_000);

app.get('/api/scheduler/status', (req, res) => {
  const enabled = schedulerEnabled();
  res.json({
    enabled,
    jobs: SCHEDULER_KINDS.map(j => {
      const last = +readSettingRaw(schedulerSettingKey(j.key, 'lastrun')) || null;
      const result = readJson(schedulerSettingKey(j.key, 'lastresult'));
      return {
        key: j.key,
        label: j.label,
        product_kind: j.product_kind,
        minute: j.minute,
        lastRun: last,
        nextRun: enabled ? nextRunFor(j) : null,
        lastResult: result,
      };
    }),
  });
});

app.post('/api/scheduler/toggle', (req, res) => {
  const on = req.body?.enabled !== false;
  setSchedulerEnabled(on);
  res.json({ enabled: on });
});

app.post('/api/scheduler/run-now/:key', async (req, res) => {
  const job = SCHEDULER_KINDS.find(j => j.key === req.params.key);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  if (typeof job.run !== 'function' && (ingestJob.running || analyzeJob.running)) {
    return res.status(409).json({ error: 'another job is running' });
  }
  // Fire and forget; client polls /api/ingest/all-progress for live status.
  runScheduledJob(job);
  res.json({ ok: true });
});

// ─── Mailer / Daily digest ───────────────────────────────────────────────────
// Recipient list is editable from the UI and persisted in `settings`. We fall
// back to the ZOHO_MAIL_DAILY_TO env var when nothing is saved yet so a fresh
// install still works.
function getDailyRecipients() {
  const saved = readSettingRaw('mail_daily_to');
  if (saved != null && saved !== '') return saved;
  return process.env.ZOHO_MAIL_DAILY_TO || '';
}
function setDailyRecipients(v) {
  writeSettingRaw('mail_daily_to', String(v == null ? '' : v).trim());
}
function getDigestTime() {
  const h = +readSettingRaw('mail_digest_hour');
  const m = +readSettingRaw('mail_digest_minute');
  return {
    hour:   Number.isFinite(h) ? h : 0,
    minute: Number.isFinite(m) ? m : 15,
  };
}
function setDigestTime(hour, minute) {
  const h = Math.max(0, Math.min(23, Math.trunc(+hour)));
  const m = Math.max(0, Math.min(59, Math.trunc(+minute)));
  writeSettingRaw('mail_digest_hour', String(h));
  writeSettingRaw('mail_digest_minute', String(m));
  return { hour: h, minute: m };
}
function parseDigestTime(raw) {
  // Accept "HH:MM" or { hour, minute }.
  if (raw && typeof raw === 'object' && raw.hour != null && raw.minute != null) {
    return { hour: +raw.hour, minute: +raw.minute };
  }
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return { hour: +m[1], minute: +m[2] };
}
app.get('/api/mail/status', (_req, res) => {
  const dailyTo = getDailyRecipients();
  const time = getDigestTime();
  res.json({
    configured: mailer.isConfigured(),
    from: process.env.ZOHO_MAIL_FROM || null,
    accountId: process.env.ZOHO_MAIL_ACCOUNT_ID || null,
    dailyTo,
    recipients: dailyTo ? dailyTo.split(',').map(s => s.trim()).filter(Boolean) : [],
    digestTime: `${String(time.hour).padStart(2,'0')}:${String(time.minute).padStart(2,'0')}`,
    digestHour: time.hour,
    digestMinute: time.minute,
  });
});
app.put('/api/mail/settings', (req, res) => {
  const body = req.body || {};
  // Recipients (optional on this call — only updated when provided).
  if (body.dailyTo != null || body.recipients != null) {
    const to = body.dailyTo != null ? body.dailyTo : body.recipients;
    const joined = Array.isArray(to) ? to.join(',') : String(to);
    const entries = joined.split(',').map(s => s.trim()).filter(Boolean);
    const bad = entries.filter(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if (bad.length) return res.status(400).json({ error: `invalid email(s): ${bad.join(', ')}` });
    setDailyRecipients(entries.join(','));
  }
  // Digest time (optional on this call).
  if (body.digestTime != null || (body.digestHour != null && body.digestMinute != null)) {
    const parsed = body.digestTime != null
      ? parseDigestTime(body.digestTime)
      : { hour: +body.digestHour, minute: +body.digestMinute };
    if (!parsed || !Number.isFinite(parsed.hour) || !Number.isFinite(parsed.minute)
        || parsed.hour < 0 || parsed.hour > 23 || parsed.minute < 0 || parsed.minute > 59) {
      return res.status(400).json({ error: 'digestTime must be "HH:MM" (00:00 — 23:59)' });
    }
    setDigestTime(parsed.hour, parsed.minute);
  }
  const dailyTo = getDailyRecipients();
  const time = getDigestTime();
  res.json({
    ok: true,
    dailyTo,
    recipients: dailyTo ? dailyTo.split(',').map(s => s.trim()).filter(Boolean) : [],
    digestTime: `${String(time.hour).padStart(2,'0')}:${String(time.minute).padStart(2,'0')}`,
    digestHour: time.hour,
    digestMinute: time.minute,
  });
});
app.get('/api/mail/digest/preview', (_req, res) => {
  try {
    const d = dailyDigest.build();
    res.set('Content-Type', 'text/html; charset=utf-8').send(d.html);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/mail/digest/send-now', async (req, res) => {
  try {
    if (!mailer.isConfigured()) return res.status(400).json({ error: 'mailer not configured (ZOHO_MAIL_* env vars)' });
    const toRaw = (req.body && req.body.to) || getDailyRecipients();
    if (!toRaw || !String(toRaw).trim()) return res.status(400).json({ error: 'no recipient (body.to or saved recipients)' });
    const d = dailyDigest.build();
    const r = await mailer.sendMail({
      to: String(toRaw).split(',').map(s => s.trim()).filter(Boolean),
      subject: d.subject, html: d.html,
    });
    res.json({ ok: true, messageId: r.messageId || null, to: toRaw, stats: d.stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/mail/send', async (req, res) => {
  try {
    const { to, cc, bcc, subject, html, text } = req.body || {};
    const r = await mailer.sendMail({ to, cc, bcc, subject, html, text });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Confirmed send for the chatbot's email tools (send_chat_transcript and
// send_daily_digest). The browser posts the cached confirmation payload here
// after the user clicks "Confirm" in the inline dialog. Bypasses the LLM
// entirely — we just call the underlying tool with confirmed=true.
app.post('/api/mail/confirm-send', async (req, res) => {
  try {
    const { tool, to, subject, note, hours, sections, messages } = req.body || {};
    const toolName = tool === 'send_daily_digest' ? 'send_daily_digest' : 'send_chat_transcript';
    const args = toolName === 'send_daily_digest'
      ? { to, hours: hours || 24, sections: Array.isArray(sections) ? sections : undefined, confirmed: true }
      : { to, subject, note, confirmed: true };
    const result = await chatTools.runTool(
      toolName,
      args,
      { messages: Array.isArray(messages) ? messages : [], getDailyRecipients },
    );
    if (result && result.error) return res.status(400).json(result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Legacy alias kept for any in-flight clients.
app.post('/api/mail/send-transcript', async (req, res) => {
  try {
    const { to, subject, note, messages } = req.body || {};
    const result = await chatTools.runTool(
      'send_chat_transcript',
      { to, subject, note, confirmed: true },
      { messages: Array.isArray(messages) ? messages : [], getDailyRecipients },
    );
    if (result && result.error) return res.status(400).json(result);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- SPOC ----------
app.get('/api/spoc', (req, res) => {
  try {
    const out = spoc.listEntries({
      q: req.query.q || '',
      sheet: req.query.sheet || '',
      from: req.query.from || '',
      to: req.query.to || '',
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/spoc/imports', (req, res) => {
  try { res.json({ items: spoc.listImports({ limit: req.query.limit }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/spoc/summary', (req, res) => {
  try { res.json(spoc.summary()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/spoc/inbox', (req, res) => {
  try { res.json(spoc.inboxStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/spoc/url', (req, res) => {
  try {
    const url = (req.body && typeof req.body.url === 'string') ? req.body.url.trim() : '';
    spoc.setDownloadUrl(url);
    res.json({ ok: true, downloadUrl: spoc.getDownloadUrl() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/spoc/me', (req, res) => {
  res.json({ me: spoc.getMe() });
});
app.post('/api/spoc/me', (req, res) => {
  try {
    const me = (req.body && typeof req.body.me === 'string') ? req.body.me.trim() : '';
    spoc.setMe(me);
    res.json({ ok: true, me: spoc.getMe() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/spoc/ack', (req, res) => {
  try {
    const { ackKey, person, status } = req.body || {};
    res.json(spoc.setAck({ ackKey, person, status }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/spoc/import-now', async (req, res) => {
  const force = !!(req.body && req.body.force);
  // Background-job model so the UI can render a progress bar instead of just
  // a spinner. The handler returns { jobId } immediately; the client polls
  // /api/spoc/import-status/:jobId every ~500ms until status === 'done' or
  // 'error'. Job records live in memory and are auto-evicted after 5 min.
  const jobId = `spoc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id: jobId,
    status: 'running',
    stage: 'start',
    pct: 0,
    detail: 'queued',
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
    log: [],
  };
  spocJobs.set(jobId, job);
  // Fire-and-forget. Errors are caught and stored on the job.
  (async () => {
    try {
      const result = await spoc.runImport({
        force,
        onProgress: (stage, pct, detail) => {
          job.stage = stage;
          if (typeof pct === 'number') job.pct = Math.max(job.pct, Math.min(100, Math.round(pct)));
          if (detail) {
            job.detail = detail;
            job.log.push({ t: Date.now(), stage, pct: job.pct, detail });
            if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
          }
        },
      });
      job.result = result;
      job.status = result && result.error ? 'error' : 'done';
      if (result && result.error) job.error = result.error;
      job.pct = 100;
      job.stage = job.status === 'error' ? 'error' : 'done';
      job.finishedAt = Date.now();
    } catch (e) {
      job.status = 'error';
      job.stage = 'error';
      job.error = e.message;
      job.detail = e.message;
      job.pct = 100;
      job.finishedAt = Date.now();
    } finally {
      // Evict 5 minutes after completion so memory doesn't grow.
      setTimeout(() => spocJobs.delete(jobId), 5 * 60 * 1000).unref?.();
    }
  })();
  // Optional synchronous mode for scripts/tests: ?wait=1 blocks until done.
  if (req.query.wait === '1') {
    const poll = () => new Promise(r => setTimeout(r, 200));
    while (job.status === 'running') await poll();
    return res.json({ jobId, ...job });
  }
  res.json({ jobId, status: job.status, stage: job.stage, pct: job.pct, detail: job.detail });
});

app.get('/api/spoc/import-status/:jobId', (req, res) => {
  const job = spocJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'unknown jobId (may have expired)' });
  res.json({
    id: job.id,
    status: job.status,
    stage: job.stage,
    pct: job.pct,
    detail: job.detail,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.status === 'done' ? job.result : null,
    error: job.error,
    log: job.log.slice(-20),
  });
});

// ---------- Feature Requests ----------
// Mirrors the SPOC routes 1:1 — same shape so the UI can reuse the SPOC
// settings/dashboard components with just a path swap.
app.get('/api/fr', (req, res) => {
  try {
    res.json(featureRequests.listEntries({
      q: req.query.q || '',
      sheet: req.query.sheet || '',
      from: req.query.from || '',
      to: req.query.to || '',
      limit: req.query.limit,
      offset: req.query.offset,
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fr/imports', (req, res) => {
  try { res.json({ items: featureRequests.listImports({ limit: req.query.limit }) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fr/summary', (req, res) => {
  try { res.json(featureRequests.summary()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fr/inbox', (req, res) => {
  try { res.json(featureRequests.inboxStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fr/url', (req, res) => {
  try {
    const url = (req.body && typeof req.body.url === 'string') ? req.body.url.trim() : '';
    featureRequests.setDownloadUrl(url);
    res.json({ ok: true, downloadUrl: featureRequests.getDownloadUrl() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fr/me', (req, res) => {
  res.json({ me: featureRequests.getMe() });
});
app.post('/api/fr/me', (req, res) => {
  try {
    const me = (req.body && typeof req.body.me === 'string') ? req.body.me.trim() : '';
    featureRequests.setMe(me);
    res.json({ ok: true, me: featureRequests.getMe() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/fr/ack', (req, res) => {
  try {
    const { ackKey, person, status } = req.body || {};
    res.json(featureRequests.setAck({ ackKey, person, status }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/fr/import-now', async (req, res) => {
  const force = !!(req.body && req.body.force);
  const jobId = `fr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id: jobId, status: 'running', stage: 'start', pct: 0, detail: 'queued',
    startedAt: Date.now(), finishedAt: null, result: null, error: null, log: [],
  };
  frJobs.set(jobId, job);
  (async () => {
    try {
      const result = await featureRequests.runImport({
        force,
        onProgress: (stage, pct, detail) => {
          job.stage = stage;
          if (typeof pct === 'number') job.pct = Math.max(job.pct, Math.min(100, Math.round(pct)));
          if (detail) {
            job.detail = detail;
            job.log.push({ t: Date.now(), stage, pct: job.pct, detail });
            if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
          }
        },
      });
      job.result = result;
      job.status = result && result.error ? 'error' : 'done';
      if (result && result.error) job.error = result.error;
      job.pct = 100;
      job.stage = job.status === 'error' ? 'error' : 'done';
      job.finishedAt = Date.now();
    } catch (e) {
      job.status = 'error'; job.stage = 'error'; job.error = e.message;
      job.detail = e.message; job.pct = 100; job.finishedAt = Date.now();
    } finally {
      setTimeout(() => frJobs.delete(jobId), 5 * 60 * 1000).unref?.();
    }
  })();
  if (req.query.wait === '1') {
    const poll = () => new Promise(r => setTimeout(r, 200));
    while (job.status === 'running') await poll();
    return res.json({ jobId, ...job });
  }
  res.json({ jobId, status: job.status, stage: job.stage, pct: job.pct, detail: job.detail });
});

app.get('/api/fr/import-status/:jobId', (req, res) => {
  const job = frJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'unknown jobId (may have expired)' });
  res.json({
    id: job.id, status: job.status, stage: job.stage, pct: job.pct, detail: job.detail,
    startedAt: job.startedAt, finishedAt: job.finishedAt,
    result: job.status === 'done' ? job.result : null,
    error: job.error,
    log: job.log.slice(-20),
  });
});

// SPA fallback: any non-API GET that isn't a static file -> serve index.html
// so client-side routes (/dashboard, /reports, /matrix, ...) work on direct hit / refresh.
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(require('path').join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PM Panel API on http://localhost:${PORT} (LLM: ${llm.hasToken() ? llm.getModel() : 'DISABLED — open Catalog → AI Settings'})`);
  // Write our PID so the wrapper script (pm-panel.bat / pm-panel.sh) can
  // reliably stop / status us without scanning for stray node.exe processes.
  try {
    const fs = require('fs');
    const path = require('path');
    const pidFile = process.env.PM_PANEL_PID_FILE || path.join(__dirname, 'pm-panel.pid');
    // Unlink first: on Windows, fs.writeFileSync to an existing file with the
    // Hidden attribute fails with EPERM. Removing first sidesteps that.
    try { fs.unlinkSync(pidFile); } catch (_) { /* not present */ }
    fs.writeFileSync(pidFile, String(process.pid));
    const cleanup = () => { try { fs.unlinkSync(pidFile); } catch (_) {} };
    process.on('exit', cleanup);
    process.on('SIGINT',  () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  } catch (e) {
    console.warn('Could not write PID file:', e.message);
  }
}).on('error', (err) => {
  console.error(`Failed to listen on port ${PORT}: ${err.code || ''} ${err.message}`);
  process.exit(1);
});
