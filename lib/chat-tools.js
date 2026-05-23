// Read-only tools the chatbot can call to inspect the workspace DB.
// Each tool has a JSON-schema description (handed to the LLM) and a `run(args)` function.
//
// Safety: only SELECT statements; bound parameters; row caps; truncated content.

const db = require('../db');
const spoc = require('./spoc');
const mailer = require('./mailer');
const dailyDigest = require('./daily-digest');

const ROW_CAP = 50;
const TEXT_CAP = 600;

const truncate = (s, n = TEXT_CAP) =>
  typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s;

const trimRow = (r) => {
  if (!r || typeof r !== 'object') return r;
  const out = {};
  for (const [k, v] of Object.entries(r)) out[k] = typeof v === 'string' ? truncate(v) : v;
  return out;
};

// ---------------------------------------------------------------- tool defs

const tools = [
  {
    name: 'list_products',
    description: 'List products in the catalog. Filter by kind ("product" or "analyst") or own/competitor.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['product', 'analyst'], description: 'Filter by kind. Omit for all.' },
        scope: { type: 'string', enum: ['own', 'competitor', 'all'], description: 'own = our products; competitor = rivals; all = both. Default all.' },
      },
    },
    run: ({ kind, scope = 'all' } = {}) => {
      const where = [];
      const args = [];
      if (kind) { where.push("COALESCE(kind,'product') = ?"); args.push(kind); }
      if (scope === 'own') where.push('is_own = 1');
      else if (scope === 'competitor') where.push('is_own = 0');
      const sql = `SELECT id, name, vendor, is_own, COALESCE(kind,'product') AS kind, website
                   FROM products ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY is_own DESC, name LIMIT ${ROW_CAP}`;
      return db.prepare(sql).all(...args);
    },
  },
  {
    name: 'get_product_features',
    description: "Get the features supported by a specific product, with notes/source URLs. Use this to answer 'what does X support?' or 'what features does competitor Y have?'.",
    parameters: {
      type: 'object',
      required: ['product_id'],
      properties: {
        product_id: { type: 'integer', description: 'Product id (from list_products).' },
        category: { type: 'string', description: 'Optional category filter (e.g. "Detection", "Cloud").' },
      },
    },
    run: ({ product_id, category } = {}) => {
      const args = [product_id];
      let sql = `SELECT f.id, f.name, f.category, pf.since_version, pf.notes
                 FROM product_features pf
                 JOIN features f ON f.id = pf.feature_id
                 WHERE pf.product_id = ? AND pf.supported = 1`;
      if (category) { sql += ' AND f.category = ?'; args.push(category); }
      sql += ` ORDER BY f.category, f.name LIMIT ${ROW_CAP * 2}`;
      return db.prepare(sql).all(...args).map(trimRow);
    },
  },
  {
    name: 'find_features',
    description: 'Search the master features table by keyword. Returns features whose name or category contains the query.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' } },
    },
    run: ({ query } = {}) => {
      const q = '%' + (query || '').replace(/[%_]/g, m => '\\' + m) + '%';
      const sql = `SELECT id, name, category FROM features
                   WHERE name LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\'
                   ORDER BY category, name LIMIT ${ROW_CAP}`;
      return db.prepare(sql).all(q, q);
    },
  },
  {
    name: 'get_gaps',
    description: 'Get the competitive feature gaps: features supported by at least one competitor that NONE of our own products (is_own=1) support. Optionally filter by category.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Optional category filter.' },
        min_competitors: { type: 'integer', description: 'Minimum competitor count (default 1).' },
      },
    },
    run: ({ category, min_competitors = 1 } = {}) => {
      const ownIds = db.prepare('SELECT id FROM products WHERE is_own = 1').all().map(r => r.id);
      if (!ownIds.length) return [];
      const ph = ownIds.map(() => '?').join(',');
      const args = [...ownIds];
      let sql = `SELECT f.id AS feature_id, f.name AS feature, f.category,
                   GROUP_CONCAT(p.name, ', ') AS competitors_supporting,
                   COUNT(*) AS competitor_count
                 FROM features f
                 JOIN product_features pf ON pf.feature_id = f.id AND pf.supported = 1
                 JOIN products p ON p.id = pf.product_id AND p.is_own = 0 AND COALESCE(p.kind,'product') = 'product'
                 WHERE NOT EXISTS (
                   SELECT 1 FROM product_features mine
                   WHERE mine.feature_id = f.id AND mine.product_id IN (${ph}) AND mine.supported = 1
                 )`;
      if (category) { sql += ' AND f.category = ?'; args.push(category); }
      sql += ` GROUP BY f.id HAVING competitor_count >= ?
               ORDER BY competitor_count DESC, f.name LIMIT ${ROW_CAP}`;
      args.push(min_competitors);
      return db.prepare(sql).all(...args);
    },
  },
  {
    name: 'get_feature_evidence',
    description: 'For a specific feature id, list every product that supports it and the source URLs (release notes / articles / curated links) backing that claim.',
    parameters: {
      type: 'object',
      required: ['feature_id'],
      properties: { feature_id: { type: 'integer' } },
    },
    run: ({ feature_id } = {}) => {
      return db.prepare(`
        SELECT p.id AS product_id, p.name AS product_name, p.is_own,
               pf.since_version, pf.notes
        FROM product_features pf
        JOIN products p ON p.id = pf.product_id
        WHERE pf.feature_id = ? AND pf.supported = 1
          AND COALESCE(p.kind,'product') = 'product'
        ORDER BY p.is_own DESC, p.name
      `).all(feature_id).map(trimRow);
    },
  },
  {
    name: 'get_releases',
    description: 'List recent releases. Filter by product or by recency.',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'integer', description: 'Filter to one product (omit for all).' },
        months: { type: 'integer', description: 'Limit to releases in the last N months.' },
        limit: { type: 'integer', description: 'Row limit (default 20, max 50).' },
      },
    },
    run: ({ product_id, months, limit = 20 } = {}) => {
      const args = [];
      const where = [];
      if (product_id) { where.push('r.product_id = ?'); args.push(product_id); }
      if (months) {
        where.push("r.release_date >= date('now', ?)");
        args.push(`-${Math.max(1, +months)} months`);
      }
      const cap = Math.min(50, Math.max(1, +limit || 20));
      const sql = `SELECT r.id, p.name AS product, r.version, r.release_date, r.url,
                          SUBSTR(COALESCE(r.highlights,''), 1, 500) AS highlights
                   FROM releases r JOIN products p ON p.id = r.product_id
                   ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY COALESCE(r.release_date,'') DESC, r.id DESC
                   LIMIT ${cap}`;
      return db.prepare(sql).all(...args);
    },
  },
  {
    name: 'count_feed_items',
    description: 'Return EXACT counts of feed items (raw_items) for the last N days. Use this whenever the user asks "how many feed items / articles / ingested items in the last X days". Reports both: by published_at (when the article was published) and by fetched_at (when we ingested it). Default 30 days.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Window length in days. Default 30.' },
        product_id: { type: 'integer', description: 'Optional: scope to one product.' },
      },
    },
    run: ({ days = 30, product_id } = {}) => {
      const d = Math.max(1, Math.min(365, +days || 30));
      const args = [`-${d} days`];
      let pubSql = `SELECT COUNT(*) c FROM raw_items WHERE COALESCE(published_at, fetched_at) >= datetime('now', ?)`;
      let fetSql = `SELECT COUNT(*) c FROM raw_items WHERE fetched_at >= datetime('now', ?)`;
      if (product_id) {
        pubSql += ' AND product_id = ?'; fetSql += ' AND product_id = ?';
        args.push(product_id);
      }
      const byPub = db.prepare(pubSql).get(...args).c;
      const byFet = db.prepare(fetSql).get(...args).c;
      const total = db.prepare(product_id
        ? 'SELECT COUNT(*) c FROM raw_items WHERE product_id = ?'
        : 'SELECT COUNT(*) c FROM raw_items').get(...(product_id ? [product_id] : [])).c;
      return {
        days: d,
        product_id: product_id || null,
        count_by_published_at: byPub,
        count_by_fetched_at: byFet,
        count_all_time: total,
        note: 'count_by_fetched_at matches what the Dashboard tile shows (it counts ingestion time). count_by_published_at filters by the article\'s own publication date.',
      };
    },
  },
  {
    name: 'search_feed',
    description: 'Search ingested feed items (raw_items, e.g. competitor blog posts) by keyword in title or content. Returns title, URL, product, date, status. NOTE: this is row-limited (≤30); for COUNTING use count_feed_items instead.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        product_id: { type: 'integer', description: 'Optional filter by product id.' },
        limit: { type: 'integer', description: 'Row limit (default 15, max 30).' },
      },
    },
    run: ({ query, product_id, limit = 15 } = {}) => {
      const q = '%' + (query || '').replace(/[%_]/g, m => '\\' + m) + '%';
      const args = [q, q];
      let sql = `SELECT ri.id, p.name AS product, ri.title, ri.url, ri.published_at, ri.status
                 FROM raw_items ri JOIN products p ON p.id = ri.product_id
                 WHERE (ri.title LIKE ? ESCAPE '\\' OR ri.content LIKE ? ESCAPE '\\')`;
      if (product_id) { sql += ' AND ri.product_id = ?'; args.push(product_id); }
      const cap = Math.min(30, Math.max(1, +limit || 15));
      sql += ` ORDER BY COALESCE(ri.published_at, ri.fetched_at) DESC LIMIT ${cap}`;
      return db.prepare(sql).all(...args);
    },
  },
  {
    name: 'get_feed_item',
    description: 'Get the full content + LLM analysis JSON for a single feed item by id.',
    parameters: {
      type: 'object',
      required: ['item_id'],
      properties: { item_id: { type: 'integer' } },
    },
    run: ({ item_id } = {}) => {
      const row = db.prepare(`SELECT ri.id, p.name AS product, ri.title, ri.url, ri.published_at,
                                     ri.status, SUBSTR(ri.content, 1, 1500) AS content, ri.analysis_json
                              FROM raw_items ri JOIN products p ON p.id = ri.product_id
                              WHERE ri.id = ?`).get(item_id);
      if (!row) return { error: 'Not found' };
      let analysis = null;
      try { analysis = row.analysis_json ? JSON.parse(row.analysis_json) : null; } catch (_) {}
      return { ...row, analysis_json: undefined, analysis };
    },
  },
  {
    name: 'get_competitor_report',
    description: 'High-level activity summary per competitor over a window (in months): release counts, ingested items, exclusive features (they have / we don\'t), latest release date.',
    parameters: {
      type: 'object',
      properties: { months: { type: 'integer', description: 'Window length in months (default 6).' } },
    },
    run: ({ months = 6 } = {}) => {
      const { computeCompetitorReport } = require('./trends');
      const data = computeCompetitorReport(db, { months });
      // Trim per-competitor heavy arrays.
      return {
        window: data.window,
        competitors: data.competitors.map(c => ({
          product_id: c.product_id,
          product_name: c.product_name,
          vendor: c.vendor,
          release_count_window: c.release_count_window,
          raw_items_window: c.raw_items_window,
          new_features_count: c.new_features_count,
          exclusive_features_count: c.exclusive_features_count,
          latest_release_date: c.latest_release_date,
          top_themes: (c.themes || []).slice(0, 5),
          top_keywords: (c.keywords || []).slice(0, 8).map(k => k.keyword),
        })),
      };
    },
  },
  {
    name: 'get_open_requests',
    description: 'List feature requests / backlog items currently open (sourced from gap analysis). Includes priority, confidence, effort, rationale.',
    parameters: {
      type: 'object',
      properties: {
        priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        product_id: { type: 'integer', description: 'Filter to gaps where this competitor is the source.' },
        limit: { type: 'integer', description: 'Row limit (default 20, max 50).' },
      },
    },
    run: ({ priority, product_id, limit = 20 } = {}) => {
      const args = [];
      const where = ["status = 'open'"];
      if (priority) { where.push('priority = ?'); args.push(priority); }
      if (product_id) { where.push('source_product_id = ?'); args.push(product_id); }
      const cap = Math.min(50, Math.max(1, +limit || 20));
      const sql = `SELECT id, title, priority, status, confidence, effort, notes,
                          SUBSTR(COALESCE(rationale,''), 1, 300) AS rationale
                   FROM feature_requests WHERE ${where.join(' AND ')}
                   ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                            COALESCE(confidence, 0) DESC LIMIT ${cap}`;
      return db.prepare(sql).all(...args);
    },
  },
  {
    name: 'compare_products',
    description: 'Compare which features two products both support, only product A supports, only product B supports.',
    parameters: {
      type: 'object',
      required: ['product_a', 'product_b'],
      properties: {
        product_a: { type: 'integer', description: 'Product A id.' },
        product_b: { type: 'integer', description: 'Product B id.' },
      },
    },
    run: ({ product_a, product_b } = {}) => {
      const supp = (pid) => new Set(db.prepare(
        'SELECT feature_id FROM product_features WHERE product_id = ? AND supported = 1'
      ).all(pid).map(r => r.feature_id));
      const A = supp(product_a), B = supp(product_b);
      const featById = (ids) => ids.length === 0 ? [] : db.prepare(
        `SELECT id, name, category FROM features WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY category, name`
      ).all(...ids);
      const both = [...A].filter(x => B.has(x));
      const onlyA = [...A].filter(x => !B.has(x));
      const onlyB = [...B].filter(x => !A.has(x));
      const aName = (db.prepare('SELECT name FROM products WHERE id = ?').get(product_a) || {}).name;
      const bName = (db.prepare('SELECT name FROM products WHERE id = ?').get(product_b) || {}).name;
      return {
        product_a: aName, product_b: bName,
        both_count: both.length, only_a_count: onlyA.length, only_b_count: onlyB.length,
        both: featById(both),
        only_a: featById(onlyA),
        only_b: featById(onlyB),
      };
    },
  },
  // ---------------------------------------------------------------- SPOC tools
  // SPOC = daily customer-ticket sheet ingested from Zoho/WorkDrive into spoc_entries.
  // Each row has columns like Ticket ID, Summary, Module, Product, Cx Type, Priority, Time,
  // Message Link, plus per-person read-tracker columns (✓ when read).
  {
    name: 'get_spoc_summary',
    description: 'High-level SPOC dashboard numbers: total entries, fully-read / partially-read / untouched counts, last import metadata, breakdown by product / module / customer-type / sheet, and per-person read percentages. Use for overview questions like "how is SPOC tracking going", "who has read the most", "what products dominate this week\'s tickets".',
    parameters: { type: 'object', properties: {} },
    run: () => {
      try {
        const s = spoc.summary();
        return {
          total: s.total,
          fully_read: s.fullyRead,
          partially_read: s.partiallyRead,
          untouched: s.untouched,
          tracker_columns: s.trackerColumns,
          last_import: s.lastImport,
          imports_count: s.importsCount,
          by_product: s.byProduct,
          by_module: s.byModule,
          by_cx_type: s.byCxType,
          by_sheet: s.bySheet,
          by_priority: s.byPriority,
          per_person: s.perPerson,
          recent_8: (s.recent || []).slice(0, 8),
        };
      } catch (e) { return { error: e.message }; }
    },
  },
  {
    name: 'search_spoc',
    description: 'Search SPOC ticket entries with optional filters. Use for specific questions like "show me Log360 Cloud tickets", "what tickets are about Alerts module", "what did Saairam read", "tickets for madathi". When the user mentions a person name (e.g. "madathi", "the spoc data of saairam"), pass it as `person` to get every ticket with an is_read flag for that person — that is almost always what they want, NOT just the read ones.',
    parameters: {
      type: 'object',
      properties: {
        query:    { type: 'string', description: 'Free-text substring matched against summary, ticket id, module, product, customer name. Case-insensitive.' },
        product:  { type: 'string', description: 'Filter by sheet "Product" column (e.g. "Log360 Cloud", "EventLog Analyzer"). Substring match.' },
        module:   { type: 'string', description: 'Filter by sheet "Module" column (e.g. "Alerts & Incidents"). Substring match.' },
        cx_type:  { type: 'string', description: 'Filter by Cx Type (e.g. "Customer", "Re-seller", "Lead/Prospect"). Substring match.' },
        priority: { type: 'string', description: 'Filter by Priority (e.g. "High", "Critical"). Substring match.' },
        person:   { type: 'string', description: 'Annotate every returned row with `is_read` for this person (case-insensitive). Use this for general "spoc data of <name>" questions.' },
        read_by:  { type: 'string', description: 'Return ONLY entries this person HAS marked read. Case-insensitive.' },
        unread_by:{ type: 'string', description: 'Return ONLY entries this person has NOT marked read. Case-insensitive.' },
        limit:    { type: 'integer', description: 'Max rows to return (default 25, hard cap 50).' },
      },
    },
    run: ({ query, product, module, cx_type, priority, person, read_by, unread_by, limit } = {}) => {
      try {
        const all = spoc.listEntries({ q: query || '', limit: 5000 }).items || [];
        const norm = (v) => (v == null ? '' : String(v)).toLowerCase();
        const includes = (haystack, needle) => norm(haystack).includes(norm(needle));
        // Resolve a person name (case-insensitive) to its canonical tracker-column spelling.
        const summary = (() => { try { return spoc.summary(); } catch (_) { return { trackerColumns: [] }; } })();
        const trackerCols = summary.trackerColumns || [];
        const resolvePerson = (raw) => {
          if (!raw) return null;
          const target = norm(raw);
          return trackerCols.find(c => norm(c) === target)
              || trackerCols.find(c => norm(c).startsWith(target))
              || trackerCols.find(c => norm(c).includes(target))
              || raw;
        };
        const personCanon  = resolvePerson(person);
        const readByCanon  = resolvePerson(read_by);
        const unreadCanon  = resolvePerson(unread_by);
        // Resolve sheet column names from the first row (headers vary in case/spacing).
        const sample = all[0]?.data || {};
        const findKey = (...needles) => {
          for (const k of Object.keys(sample)) {
            const lk = norm(k);
            if (needles.some(n => lk === norm(n))) return k;
          }
          for (const k of Object.keys(sample)) {
            const lk = norm(k);
            if (needles.some(n => lk.includes(norm(n)))) return k;
          }
          return null;
        };
        const COL = {
          ticket:   findKey('Ticket ID', 'ticket id', 'ticket'),
          summary:  findKey('Query Summary', 'summary'),
          module:   findKey('Module'),
          product:  findKey('Product'),
          cx:       findKey('Cx Type', 'customer type'),
          priority: findKey('Priority'),
          time:     findKey('Time'),
          link:     findKey('Message Link', 'link'),
        };
        // Build read_by[] for each row from acks + tracker-column truthiness (mirrors spoc.summary's isRead).
        const isReadFor = (row, person) => {
          const ack = (row.acks || []).find(a => a.person === person);
          if (ack) return ack.status === 'read';
          const v = row.data?.[person];
          if (v == null || v === '') return false;
          const s = String(v).toLowerCase();
          return !(s === 'open' || s === 'pending' || s === 'todo');
        };
        const readByOf = (row) => trackerCols.filter(p => isReadFor(row, p));
        // Apply field filters.
        const fieldVal = (row, k) => k ? row.data?.[k] : null;
        let filtered = all;
        if (product)  filtered = filtered.filter(r => includes(fieldVal(r, COL.product),  product));
        if (module)   filtered = filtered.filter(r => includes(fieldVal(r, COL.module),   module));
        if (cx_type)  filtered = filtered.filter(r => includes(fieldVal(r, COL.cx),       cx_type));
        if (priority) filtered = filtered.filter(r => includes(fieldVal(r, COL.priority), priority));
        if (readByCanon) filtered = filtered.filter(r => isReadFor(r, readByCanon));
        if (unreadCanon) filtered = filtered.filter(r => !isReadFor(r, unreadCanon));
        const cap = Math.min(50, Math.max(1, +limit || 25));
        const items = filtered.slice(0, cap).map(r => {
          const row = trimRow({
            ticket_id: fieldVal(r, COL.ticket) || '',
            summary:   fieldVal(r, COL.summary) || '',
            module:    fieldVal(r, COL.module) || '',
            product:   fieldVal(r, COL.product) || '',
            cx_type:   fieldVal(r, COL.cx) || '',
            priority:  fieldVal(r, COL.priority) || '',
            time:      fieldVal(r, COL.time) || r.first_seen,
            message_link: fieldVal(r, COL.link) || '',
            read_by:   readByOf(r),
          });
          if (personCanon) row.is_read = isReadFor(r, personCanon);
          return row;
        });
        const out = { matched: filtered.length, returned: items.length, items };
        if (person) {
          out.person = { requested: person, resolved_to: personCanon, found_in_tracker_columns: trackerCols.includes(personCanon) };
          if (!trackerCols.includes(personCanon)) {
            out.hint = `"${person}" did not match any tracker column. Known columns: ${trackerCols.join(', ')}`;
          } else {
            const readN = items.filter(r => r.is_read).length;
            out.person.read_in_returned = readN;
            out.person.unread_in_returned = items.length - readN;
          }
        }
        return out;
      } catch (e) { return { error: e.message }; }
    },
  },
  {
    name: 'count_spoc',
    description: 'Get exact counts of SPOC entries grouped by a dimension. Use for "how many" questions instead of search_spoc (which is row-limited).',
    parameters: {
      type: 'object',
      properties: {
        group_by: { type: 'string', enum: ['product','module','cx_type','priority','sheet','read_status','person'], description: 'Dimension to group by. "read_status" returns fully_read/partially_read/untouched. "person" returns per-tracker-column read counts.' },
      },
      required: ['group_by'],
    },
    run: ({ group_by } = {}) => {
      try {
        const s = spoc.summary();
        switch (group_by) {
          case 'product':     return { total: s.total, groups: s.byProduct };
          case 'module':      return { total: s.total, groups: s.byModule };
          case 'cx_type':     return { total: s.total, groups: s.byCxType };
          case 'priority':    return { total: s.total, groups: s.byPriority };
          case 'sheet':       return { total: s.total, groups: s.bySheet };
          case 'read_status': return { total: s.total, fully_read: s.fullyRead, partially_read: s.partiallyRead, untouched: s.untouched };
          case 'person':      return { tracker_columns: s.trackerColumns, per_person: s.perPerson };
          default: return { error: 'invalid group_by' };
        }
      } catch (e) { return { error: e.message }; }
    },
  },
  // ---------------------------------------------------------------- WRITE tools
  // Strictly INSERT-only. Idempotent on name (returns existing row if it already
  // exists). Never updates, never deletes, never auto-polls. Use list_products
  // / find_features first to avoid duplicates.
  {
    name: 'add_product',
    description: "Add a NEW product (or analyst firm) to the catalog. Idempotent: if a product with the same name already exists, returns the existing row without modification. Use this when the user explicitly asks to add/track a vendor or product. ALWAYS call list_products first to confirm it's not already there. Does NOT poll any sources — call add_source separately for that.",
    parameters: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Product name as it should appear in the catalog (e.g. "Palo Alto Cortex XSIAM"). Use the exact spelling the user gave.' },
        vendor: { type: 'string', description: 'Vendor / company name (e.g. "Palo Alto Networks").' },
        website: { type: 'string', description: 'Marketing site URL.' },
        kind: { type: 'string', enum: ['product', 'analyst'], description: 'Default "product". Use "analyst" only for firms like Gartner/Forrester.' },
        is_own: { type: 'boolean', description: 'True only if this is one of OUR products. Default false.' },
        notes: { type: 'string', description: 'Optional short note.' },
      },
    },
    run: ({ name, vendor, website, kind = 'product', is_own = false, notes } = {}) => {
      if (!name || typeof name !== 'string') return { error: 'name is required' };
      const trimmed = name.trim();
      if (!trimmed) return { error: 'name cannot be empty' };
      // Idempotency check (case-insensitive).
      const existing = db.prepare('SELECT id, name, vendor, website, kind, is_own FROM products WHERE LOWER(name) = LOWER(?)').get(trimmed);
      if (existing) return { ok: true, created: false, product: existing, message: `Product "${existing.name}" (id ${existing.id}) already exists — no change made.` };
      const info = db.prepare(
        `INSERT INTO products (name, vendor, website, kind, is_own, notes) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(trimmed, vendor || null, website || null, kind || 'product', is_own ? 1 : 0, notes || null);
      const row = db.prepare('SELECT id, name, vendor, website, kind, is_own FROM products WHERE id = ?').get(info.lastInsertRowid);
      return { ok: true, created: true, product: row, message: `Added product "${row.name}" with id ${row.id}. Next step: call add_source to register a feed/HTML/release-notes URL, then the user can click Refresh in the UI to start polling.` };
    },
  },
  {
    name: 'add_source',
    description: 'Register a feed source (RSS, HTML page, or release-notes page) for an existing product. Idempotent on (product_id, url). Does NOT auto-poll — the user must click Refresh in the UI (or you can tell them to).',
    parameters: {
      type: 'object',
      required: ['product_id', 'kind', 'url'],
      properties: {
        product_id: { type: 'integer', description: 'Product id (from add_product or list_products).' },
        kind: { type: 'string', enum: ['rss', 'html', 'manual'], description: 'rss = RSS/Atom feed; html = scrape a static page (e.g. release-notes page); manual = no fetcher, content pasted manually.' },
        url: { type: 'string', description: 'Absolute URL to the feed or page.' },
        label: { type: 'string', description: 'Short human-readable label, e.g. "Vendor blog" or "Release notes".' },
      },
    },
    run: ({ product_id, kind, url, label } = {}) => {
      if (!product_id) return { error: 'product_id is required' };
      if (!['rss', 'html', 'manual'].includes(kind)) return { error: "kind must be 'rss', 'html', or 'manual'" };
      const u = (url || '').trim();
      if (!u) return { error: 'url is required' };
      if (!/^https?:\/\//i.test(u) && kind !== 'manual') return { error: 'url must start with http:// or https://' };
      const product = db.prepare('SELECT id, name FROM products WHERE id = ?').get(product_id);
      if (!product) return { error: `No product with id ${product_id}. Call add_product first or use list_products to find the right id.` };
      const existing = db.prepare('SELECT id, kind, url, label FROM sources WHERE product_id = ? AND url = ?').get(product_id, u);
      if (existing) return { ok: true, created: false, source: existing, message: `Source already registered for "${product.name}" (source id ${existing.id}) — no change made.` };
      const info = db.prepare(
        `INSERT INTO sources (product_id, kind, url, label) VALUES (?, ?, ?, ?)`
      ).run(product_id, kind, u, label || null);
      return {
        ok: true, created: true,
        source: { id: info.lastInsertRowid, product_id, kind, url: u, label: label || null },
        message: `Registered ${kind.toUpperCase()} source for "${product.name}" (source id ${info.lastInsertRowid}). Tell the user to click the Refresh button (or Sources → Run) to fetch the first batch.`,
      };
    },
  },
  // ---------------------------------------------------------------- COMMUNICATION tools
  // Sends the current chat conversation to one or more recipients via the
  // configured Zoho Mail account. Recipients are restricted to an allow-list
  // of trusted domains so the bot can't be tricked into spamming arbitrary
  // addresses (prompt-injection defence).
  {
    name: 'send_chat_transcript',
    description: 'Email the current chat conversation (this thread) to one or more recipients. Use ONLY when the user explicitly asks to email/send/mail the chat, transcript, conversation, or summary. Do NOT ask "are you sure?" in chat — just call this tool. By default it returns needs_confirmation and the UI shows a Yes/No dialog; the user confirms there. Recipients must be on the server allow-list. Does NOT send the daily product digest (that has its own scheduled job).',
    parameters: {
      type: 'object',
      required: ['to'],
      properties: {
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more recipient email addresses. Must match domains on the server allow-list.',
        },
        subject: {
          type: 'string',
          description: 'Optional subject line. Defaults to "PM Panel chat transcript — <date>".',
        },
        note: {
          type: 'string',
          description: 'Optional short note from the user, prepended to the email body before the transcript.',
        },
        confirmed: {
          type: 'boolean',
          description: 'Internal flag set by the UI confirmation dialog. The chatbot must NOT set this — always leave it false/unset. When false, the tool returns needs_confirmation; the actual send happens after the user clicks Confirm in the dialog.',
        },
      },
    },
    run: async (args, ctx) => {
      const { to, subject, note, confirmed } = args || {};
      if (!mailer.isConfigured()) {
        return { error: 'Mailer not configured (ZOHO_MAIL_* env vars missing). Tell the user to configure Settings → Mail Digest.' };
      }
      const recipients = Array.isArray(to) ? to : (to ? [to] : []);
      const cleaned = recipients.map(s => String(s || '').trim()).filter(Boolean);
      if (!cleaned.length) return { error: '`to` must be a non-empty array of email addresses.' };
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const bad = cleaned.filter(e => !emailRe.test(e));
      if (bad.length) return { error: `Invalid email address(es): ${bad.join(', ')}` };

      // Allow-list: explicit MAIL_ALLOWED_DOMAINS env var wins. Otherwise derive
      // from the configured digest recipients + the sender address — those are
      // implicitly trusted because an operator already set them.
      const explicit = (process.env.MAIL_ALLOWED_DOMAINS || '')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      let allowed = new Set(explicit);
      if (!allowed.size) {
        const savedTo = ctx && typeof ctx.getDailyRecipients === 'function'
          ? (ctx.getDailyRecipients() || '') : '';
        const envTo = process.env.ZOHO_MAIL_DAILY_TO || '';
        const from = process.env.ZOHO_MAIL_FROM || '';
        const seed = [savedTo, envTo, from].join(',').split(',').map(s => s.trim()).filter(Boolean);
        for (const addr of seed) {
          const m = addr.match(/@([^\s@]+)$/);
          if (m) allowed.add(m[1].toLowerCase());
        }
      }
      if (!allowed.size) {
        return { error: 'No allow-list configured. Set MAIL_ALLOWED_DOMAINS in .env or add at least one digest recipient first.' };
      }
      const blocked = cleaned.filter(e => !allowed.has(e.split('@')[1].toLowerCase()));
      console.log(`[send_chat_transcript] confirmed=${!!confirmed} to=${cleaned.join(',')} allowed=[${[...allowed].join(',')}] blocked=${blocked.length}`);
      if (blocked.length) {
        return { error: `Recipient(s) ${blocked.join(', ')} not allowed. Allowed domains: ${[...allowed].join(', ')}. Ask the user to choose a recipient on those domains, or have an admin add the domain to MAIL_ALLOWED_DOMAINS.` };
      }

      const messages = (ctx && Array.isArray(ctx.messages)) ? ctx.messages : [];
      // Trim the trailing "please email this" exchange so the recipient sees
      // the actual conversation, not the meta-request that triggered the send.
      const sendIntentRe = /\b(e?-?mail|send|mail|forward)\b.*\b(chat|transcript|conversation|summary|thread|this|it)\b|\bsend_chat_transcript\b/i;
      let cutoff = messages.length;
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m && m.role === 'user' && sendIntentRe.test(String(m.content || ''))) {
          cutoff = i;
          break;
        }
      }
      const transcript = messages.slice(0, cutoff);
      if (!transcript.length) return { error: 'No prior conversation to send — only the send-request itself.' };

      const nowIso = new Date().toISOString();
      const subj = (subject && String(subject).trim()) || `PM Panel chat transcript — ${nowIso.slice(0, 10)}`;

      // Step 1: not confirmed yet — surface a confirmation request to the UI.
      if (!confirmed) {
        return {
          needs_confirmation: true,
          to: cleaned,
          subject: subj,
          note: note || null,
          message_count: transcript.length,
          message: `Awaiting user confirmation in the UI before sending to ${cleaned.join(', ')}. The UI will show a Yes/No dialog. Reply briefly to the user (one short sentence) letting them know to confirm in the dialog — do NOT ask them in chat.`,
        };
      }

      // Step 2: confirmed — build HTML and send.
      const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      const turns = transcript.map(m => {
        const role = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : (m.role || 'system');
        const colour = role === 'User' ? '#1f6feb' : role === 'Assistant' ? '#238636' : '#6e7681';
        return `<div style="margin:0 0 14px 0;padding:10px 12px;border-left:3px solid ${colour};background:#f6f8fa;border-radius:4px;">
            <div style="font-weight:600;color:${colour};font-size:12px;margin-bottom:4px;letter-spacing:0.3px;">${role.toUpperCase()}</div>
            <div style="white-space:pre-wrap;word-wrap:break-word;color:#1f2328;">${esc(m.content || '').slice(0, 8000)}</div>
          </div>`;
      }).join('');

      const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2328;max-width:760px;margin:0 auto;padding:20px;">
        <h2 style="margin:0 0 4px 0;">PM Panel chat transcript</h2>
        <div style="color:#6e7681;font-size:12px;margin-bottom:16px;">Generated ${esc(nowIso)} · ${transcript.length} message${transcript.length === 1 ? '' : 's'}</div>
        ${note ? `<div style="margin:0 0 16px 0;padding:10px 12px;background:#fff8c5;border:1px solid #d4a72c;border-radius:6px;"><strong>Note:</strong> ${esc(note)}</div>` : ''}
        ${turns}
        <hr style="border:none;border-top:1px solid #d0d7de;margin:20px 0;">
        <div style="color:#6e7681;font-size:11px;">Sent by the PM Panel chatbot at the user's request.</div>
      </body></html>`;

      try {
        const out = await mailer.sendMail({ to: cleaned, subject: subj, html });
        return {
          ok: true,
          to: cleaned,
          subject: subj,
          messageId: (out && out.messageId) || null,
          message: `Sent chat transcript (${transcript.length} message${transcript.length === 1 ? '' : 's'}) to ${cleaned.join(', ')}.`,
        };
      } catch (e) {
        return { error: `sendMail failed: ${e.message}` };
      }
    },
  },
  // Sends the daily digest (SPOC tickets last 24h + competitive/analyst/news
  // feed activity) on-demand. Use when the user says "send the digest",
  // "email yesterday's data", "send last 24 hours summary", etc. This is the
  // SAME content the 21:00 IST scheduled job sends — just triggered manually.
  {
    name: 'send_daily_digest',
    description: 'Email the PM digest (a subset or all of: SPOC tickets in last N hours, Feature Requests in last N hours, Competitive feed, Analyst feed, Industry news feed) to one or more recipients. Use when the user asks to send "the digest", "the summary", "last 24 hours data", "yesterday\'s data", "the SPOC report", "the news", "the feeds", "the feature requests", or any subset like "only SPOC", "only news", "just the competitive items", "only feature requests". Pass the `sections` parameter to limit which blocks are included — e.g. ["spoc"] for SPOC only, ["fr"] for Feature Requests only, ["news"] for industry news only, ["competitive","analyst"] for both feeds. Omit `sections` (or pass all five) to send the full digest. By default returns needs_confirmation and the UI shows a Yes/No dialog. Recipients must be on the server allow-list.',
    parameters: {
      type: 'object',
      required: ['to'],
      properties: {
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more recipient email addresses. Must match domains on the server allow-list.',
        },
        sections: {
          type: 'array',
          items: { type: 'string', enum: ['spoc', 'fr', 'competitive', 'analyst', 'news'] },
          description: 'Which digest blocks to include. Allowed: spoc, fr, competitive, analyst, news. Omit to include all five. Pick a subset based on the user\'s wording — e.g. "only SPOC" → ["spoc"], "only feature requests" → ["fr"], "just the news" → ["news"], "competitive and analyst" → ["competitive","analyst"].',
        },
        hours: {
          type: 'number',
          description: 'Lookback window in hours. Defaults to 24.',
        },
        confirmed: {
          type: 'boolean',
          description: 'Internal flag set by the UI confirmation dialog. The chatbot must NOT set this — always leave it false/unset.',
        },
      },
    },
    run: async (args, ctx) => {
      const { to, hours, sections, confirmed } = args || {};
      if (!mailer.isConfigured()) {
        return { error: 'Mailer not configured (ZOHO_MAIL_* env vars missing). Tell the user to configure Settings → Mail Digest.' };
      }
      const recipients = Array.isArray(to) ? to : (to ? [to] : []);
      const cleaned = recipients.map(s => String(s || '').trim()).filter(Boolean);
      if (!cleaned.length) return { error: '`to` must be a non-empty array of email addresses.' };
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const bad = cleaned.filter(e => !emailRe.test(e));
      if (bad.length) return { error: `Invalid email address(es): ${bad.join(', ')}` };

      // Same allow-list logic as send_chat_transcript.
      const explicit = (process.env.MAIL_ALLOWED_DOMAINS || '')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      let allowed = new Set(explicit);
      if (!allowed.size) {
        const savedTo = ctx && typeof ctx.getDailyRecipients === 'function'
          ? (ctx.getDailyRecipients() || '') : '';
        const envTo = process.env.ZOHO_MAIL_DAILY_TO || '';
        const from = process.env.ZOHO_MAIL_FROM || '';
        const seed = [savedTo, envTo, from].join(',').split(',').map(s => s.trim()).filter(Boolean);
        for (const addr of seed) {
          const m = addr.match(/@([^\s@]+)$/);
          if (m) allowed.add(m[1].toLowerCase());
        }
      }
      if (!allowed.size) {
        return { error: 'No allow-list configured. Set MAIL_ALLOWED_DOMAINS in .env or add at least one digest recipient first.' };
      }
      const blocked = cleaned.filter(e => !allowed.has(e.split('@')[1].toLowerCase()));
      const sectionList = Array.isArray(sections) && sections.length ? sections : null;
      console.log(`[send_daily_digest] confirmed=${!!confirmed} to=${cleaned.join(',')} hours=${hours||24} sections=${(sectionList||['all']).join(',')} blocked=${blocked.length}`);
      if (blocked.length) {
        return { error: `Recipient(s) ${blocked.join(', ')} not allowed. Allowed domains: ${[...allowed].join(', ')}.` };
      }

      const hrs = Number.isFinite(+hours) && +hours > 0 ? Math.min(168, +hours) : 24;
      const digest = dailyDigest.build({ hours: hrs, sections: sectionList });
      const includedSections = digest.sections || ['spoc','fr','competitive','analyst','news'];

      if (!confirmed) {
        const s = digest.stats || {};
        const feeds = s.feeds || {};
        return {
          needs_confirmation: true,
          kind: 'digest',
          to: cleaned,
          subject: digest.subject,
          hours: hrs,
          sections: includedSections,
          stats: {
            spocLast24h: includedSections.includes('spoc')        ? (s.spocLast24h || 0) : null,
            frLast24h:   includedSections.includes('fr')          ? (s.frLast24h   || 0) : null,
            competitive: includedSections.includes('competitive') ? (feeds.product || 0) : null,
            analyst:     includedSections.includes('analyst')     ? (feeds.analyst || 0) : null,
            news:        includedSections.includes('news')        ? (feeds.news    || 0) : null,
          },
          message: `Awaiting user confirmation in the UI before sending the ${hrs}h digest (sections: ${includedSections.join(', ')}) to ${cleaned.join(', ')}. Reply with ONE short sentence asking them to confirm in the dialog.`,
        };
      }

      try {
        const out = await mailer.sendMail({
          to: cleaned, subject: digest.subject, html: digest.html, text: digest.text,
        });
        return {
          ok: true,
          to: cleaned,
          subject: digest.subject,
          sections: includedSections,
          messageId: (out && out.messageId) || null,
          stats: digest.stats,
          message: `Sent ${hrs}h digest (${includedSections.join(', ')}) to ${cleaned.join(', ')}.`,
        };
      } catch (e) {
        return { error: `sendMail failed: ${e.message}` };
      }
    },
  },
];

const byName = Object.fromEntries(tools.map(t => [t.name, t]));

// OpenAI/GitHub-Models tool spec format.
const toolSpecs = tools.map(t => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters || { type: 'object', properties: {} },
  },
}));

async function runTool(name, args, ctx) {
  const tool = byName[name];
  if (!tool) return { error: `Unknown tool '${name}'` };
  try {
    const out = await tool.run(args || {}, ctx || {});
    return out == null ? { ok: true } : out;
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { toolSpecs, runTool };
