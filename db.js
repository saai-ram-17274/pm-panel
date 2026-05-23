const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'pm-panel.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  is_own INTEGER NOT NULL DEFAULT 0,
  vendor TEXT,
  website TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  release_date TEXT,
  highlights TEXT,
  url TEXT
);

CREATE TABLE IF NOT EXISTS features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  category TEXT,
  description TEXT
);

CREATE TABLE IF NOT EXISTS product_features (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  supported INTEGER NOT NULL DEFAULT 0,
  since_version TEXT,
  notes TEXT,
  PRIMARY KEY (product_id, feature_id)
);

CREATE TABLE IF NOT EXISTS feature_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id INTEGER REFERENCES features(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  source_product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'open',
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  url TEXT,
  label TEXT,
  last_polled TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS raw_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  hash TEXT UNIQUE,
  title TEXT,
  url TEXT,
  content TEXT,
  published_at TEXT,
  fetched_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'new',
  analysis_json TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Multi-token fallback chain for the LLM. Tokens are tried in ascending
-- priority order; on rate-limit/auth failure a token is marked exhausted
-- until midnight (local server time). At the next chat call the chain
-- re-evaluates, so as soon as exhausted_until has passed the token is
-- eligible again.
CREATE TABLE IF NOT EXISTS llm_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  exhausted_until DATETIME,
  last_used_at DATETIME,
  last_error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

// Idempotent column additions for older DBs
const addCol = (table, col, def) => {
  try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run(); } catch (_) {}
};
addCol('feature_requests', 'confidence', 'INTEGER');
addCol('feature_requests', 'effort', 'TEXT');
addCol('feature_requests', 'rationale', 'TEXT');
addCol('feature_requests', 'auto_generated', 'INTEGER DEFAULT 0');
addCol('feature_requests', 'raw_item_id', 'INTEGER');
addCol('releases', 'auto_generated', 'INTEGER DEFAULT 0');
addCol('releases', 'raw_item_id', 'INTEGER');
addCol('products', 'kind', "TEXT DEFAULT 'product'"); // 'product' | 'analyst'
addCol('products', 'pros', 'TEXT');
addCol('products', 'cons', 'TEXT');
addCol('products', 'roadmap', 'TEXT');

// Analyst-firm conferences / industry events. Linked to a product row of
// kind='analyst' (and optionally 'news'). One row per event occurrence.
db.exec(`
CREATE TABLE IF NOT EXISTS conferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  region TEXT,           -- 'NA' | 'EMEA' | 'APAC' | 'Global'
  location TEXT,         -- 'National Harbor, MD' / 'Berlin, DE'
  start_date TEXT,       -- 'YYYY-MM-DD'
  end_date TEXT,
  url TEXT,
  topics TEXT,           -- free-form tags: 'SIEM, SOC, UEBA'
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS conferences_product_idx ON conferences(product_id);
CREATE INDEX IF NOT EXISTS conferences_start_idx ON conferences(start_date);
`);

// One-time: rename sample 'Our Product' → ManageEngine Log360 if still default
try {
  const our = db.prepare("SELECT id, name FROM products WHERE is_own = 1").get();
  if (our && our.name === 'Our Product') {
    db.prepare("UPDATE products SET name = 'ManageEngine Log360', vendor = 'ManageEngine', website = 'https://www.manageengine.com/log-management/', notes = 'Our flagship SIEM / log management platform' WHERE id = ?").run(our.id);
  }
} catch (_) {}

// Seed our second flagship: ManageEngine Log360 Cloud (idempotent).
try {
  const exists = db.prepare("SELECT id FROM products WHERE name = ?").get('ManageEngine Log360 Cloud');
  if (!exists) {
    db.prepare(`INSERT INTO products (name, is_own, vendor, website, notes, kind)
                VALUES (?, 1, ?, ?, ?, 'product')`).run(
      'ManageEngine Log360 Cloud',
      'ManageEngine',
      'https://www.manageengine.com/cloud-siem/',
      'Our cloud-native SIEM / log management offering (Log360 Cloud).'
    );
  }
} catch (_) {}

// Seed analyst firms (idempotent: insert only if not already present)
const ANALYSTS = [
  { name: 'Gartner',                vendor: 'Gartner Inc.',           website: 'https://www.gartner.com/en/cybersecurity', notes: 'Magic Quadrant, Critical Capabilities, Hype Cycle. Most reports paywalled — paste excerpts.' },
  { name: 'Forrester',              vendor: 'Forrester Research',      website: 'https://www.forrester.com/blogs/category/security-risk/', notes: 'Forrester Wave reports. Public blog has feed.' },
  { name: 'IDC',                    vendor: 'International Data Corp', website: 'https://blogs.idc.com/category/security-trust/', notes: 'IDC MarketScape, FutureScape. Limited public feed.' },
  { name: 'KuppingerCole',          vendor: 'KuppingerCole Analysts',  website: 'https://www.kuppingercole.com/blog', notes: 'European analyst firm, IAM/cyber focus. Public blog feed.' },
  { name: 'GigaOm',                 vendor: 'GigaOm',                  website: 'https://gigaom.com/research/', notes: 'GigaOm Radar reports. Some public, some paywalled.' },
  { name: 'ISG',                    vendor: 'ISG (Information Services Group)', website: 'https://isg-one.com/research/insights', notes: 'ISG Provider Lens. Limited public preview.' },
  { name: 'Omdia',                  vendor: 'Omdia',                   website: 'https://omdia.tech.informa.com/topic-pages/cybersecurity', notes: 'Omdia Universe. Mostly paywalled.' },
  { name: 'Everest Group',          vendor: 'Everest Group',           website: 'https://www.everestgrp.com/blog/', notes: 'PEAK Matrix reports. Public blog feed.' },
  { name: 'Constellation Research', vendor: 'Constellation Research',  website: 'https://www.constellationr.com/research', notes: 'ShortList reports. Some public.' },
];
const upsertAnalyst = db.prepare(`
  INSERT INTO products (name, is_own, vendor, website, notes, kind)
  VALUES (?, 0, ?, ?, ?, 'analyst')
  ON CONFLICT(name) DO UPDATE SET kind = 'analyst', vendor = excluded.vendor, website = excluded.website
`);
for (const a of ANALYSTS) upsertAnalyst.run(a.name, a.vendor, a.website, a.notes);

// No hardcoded conferences. Users add events through the UI (Conferences panel).
// The `conferences` table schema is created above; rows are populated only
// from /api/conferences POST requests so all data is user-provided.

const count = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
if (count === 0) {
  const insertProduct = db.prepare('INSERT INTO products (name,is_own,vendor,website,notes) VALUES (?,?,?,?,?)');
  const insertFeature = db.prepare('INSERT INTO features (name,category,description) VALUES (?,?,?)');
  const insertRelease = db.prepare('INSERT INTO releases (product_id,version,release_date,highlights,url) VALUES (?,?,?,?,?)');
  const insertPF = db.prepare('INSERT INTO product_features (product_id,feature_id,supported,since_version,notes) VALUES (?,?,?,?,?)');
  const insertFR = db.prepare('INSERT INTO feature_requests (feature_id,title,source_product_id,priority,status,notes) VALUES (?,?,?,?,?,?)');

  const own = insertProduct.run('Our Product', 1, 'Us', 'https://example.com', 'Our flagship offering').lastInsertRowid;
  const a = insertProduct.run('Competitor A', 0, 'Acme Corp', 'https://acme.example.com', 'Market leader').lastInsertRowid;
  const b = insertProduct.run('Competitor B', 0, 'Beta Inc', 'https://beta.example.com', 'Fast-growing challenger').lastInsertRowid;
  const c = insertProduct.run('Competitor C', 0, 'Gamma Ltd', 'https://gamma.example.com', 'Niche player').lastInsertRowid;

  const f1 = insertFeature.run('SSO / SAML', 'Security', 'Single sign-on via SAML 2.0').lastInsertRowid;
  const f2 = insertFeature.run('REST API', 'Integrations', 'Public REST API').lastInsertRowid;
  const f3 = insertFeature.run('Webhooks', 'Integrations', 'Outbound webhooks').lastInsertRowid;
  const f4 = insertFeature.run('Mobile App', 'Platform', 'Native iOS/Android apps').lastInsertRowid;
  const f5 = insertFeature.run('Dark Mode', 'UX', 'UI dark theme').lastInsertRowid;
  const f6 = insertFeature.run('AI Assistant', 'AI', 'Built-in AI assistant').lastInsertRowid;
  const f7 = insertFeature.run('Audit Logs', 'Security', 'Activity audit logs').lastInsertRowid;
  const f8 = insertFeature.run('Custom Reports', 'Analytics', 'User-defined reports').lastInsertRowid;

  const support = (p, f, s, v, n) => insertPF.run(p, f, s ? 1 : 0, v, n);
  support(own, f1, 1, '2.0', '');
  support(own, f2, 1, '1.0', '');
  support(own, f3, 0, null, 'Planned');
  support(own, f4, 0, null, '');
  support(own, f5, 1, '3.1', '');
  support(own, f6, 0, null, 'Not started');
  support(own, f7, 1, '2.5', '');
  support(own, f8, 0, null, '');

  support(a, f1, 1, '4.0', ''); support(a, f2, 1, '1.0', ''); support(a, f3, 1, '3.0', '');
  support(a, f4, 1, '2.0', ''); support(a, f5, 1, '5.0', ''); support(a, f6, 1, '6.0', 'GA');
  support(a, f7, 1, '4.5', ''); support(a, f8, 1, '5.2', '');

  support(b, f1, 1, '2.0', ''); support(b, f2, 1, '1.0', ''); support(b, f3, 1, '2.0', '');
  support(b, f4, 0, null, ''); support(b, f5, 1, '3.0', ''); support(b, f6, 1, '4.0', 'Beta');
  support(b, f7, 0, null, ''); support(b, f8, 1, '3.1', '');

  support(c, f1, 0, null, ''); support(c, f2, 1, '1.0', ''); support(c, f3, 0, null, '');
  support(c, f4, 1, '1.5', ''); support(c, f5, 0, null, ''); support(c, f6, 0, null, '');
  support(c, f7, 1, '2.0', ''); support(c, f8, 0, null, '');

  insertRelease.run(own, '3.1', '2025-03-15', 'Dark mode, perf improvements', '');
  insertRelease.run(own, '3.0', '2024-11-01', 'New dashboard, audit logs', '');
  insertRelease.run(a, '6.0', '2025-04-10', 'AI Assistant GA, new mobile UX', 'https://acme.example.com/release/6.0');
  insertRelease.run(a, '5.2', '2025-01-20', 'Custom reports, perf', '');
  insertRelease.run(b, '4.0', '2025-02-28', 'AI Assistant beta', '');
  insertRelease.run(b, '3.1', '2024-12-05', 'Custom reports', '');
  insertRelease.run(c, '2.0', '2024-10-12', 'Audit logs, mobile improvements', '');

  insertFR.run(f6, 'Add AI Assistant', a, 'high', 'open', 'Both Competitor A (GA) and B (beta) have it');
  insertFR.run(f4, 'Native mobile apps', a, 'high', 'open', 'Competitors A, B, C all ship mobile');
  insertFR.run(f3, 'Outbound Webhooks', a, 'medium', 'in_progress', 'Currently planned');
  insertFR.run(f8, 'Custom Reports builder', a, 'medium', 'open', 'A and B both have it');
}

module.exports = db;
