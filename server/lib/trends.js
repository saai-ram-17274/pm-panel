// Trend analysis over releases, feature_requests, product_features and raw_items.
// Pure SQL + JS aggregation — no external services.

const STOPWORDS = new Set((
  'the a an and or for of to in on with by from is are was were be been being ' +
  'this that these those it its as at we you they our your their i me my mine ' +
  'new now then than but not no yes can will would should could may might must ' +
  'have has had do does did so if when while where which who whom whose what why ' +
  'how all any some more most less few many much each every other another into ' +
  'over under up down out off about across against among between through during ' +
  'before after above below within without via per release version update updates ' +
  'feature features support supports supported support introduces introducing ' +
  'available available announce announcing announces today including includes ' +
  'improve improved improvement improvements add added adding general availability ' +
  'now also still just only one two three first second third'
).split(/\s+/));

function monthsAgoIso(months) {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

function quarterKey(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${q}`;
}

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

function computeTrends(db, opts = {}) {
  const months = Math.max(1, Math.min(36, +opts.months || 12));
  const since = monthsAgoIso(months);
  const halfSince = monthsAgoIso(Math.floor(months / 2));

  // === Category trends: combine releases (highlights → features?) and product_features deltas
  // Simpler: count feature_requests per category in window vs prior window, plus
  // product_features supported entries grouped by feature category.
  const categoryRows = db.prepare(`
    SELECT f.category AS category,
           COUNT(DISTINCT fr.id) AS request_count,
           COUNT(DISTINCT CASE WHEN fr.created_at >= ? THEN fr.id END) AS recent_requests,
           COUNT(DISTINCT CASE WHEN pf.supported = 1 AND p.is_own = 0 AND COALESCE(p.kind,'product') = 'product' THEN p.id || ':' || f.id END) AS competitor_support_count
    FROM features f
    LEFT JOIN feature_requests fr ON fr.feature_id = f.id
    LEFT JOIN product_features pf ON pf.feature_id = f.id
    LEFT JOIN products p ON p.id = pf.product_id
    GROUP BY f.category
    ORDER BY recent_requests DESC, competitor_support_count DESC
  `).all(halfSince);

  // === Hot features: most competitor-supported, with our coverage flag
  const own = db.prepare('SELECT id, name FROM products WHERE is_own = 1').get();
  const hotFeatures = db.prepare(`
    SELECT f.id, f.name, f.category,
           COUNT(DISTINCT CASE WHEN p.is_own = 0 AND COALESCE(p.kind,'product') = 'product' AND pf.supported = 1 THEN p.id END) AS competitor_count,
           MAX(CASE WHEN p.is_own = 1 AND pf.supported = 1 THEN 1 ELSE 0 END) AS we_support,
           (SELECT COUNT(*) FROM feature_requests fr WHERE fr.feature_id = f.id AND fr.created_at >= ?) AS recent_requests
    FROM features f
    LEFT JOIN product_features pf ON pf.feature_id = f.id
    LEFT JOIN products p ON p.id = pf.product_id
    GROUP BY f.id
    ORDER BY competitor_count DESC, recent_requests DESC, f.name
    LIMIT 15
  `).all(halfSince);

  // === Release velocity per product, last 4 quarters
  const releases = db.prepare(`
    SELECT r.id, r.product_id, r.release_date, p.name AS product_name, p.is_own
    FROM releases r JOIN products p ON p.id = r.product_id
    WHERE r.release_date IS NOT NULL AND r.release_date >= ?
  `).all(monthsAgoIso(12));

  const velocityMap = {}; // product -> { quarter: count }
  const quarterSet = new Set();
  for (const r of releases) {
    const q = quarterKey(r.release_date);
    if (!q) continue;
    quarterSet.add(q);
    if (!velocityMap[r.product_id]) {
      velocityMap[r.product_id] = { product_id: r.product_id, product_name: r.product_name, is_own: r.is_own, quarters: {} };
    }
    velocityMap[r.product_id].quarters[q] = (velocityMap[r.product_id].quarters[q] || 0) + 1;
  }
  const quarters = [...quarterSet].sort();
  const release_velocity = Object.values(velocityMap).map(v => ({
    product_id: v.product_id,
    product_name: v.product_name,
    is_own: v.is_own,
    total: Object.values(v.quarters).reduce((a, b) => a + b, 0),
    by_quarter: quarters.map(q => ({ quarter: q, count: v.quarters[q] || 0 })),
  })).sort((a, b) => b.total - a.total);

  // === Emerging keywords: from recent raw_items + release highlights
  const recentText = [];
  try {
    const items = db.prepare(`SELECT title, content FROM raw_items WHERE fetched_at >= ?`).all(since);
    for (const it of items) recentText.push(it.title || '', (it.content || '').slice(0, 4000));
  } catch (_) { /* table may be missing in old DBs */ }
  const recentHighlights = db.prepare(`SELECT highlights FROM releases WHERE release_date IS NULL OR release_date >= ?`).all(since);
  for (const h of recentHighlights) recentText.push(h.highlights || '');

  const olderText = [];
  try {
    const olderItems = db.prepare(`SELECT title, content FROM raw_items WHERE fetched_at < ? AND fetched_at >= ?`).all(since, monthsAgoIso(months * 2));
    for (const it of olderItems) olderText.push(it.title || '', (it.content || '').slice(0, 4000));
  } catch (_) {}
  const olderHighlights = db.prepare(`SELECT highlights FROM releases WHERE release_date < ? AND release_date >= ?`).all(since, monthsAgoIso(months * 2));
  for (const h of olderHighlights) olderText.push(h.highlights || '');

  const recentFreq = {}, olderFreq = {};
  for (const w of tokenize(recentText.join(' '))) recentFreq[w] = (recentFreq[w] || 0) + 1;
  for (const w of tokenize(olderText.join(' '))) olderFreq[w] = (olderFreq[w] || 0) + 1;

  const emerging_keywords = Object.entries(recentFreq)
    .filter(([w, c]) => c >= 2)
    .map(([w, c]) => ({ keyword: w, recent: c, older: olderFreq[w] || 0, delta: c - (olderFreq[w] || 0) }))
    .sort((a, b) => b.delta - a.delta || b.recent - a.recent)
    .slice(0, 20);

  // === Our position vs top hot features
  const topHot = hotFeatures.slice(0, 10);
  const covered = topHot.filter(f => f.we_support === 1).length;
  const coverage_pct = topHot.length ? Math.round((covered / topHot.length) * 100) : 0;

  // === Adoption signal: features supported by ≥2 competitors that we don't support
  const adoption_signal = hotFeatures
    .filter(f => f.competitor_count >= 2 && f.we_support === 0)
    .slice(0, 10);

  return {
    window: { months, since, half_since: halfSince },
    quarters,
    category_trends: categoryRows,
    hot_features: hotFeatures,
    release_velocity,
    emerging_keywords,
    our_position: {
      own_product: own ? own.name : null,
      top_hot_total: topHot.length,
      covered,
      coverage_pct,
    },
    adoption_signal,
  };
}

module.exports = { computeTrends, computeCompetitorReport };

function computeCompetitorReport(db, opts = {}) {
  const months = Math.max(1, Math.min(36, +opts.months || 6));
  const since = monthsAgoIso(months);
  const competitors = db.prepare("SELECT * FROM products WHERE is_own = 0 AND COALESCE(kind,'product') = 'product' ORDER BY name").all();
  const own = db.prepare('SELECT id, name FROM products WHERE is_own = 1').get();

  const report = competitors.map(c => {
    const releases = db.prepare(`
      SELECT id, version, release_date, highlights, url, auto_generated
      FROM releases
      WHERE product_id = ? AND (release_date IS NULL OR release_date >= ?)
      ORDER BY release_date DESC NULLS LAST, id DESC
      LIMIT 10
    `).all(c.id, since);

    const allReleases = db.prepare(`SELECT release_date FROM releases WHERE product_id = ?`).all(c.id);
    const latest = allReleases.map(r => r.release_date).filter(Boolean).sort().pop() || null;

    const newFeatures = db.prepare(`
      SELECT f.id, f.name, f.category, pf.since_version, pf.notes
      FROM product_features pf
      JOIN features f ON f.id = pf.feature_id
      WHERE pf.product_id = ? AND pf.supported = 1
      ORDER BY f.category, f.name
    `).all(c.id);

    const ourSupport = own ? db.prepare(`
      SELECT feature_id FROM product_features WHERE product_id = ? AND supported = 1
    `).all(own.id).reduce((s, r) => s.add(r.feature_id) && s, new Set()) : new Set();

    const exclusiveFeatures = newFeatures.filter(f => !ourSupport.has(f.id));

    const recentRequests = db.prepare(`
      SELECT fr.id, fr.title, fr.priority, fr.status, fr.confidence, fr.created_at, f.category
      FROM feature_requests fr
      LEFT JOIN features f ON f.id = fr.feature_id
      WHERE fr.source_product_id = ? AND fr.created_at >= ?
      ORDER BY fr.created_at DESC
      LIMIT 15
    `).all(c.id, since);

    const rawCount = (() => {
      try { return db.prepare(`SELECT COUNT(*) c FROM raw_items WHERE product_id = ? AND fetched_at >= ?`).get(c.id, since).c; }
      catch (_) { return 0; }
    })();

    // Themes = top categories by count of supported features + recent requests
    const themeMap = {};
    for (const f of newFeatures) themeMap[f.category||'Other'] = (themeMap[f.category||'Other']||0) + 1;
    for (const r of recentRequests) themeMap[r.category||'Other'] = (themeMap[r.category||'Other']||0) + 1;
    const themes = Object.entries(themeMap).map(([k,v])=>({category:k,count:v})).sort((a,b)=>b.count-a.count).slice(0,5);

    // Keyword highlights from release.highlights in window
    const text = releases.map(r => r.highlights || '').join(' ');
    const freq = {};
    for (const w of tokenize(text)) freq[w] = (freq[w]||0)+1;
    const keywords = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([w,c])=>({keyword:w,count:c}));

    return {
      product_id: c.id,
      product_name: c.name,
      vendor: c.vendor,
      website: c.website,
      latest_release_date: latest,
      release_count_window: releases.length,
      raw_items_window: rawCount,
      releases,
      new_features_count: newFeatures.length,
      exclusive_features_count: exclusiveFeatures.length,
      exclusive_features: exclusiveFeatures.slice(0, 10),
      recent_requests: recentRequests,
      themes,
      keywords,
    };
  });

  return {
    window: { months, since },
    own_product: own ? own.name : null,
    competitors: report.sort((a,b) => (b.release_count_window + b.exclusive_features_count) - (a.release_count_window + a.exclusive_features_count)),
  };
}
