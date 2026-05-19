// Renders the daily digest sent at 21:00 IST:
//   * SPOC summary  — total tickets, fully-read / untouched, top open by priority
//   * Feed activity — last-24h counts of raw_items grouped by product_kind
//                     (catalog = competitive, analyst, news)
//
// Pure builder — returns { subject, html, text }. The mailer/scheduler decide
// when/how to dispatch.
const db = require('../db');
const spoc = require('./spoc');
const featureRequests = require('./feature-requests');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function feedCounts(hours = 24) {
  const rows = db.prepare(`
    SELECT COALESCE(p.kind, 'product') AS kind, COUNT(*) AS c
      FROM raw_items r
      JOIN products p ON p.id = r.product_id
     WHERE r.fetched_at >= datetime('now', ?)
     GROUP BY COALESCE(p.kind, 'product')
  `).all(`-${hours} hours`);
  const byKind = { product: 0, analyst: 0, news: 0 };
  for (const r of rows) byKind[r.kind] = r.c;
  return byKind;
}

function recentFeedItems(kind, limit = 5, hours = 24) {
  // Industry-news items all share one umbrella product called "Industry News"
  // — the actual outlet (Dark Reading, SecurityWeek, …) lives in sources.label.
  // Prefer the source label when present so the digest shows the real outlet.
  return db.prepare(`
    SELECT r.id, r.title, r.url, r.published_at, r.fetched_at,
           COALESCE(NULLIF(TRIM(s.label), ''), p.name) AS product
      FROM raw_items r
      JOIN products p ON p.id = r.product_id
 LEFT JOIN sources  s ON s.id = r.source_id
     WHERE COALESCE(p.kind, 'product') = ?
       AND r.fetched_at >= datetime('now', ?)
     ORDER BY COALESCE(r.published_at, r.fetched_at) DESC
     LIMIT ?
  `).all(kind, `-${hours} hours`, limit);
}

// Return SPOC tickets whose sheet `Time` column falls within the last `hours`
// (defaults to 24h). Uses spoc.listEntries' built-in date filter (which works
// on calendar dates), and additionally pulls back rows whose `first_seen`
// (our ingest timestamp) is within the window so brand-new tickets show up
// even if their Time cell is missing/un-parseable.
function spocLast24h(hours = 24) {
  const ymd = (d) => {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const now = new Date();
  // Window = previous calendar day + today, so a 24h digest at 21:00 always
  // covers yesterday-evening through now.
  const from = ymd(new Date(now.getTime() - hours * 3600 * 1000));
  const out = spoc.listEntries({ from, to: ymd(now), limit: 500, offset: 0 });
  const fixedByLabel = Object.fromEntries((out.fixedColumns || []).map(c => [c.label, c.key]));
  const cutoff = new Date(now.getTime() - hours * 3600 * 1000).toISOString();
  const items = (out.items || []).map(r => ({
    ackKey: r.ackKey,
    ticketId: r.data[fixedByLabel['Ticket ID']] || '',
    summary: r.data[fixedByLabel['Query Summary']] || '',
    priority: r.data[fixedByLabel['Priority']] || '',
    module: r.data[fixedByLabel['Module']] || '',
    product: r.data[fixedByLabel['Product']] || '',
    cxType: r.data[fixedByLabel['Cx Type']] || '',
    sender: r.data[fixedByLabel['Sender']] || '',
    time: r.data[fixedByLabel['Time']] || r.first_seen,
    messageLink: r.data[fixedByLabel['Message Link']] || '',
    sheet: r.sheet,
    first_seen: r.first_seen,
  }))
  // Date filter above is calendar-day based, so trim to a strict 24h window
  // by also requiring `first_seen >= cutoff` OR a valid Time cell.
  .filter(r => (r.first_seen || '') >= cutoff || r.time);
  return items;
}

// Feature Requests in the last `hours` — mirrors spocLast24h. The FR sheet
// uses different column names ("Created Time", "FR Name", "CRM Link"…) so we
// project them into the same shape the email template renders.
function frLast24h(hours = 24) {
  const ymd = (d) => {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const now = new Date();
  const from = ymd(new Date(now.getTime() - hours * 3600 * 1000));
  const out = featureRequests.listEntries({ from, to: ymd(now), limit: 500, offset: 0 });
  const cutoff = new Date(now.getTime() - hours * 3600 * 1000).toISOString();
  const cols = (out.fixedColumns || []).map(c => c.key);
  const findCol = (rx) => cols.find(k => rx.test(k)) || '';
  const titleCol = findCol(/^(FR Name|Title|Summary|Subject|Query Summary)$/i)
    || findCol(/title|summary|name|subject/i);
  const idCol    = findCol(/^(Ticket ID|Desk Ticket ID|FR ID|Request ID|ID)$/i);
  const timeCol  = out.dateKey || findCol(/created|time|date/i);
  const linkCol  = findCol(/^Message Link$/i);
  const crmCol   = findCol(/^CRM Link$/i);
  const descCol  = findCol(/^(Query \/ Description|Description|Notes)$/i);

  const items = (out.items || []).map(r => ({
    ackKey: r.ackKey,
    ticketId: idCol ? (r.data[idCol] || '') : '',
    title: titleCol ? (r.data[titleCol] || '') : '',
    description: descCol ? (r.data[descCol] || '') : '',
    priority: r.data['Priority'] || '',
    product: r.data['Product'] || '',
    module: r.data['Module'] || '',
    owner: r.data['Owner'] || '',
    requestType: r.data['Request Type'] || '',
    time: timeCol ? (r.data[timeCol] || r.first_seen) : r.first_seen,
    messageLink: linkCol ? (r.data[linkCol] || '') : '',
    crmLink: crmCol ? (r.data[crmCol] || '') : '',
    first_seen: r.first_seen,
  }))
  .filter(r => (r.first_seen || '') >= cutoff || r.time);
  return items;
}

function build({ hours = 24, sections: wantSections } = {}) {
  // Sections filter: when omitted/empty, include everything (back-compat with
  // the scheduled 21:00 IST digest). Allowed values: 'spoc', 'fr',
  // 'competitive', 'analyst', 'news'. Anything else is ignored.
  const ALL = ['spoc', 'fr', 'competitive', 'analyst', 'news'];
  const wanted = Array.isArray(wantSections) && wantSections.length
    ? new Set(wantSections.map(s => String(s).toLowerCase()).filter(s => ALL.includes(s)))
    : new Set(ALL);
  const want = (k) => wanted.has(k);

  const s = spoc.summary();
  const feeds = feedCounts(hours);
  const last24 = want('spoc') ? spocLast24h(hours) : [];
  const frLast = want('fr') ? frLast24h(hours) : [];
  const frSummary = want('fr') ? featureRequests.summary() : null;
  const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata',
    day: '2-digit', month: 'short', year: 'numeric' });

  const topPriority = (s.byPriority || []).slice(0, 5);
  const topModule = (s.byModule || []).slice(0, 5);
  const recent = (s.recent || []).slice(0, 8);

  // Per-section row caps for the email body. Set high enough that "showing N
  // of M" footnotes are rare — the digest is a long-form email, not a teaser.
  // The cards at the top still show the true 24h totals from feedCounts().
  const SECTION_LIMIT = 200;
  const sections = {
    competitive: want('competitive') ? recentFeedItems('product', SECTION_LIMIT, hours) : [],
    analyst:     want('analyst')     ? recentFeedItems('analyst', SECTION_LIMIT, hours) : [],
    news:        want('news')        ? recentFeedItems('news', SECTION_LIMIT, hours)    : [],
  };

  const css = `
    body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; color:#1f2937; line-height:1.45; }
    h2 { color:#111827; border-bottom:1px solid #e5e7eb; padding-bottom:4px; margin-top:24px; }
    h3 { color:#374151; margin-top:16px; margin-bottom:6px; }
    table { border-collapse:collapse; width:100%; font-size:13px; }
    th, td { text-align:left; padding:6px 8px; border-bottom:1px solid #e5e7eb; vertical-align:top; }
    th { background:#f3f4f6; font-weight:600; }
    .pill { display:inline-block; padding:2px 8px; border-radius:10px; font-size:12px; background:#eef2ff; color:#3730a3; margin-right:4px; }
    .muted { color:#6b7280; font-size:12px; }
    .grid { display:flex; gap:16px; flex-wrap:wrap; }
    .card { background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:12px 14px; min-width:170px; }
    .num { font-size:22px; font-weight:700; color:#111827; }
  `;

  const cards = `
    <div class="grid">
      ${want('spoc') ? `<div class="card"><div class="muted">SPOC last ${hours}h</div><div class="num">${last24.length}</div></div>` : ''}
      ${want('fr') ? `<div class="card"><div class="muted">Feature Requests last ${hours}h</div><div class="num">${frLast.length}</div></div>` : ''}
      ${want('competitive') ? `<div class="card"><div class="muted">Competitive (${hours}h)</div><div class="num">${feeds.product || 0}</div></div>` : ''}
      ${want('analyst') ? `<div class="card"><div class="muted">Analyst (${hours}h)</div><div class="num">${feeds.analyst || 0}</div></div>` : ''}
      ${want('news') ? `<div class="card"><div class="muted">News (${hours}h)</div><div class="num">${feeds.news || 0}</div></div>` : ''}
    </div>`;

  const breakdown = (title, rows) => rows.length ? `
    <h3>${esc(title)}</h3>
    <table><thead><tr><th>${esc(title)}</th><th style="width:80px;text-align:right">Count</th></tr></thead>
    <tbody>${rows.map(r => `<tr><td>${esc(r.label)}</td><td style="text-align:right">${r.count}</td></tr>`).join('')}</tbody></table>` : '';

  const last24Table = last24.length ? `
    <h3>SPOC tickets in last ${hours}h (${last24.length})</h3>
    <table><thead><tr>
      <th>Time</th><th>Ticket</th><th>Priority</th><th>Product / Module</th><th>Summary</th><th>Link</th>
    </tr></thead>
    <tbody>${last24.map(r => `
      <tr>
        <td>${esc(String(r.time || '').slice(0, 19))}</td>
        <td>${esc(r.ticketId || '—')}</td>
        <td>${esc(r.priority || '')}</td>
        <td>${esc([r.product, r.module].filter(Boolean).join(' · '))}</td>
        <td>${esc(String(r.summary || '').slice(0, 240))}</td>
        <td>${r.messageLink ? `<a href="${esc(r.messageLink)}">open</a>` : ''}</td>
      </tr>`).join('')}</tbody></table>` : `<p class="muted">No new SPOC tickets in last ${hours}h.</p>`;

  const recentSpoc = recent.length ? `
    <h3>Latest activity (top ${recent.length})</h3>
    <table><thead><tr><th>Ticket</th><th>Priority</th><th>Product / Module</th><th>Summary</th><th>Link</th></tr></thead>
    <tbody>${recent.map(r => `
      <tr>
        <td>${esc(r.ticketId || '—')}</td>
        <td>${esc(r.priority || '')}</td>
        <td>${esc([r.product, r.module].filter(Boolean).join(' · '))}</td>
        <td>${esc(String(r.summary || '').slice(0, 200))}</td>
        <td>${r.messageLink ? `<a href="${esc(r.messageLink)}">open</a>` : ''}</td>
      </tr>`).join('')}</tbody></table>` : '<p class="muted">No recent SPOC activity.</p>';

  const feedBlock = (label, items, total) => {
    const shown = items.length;
    const totalN = (typeof total === 'number') ? total : shown;
    const countTag = totalN ? ` (${totalN}${shown < totalN ? `, showing ${shown}` : ''})` : '';
    if (!shown) return `<p class="muted">No ${esc(label)} items in last ${hours}h.</p>`;
    return `<p class="muted" style="margin:4px 0 6px 0">${esc(label)}${countTag}</p>` +
      `<table><thead><tr><th>Source</th><th>Title</th></tr></thead><tbody>${
      items.map(i => `<tr>
        <td>${esc(i.product)}</td>
        <td>${i.url ? `<a href="${esc(i.url)}">${esc(i.title || i.url)}</a>` : esc(i.title || '')}</td>
      </tr>`).join('')
    }</tbody></table>`;
  };

  const spocBlock = want('spoc') ? `
    <h2>SPOC</h2>
    ${last24Table}
    ${recentSpoc}` : '';

  // Feature Requests block — simple Product/Module · Title list, same shape
  // as the feed blocks below. Link is the CRM record (or chat link if any).
  const frList = frLast.length ? `
    <p class="muted" style="margin:4px 0 6px 0">Feature Requests (${frLast.length})</p>
    <table><thead><tr><th>Source</th><th>Request</th></tr></thead>
    <tbody>${frLast.map(r => {
      const link = r.crmLink || r.messageLink || '';
      const src = [r.product, r.module].filter(Boolean).join(' · ') || (r.requestType || '');
      const title = String(r.title || r.description || '').trim() || '(no title)';
      return `<tr>
        <td>${esc(src)}</td>
        <td>${link ? `<a href="${esc(link)}">${esc(title)}</a>` : esc(title)}</td>
      </tr>`;
    }).join('')}</tbody></table>` : `<p class="muted">No new Feature Requests in last ${hours}h.</p>`;

  const frBlock = want('fr') ? `
    <h2>Feature Requests (last ${hours}h)</h2>
    ${frList}` : '';

  const feedsAnyWanted = want('competitive') || want('analyst') || want('news');
  const feedsBlock = feedsAnyWanted ? `
    <h2>Feeds (last ${hours}h)</h2>
    ${want('competitive') ? `<h3>Competitive</h3>${feedBlock('competitive', sections.competitive, feeds.product || 0)}` : ''}
    ${want('analyst') ? `<h3>Analyst</h3>${feedBlock('analyst', sections.analyst, feeds.analyst || 0)}` : ''}
    ${want('news') ? `<h3>Industry news</h3>${feedBlock('news', sections.news, feeds.news || 0)}` : ''}` : '';

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
    <h2 style="margin-top:0">Daily PM digest · ${esc(today)}</h2>
    ${cards}
    ${spocBlock}
    ${frBlock}
    ${feedsBlock}
    <p class="muted" style="margin-top:24px">Sent automatically by pm-panel.</p>
  </body></html>`;

  // Subject line reflects only the requested sections so partial sends are
  // self-describing (e.g. "PM digest · SPOC 24h 5" when only SPOC was asked).
  const subjBits = [`PM digest · ${today}`];
  if (want('spoc')) subjBits.push(`SPOC ${hours}h ${last24.length}`);
  if (want('fr'))   subjBits.push(`FR ${hours}h ${frLast.length}`);
  if (feedsAnyWanted) {
    const feedTotal = (want('competitive') ? (feeds.product || 0) : 0)
                    + (want('analyst')     ? (feeds.analyst || 0) : 0)
                    + (want('news')        ? (feeds.news || 0)    : 0);
    subjBits.push(`Feeds ${feedTotal}`);
  }
  const subject = subjBits.join(' · ');

  const textBits = [`Daily PM digest · ${today}`];
  if (want('spoc')) textBits.push(`SPOC last ${hours}h: ${last24.length} tickets (total ${s.total || 0})`);
  if (want('fr'))   textBits.push(`Feature Requests last ${hours}h: ${frLast.length} (total ${(frSummary && frSummary.total) || 0})`);
  if (feedsAnyWanted) {
    const parts = [];
    if (want('competitive')) parts.push(`competitive=${feeds.product || 0}`);
    if (want('analyst'))     parts.push(`analyst=${feeds.analyst || 0}`);
    if (want('news'))        parts.push(`news=${feeds.news || 0}`);
    textBits.push(`Feeds (${hours}h): ${parts.join(' · ')}`);
  }
  const text = textBits.join('\n') + '\n';

  return {
    subject,
    html,
    text,
    sections: [...wanted],
    stats: {
      spocLast24h: last24.length, spocTotal: s.total || 0,
      frLast24h: frLast.length, frTotal: (frSummary && frSummary.total) || 0,
      feeds, recentSpoc: recent.length,
    },
  };
}

module.exports = { build, feedCounts, recentFeedItems, spocLast24h, frLast24h };
