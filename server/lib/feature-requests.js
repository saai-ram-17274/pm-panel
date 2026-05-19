// Feature Request sheet ingest.
//
// Mirrors lib/spoc.js (same workflow: configurable Zoho WorkDrive share URL →
// headless-Chromium download → parse XLSX/CSV → dedup → store in SQLite).
// Differences from SPOC:
//   * Schema-agnostic: every header in the sheet is treated as a "fixed"
//     column — there is no per-person read-tracker concept. If the sheet
//     ever grows person columns we can promote them to a tracker the same
//     way SPOC does.
//   * Dedup key: prefers an "ID" / "FR ID" / "Request ID" / "Ticket ID"
//     column; falls back to a stable row-hash.
//   * Tables prefixed `fr_` so they don't collide with the long-standing
//     `feature_requests` table seeded in db.js.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const xlsx = require('xlsx');
const db = require('../db');

const INBOX_DIR = process.env.FR_INBOX_DIR
  || path.join(os.homedir(), 'pm-panel', 'feature-request-inbox');

const SETTING_URL = 'fr_download_url';
const SETTING_ME  = 'fr_me';
// The default share URL the user provided. Used only when no URL has been
// saved yet — the user can change it from Settings → Feature Requests.
const DEFAULT_URL = 'https://workdrive.zohoexternal.in/external/eaf3b4a8674991346fbada6eeb5feff656f09f5adc267bdebbc87160c08c978d/download';

function sniffFormat(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'xlsx';
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'xls';
  const head = buf.slice(0, Math.min(buf.length, 1024)).toString('utf8');
  if (/^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]+$/.test(head) && /[\,;\t]/.test(head) && /\n/.test(head)) return 'csv';
  return null;
}

function readSetting(key) {
  try { return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || null; }
  catch (_) { return null; }
}
function writeSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`)
    .run(key, String(value || ''));
}
function getDownloadUrl() {
  const v = readSetting(SETTING_URL);
  if (v != null) return v; // explicitly set (possibly to '')
  // First boot — seed the user-provided default so the scheduler has
  // something to fetch immediately.
  writeSetting(SETTING_URL, DEFAULT_URL);
  return DEFAULT_URL;
}
function setDownloadUrl(u) { writeSetting(SETTING_URL, u || ''); }
function getMe() { return readSetting(SETTING_ME) || ''; }
function setMe(p) { writeSetting(SETTING_ME, p || ''); }

// Likely identity columns for a feature-request row, in priority order. The
// first match (case/space-insensitive) becomes the dedup key for that row.
const ID_COLUMN_ALIASES = [
  'FR ID', 'Feature Request ID', 'Request ID', 'Request Id',
  'ID', 'Id', 'Ticket ID', 'Ticket Id',
];
function findIdColumn(data) {
  if (!data) return null;
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const aliasSet = new Set(ID_COLUMN_ALIASES.map(norm));
  for (const k of Object.keys(data)) {
    if (aliasSet.has(norm(k))) return k;
  }
  return null;
}

// Allow-list of real Feature-Request fields. Any other header discovered in
// the source sheet (typically per-person ack columns like "Sundar", "Saairam"
// …) is treated as a tracker column and hidden from the entries table and
// dashboard dimensions — same pattern SPOC uses.
const FR_FIXED_COLUMNS = [
  'Created Time', 'Time',
  'Ticket ID', 'Desk Ticket ID', 'FR ID', 'Request ID', 'ID',
  'FR Name', 'Title', 'Summary', 'Subject',
  'Priority', 'Status',
  'Product', 'Module', 'Platform', 'Category',
  'Cx Domain', 'Cx Type', 'Customer',
  'Owner', 'Assignee', 'Reporter',
  'Request Type', 'Request Email', 'Sender',
  'Build Number',
  'Query Summary', 'Query / Description', 'Description', 'Notes',
  'CRM Link', 'CRM Record ID', 'Message Link',
];
const FR_FIXED_NORM = new Set(FR_FIXED_COLUMNS.map(s => s.replace(/\s+/g, '').toLowerCase()));
function isFixedFRColumn(h) {
  const n = String(h || '').replace(/\s+/g, '').toLowerCase();
  if (FR_FIXED_NORM.has(n)) return true;
  if (/^query[\/_ ]?desc/i.test(h)) return true;
  if (/^message[ _]?link$/i.test(h)) return true;
  if (/^cx[ _]?(domain|type)$/i.test(h)) return true;
  if (/^build[ _]?(no|number)$/i.test(h)) return true;
  if (/^(ticket|desk[ _]?ticket|request|fr)[ _]?id$/i.test(h)) return true;
  if (/^(created|updated|modified)[ _]?(time|date|at)$/i.test(h)) return true;
  return false;
}
function ackKey(data, rowHash) {
  const k = findIdColumn(data);
  if (k && data[k] != null && String(data[k]).trim()) return `id:${String(data[k]).trim()}`;
  return `hash:${rowHash}`;
}

async function tryDownloadToInbox(onProgress) {
  const emit = (stage, pct, detail) => { try { onProgress && onProgress(stage, pct, detail); } catch (_) {} };
  const url = getDownloadUrl();
  if (!url) { emit('download', 100, 'no remote URL configured — using inbox only'); return { attempted: false }; }
  ensureInbox();
  emit('download', 5, 'fetching remote URL');
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel, text/csv, */*',
      },
    });
    if (res.ok) {
      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      const dispo = res.headers.get('content-disposition') || '';
      const buf = Buffer.from(await res.arrayBuffer());
      const sniffed = sniffFormat(buf);
      const isHtml = ctype.includes('text/html');
      const looksLikeFile = !isHtml && (sniffed
        || ctype.includes('spreadsheet') || ctype.includes('excel')
        || ctype.includes('officedocument') || ctype.includes('text/csv')
        || ctype.includes('octet-stream'));
      if (looksLikeFile) {
        let filename = '';
        const m = dispo.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
        if (m) filename = decodeURIComponent(m[1]).replace(/^"|"$/g, '');
        if (!filename) {
          const ext = sniffed || (ctype.includes('csv') ? 'csv' : 'xlsx');
          filename = `fr-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
        }
        const full = path.join(INBOX_DIR, filename);
        fs.writeFileSync(full, buf);
        emit('download', 35, `downloaded ${filename} (${buf.length} bytes via http)`);
        return { attempted: true, ok: true, file: filename, bytes: buf.length, via: 'http', sniffed, contentType: ctype };
      }
    }
  } catch (_) { /* fall through to browser path */ }
  emit('download', 12, 'http fetch returned a viewer page — launching headless Chromium');
  return await downloadViaBrowser(url, emit);
}

async function downloadViaBrowser(url, emit) {
  emit = emit || (() => {});
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (_) {
    return { attempted: true, ok: false,
      error: 'Playwright not installed — run `npm install playwright && npx playwright install chromium` in pm-panel/server' };
  }
  let browser;
  try {
    emit('download', 15, 'launching Chromium');
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    emit('download', 20, 'opening share URL');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    let clickedDownload = false;
    try {
      emit('download', 25, 'waiting for Download button');
      await page.waitForSelector('button:has-text("Download"), a[download]', { timeout: 30000 });
      clickedDownload = true;
    } catch (_) {}
    emit('download', 28, clickedDownload ? 'clicking Download' : 'no Download button found — waiting for auto download');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }).catch(() => null),
      clickedDownload
        ? page.click('button:has-text("Download"), a[download]', { timeout: 5000 }).catch(() => {})
        : Promise.resolve(),
    ]);
    if (!download) {
      return { attempted: true, ok: false, via: 'browser',
        error: 'no download event fired within 60s after clicking Download' };
    }
    const suggested = download.suggestedFilename() || `fr-${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`;
    const full = path.join(INBOX_DIR, suggested);
    emit('download', 32, `saving ${suggested}`);
    await download.saveAs(full);
    const bytes = (() => { try { return fs.statSync(full).size; } catch { return null; } })();
    emit('download', 38, `downloaded ${suggested} (${bytes || '?'} bytes via browser)`);
    return { attempted: true, ok: true, via: 'browser', file: suggested, bytes, sourceUrl: download.url() };
  } catch (e) {
    return { attempted: true, ok: false, via: 'browser', error: e.message };
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fr_imports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name   TEXT NOT NULL,
      file_sha256 TEXT NOT NULL UNIQUE,
      file_mtime  TEXT,
      rows_total  INTEGER NOT NULL DEFAULT 0,
      rows_new    INTEGER NOT NULL DEFAULT 0,
      sheets      TEXT,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS fr_entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      dedup_key   TEXT NOT NULL UNIQUE,
      row_hash    TEXT NOT NULL,
      sheet       TEXT,
      data_json   TEXT NOT NULL,
      source_file TEXT,
      first_seen  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_fr_entries_sheet ON fr_entries(sheet);
    CREATE TABLE IF NOT EXISTS fr_acks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ack_key    TEXT NOT NULL,
      person     TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'read',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(ack_key, person)
    );
    CREATE INDEX IF NOT EXISTS idx_fr_acks_key ON fr_acks(ack_key);
  `);
}
ensureSchema();

function ensureInbox() {
  try { fs.mkdirSync(INBOX_DIR, { recursive: true }); } catch (_) {}
}

function listInboxFiles() {
  ensureInbox();
  return fs.readdirSync(INBOX_DIR, { withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => {
      const full = path.join(INBOX_DIR, d.name);
      const st = fs.statSync(full);
      return { name: d.name, full, mtimeMs: st.mtimeMs, size: st.size };
    })
    .filter(f => /\.(xlsx|xls|csv)$/i.test(f.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

function normaliseRow(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) {
    let v = obj[k];
    if (v == null) continue;
    if (typeof v === 'string') v = v.trim();
    if (v === '') continue;
    out[k] = v;
  }
  return out;
}

function rowHash(sheet, normalised) {
  const h = crypto.createHash('sha256');
  h.update(sheet || '');
  h.update('\u0000');
  h.update(JSON.stringify(normalised));
  return h.digest('hex');
}

function parseFile(full) {
  const wb = xlsx.readFile(full, { cellDates: true, dateNF: 'yyyy-mm-dd' });
  const out = [];
  // The shared workbook usually carries both a "SPOC" tab and a "Feature
  // Requests" tab. Only ingest sheets that look like feature-request sheets;
  // otherwise we'd double-count SPOC rows here.
  const isFRSheet = (name) => /feature[\s_-]*request/i.test(String(name || ''));
  const frSheets = wb.SheetNames.filter(isFRSheet);
  // If the workbook has no obviously-FR-named sheet, fall back to all sheets
  // so we don't silently import nothing for a renamed file.
  const sheetList = frSheets.length ? frSheets : wb.SheetNames;
  for (const sheetName of sheetList) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const rows = xlsx.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null, raw: false });
    if (!rows.length) continue;
    let headerIdx = rows.findIndex(r => r.some(c => c != null && String(c).trim() !== ''));
    if (headerIdx < 0) continue;
    const headers = rows[headerIdx].map((c, i) => {
      const s = (c == null ? '' : String(c)).trim();
      return s || `col_${i + 1}`;
    });
    const data = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r.some(c => c != null && String(c).trim() !== '')) continue;
      const obj = {};
      for (let c = 0; c < headers.length; c++) {
        const v = r[c];
        if (v == null) continue;
        const s = typeof v === 'string' ? v.trim() : v;
        if (s === '') continue;
        obj[headers[c]] = s;
      }
      if (Object.keys(obj).length) data.push(obj);
    }
    out.push({ sheet: sheetName, headers, rows: data });
  }
  return out;
}

async function runImport({ force = false, onProgress } = {}) {
  const emit = (stage, pct, detail) => { try { onProgress && onProgress(stage, pct, detail); } catch (_) {} };
  const startedAt = Date.now();
  ensureInbox();
  emit('start', 1, 'starting import');
  const download = await tryDownloadToInbox(onProgress);
  emit('scan', 42, 'scanning inbox');
  const files = listInboxFiles();
  if (!files.length) {
    emit('done', 100, 'no files to import');
    return { startedAt, finishedAt: Date.now(), file: null, skipped: true,
             reason: download.attempted && !download.ok
               ? `remote download failed: ${download.error}`
               : `no .xlsx/.csv files in ${INBOX_DIR}`,
             download };
  }
  const f = files[0];
  emit('hash', 46, `hashing ${f.name}`);
  const sha = sha256File(f.full);
  if (!force) {
    const existing = db.prepare('SELECT id FROM fr_imports WHERE file_sha256=?').get(sha);
    if (existing) {
      emit('done', 100, 'already imported');
      return { startedAt, finishedAt: Date.now(), file: f.name, sha,
               skipped: true, reason: 'already imported (same sha256)', download };
    }
  }
  let sheets;
  try {
    emit('parse', 55, `parsing ${f.name}`);
    sheets = parseFile(f.full);
    const totalRows = sheets.reduce((n, s) => n + s.rows.length, 0);
    emit('parse', 65, `parsed ${sheets.length} sheet(s), ${totalRows} rows`);
  } catch (e) {
    emit('error', 100, `parse failed: ${e.message}`);
    return { startedAt, finishedAt: Date.now(), file: f.name, sha,
             error: `parse failed: ${e.message}`, download };
  }
  let rowsTotal = 0, rowsNew = 0;
  const ins = db.prepare(`INSERT INTO fr_entries
          (dedup_key, row_hash, sheet, data_json, source_file)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(dedup_key) DO UPDATE SET
            row_hash    = excluded.row_hash,
            sheet       = excluded.sheet,
            data_json   = excluded.data_json,
            source_file = excluded.source_file,
            last_seen   = CURRENT_TIMESTAMP`);
  const sel = db.prepare('SELECT id FROM fr_entries WHERE dedup_key=?');
  const totalRowsAcrossSheets = sheets.reduce((n, s) => n + s.rows.length, 0) || 1;
  let processed = 0, lastEmit = 0;
  const tx = db.transaction(() => {
    for (const s of sheets) {
      for (const row of s.rows) {
        rowsTotal++;
        const norm = normaliseRow(row);
        if (!Object.keys(norm).length) { processed++; continue; }
        const h = rowHash(s.sheet, norm);
        const key = ackKey(norm, h);
        const before = sel.get(key);
        ins.run(key, h, s.sheet, JSON.stringify(norm), f.name);
        if (!before) rowsNew++;
        processed++;
        if (processed - lastEmit >= 25 || processed === totalRowsAcrossSheets) {
          lastEmit = processed;
          const pct = 70 + Math.round((processed / totalRowsAcrossSheets) * 25);
          emit('write', pct, `writing rows ${processed}/${totalRowsAcrossSheets} (${rowsNew} new)`);
        }
      }
    }
    db.prepare(`INSERT OR REPLACE INTO fr_imports
                (file_name, file_sha256, file_mtime, rows_total, rows_new, sheets)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(f.name, sha, new Date(f.mtimeMs).toISOString(),
           rowsTotal, rowsNew, JSON.stringify(sheets.map(s => ({ sheet: s.sheet, rows: s.rows.length }))));
  });
  tx();
  let deleted = false;
  if (!process.env.FR_KEEP_FILES) {
    try { fs.unlinkSync(f.full); deleted = true; }
    catch (e) { console.warn(`[fr] could not delete ${f.full}: ${e.message}`); }
  }
  emit('done', 100, `imported ${rowsNew}/${rowsTotal} new rows from ${f.name}`);
  return { startedAt, finishedAt: Date.now(), file: f.name, sha,
           rowsTotal, rowsNew, sheets: sheets.map(s => ({ sheet: s.sheet, rows: s.rows.length })),
           download, deleted };
}

// Pick a likely "date" column from the discovered headers — anything whose
// name contains date/time/created/updated. Used for sorting and listing.
function findDateColumn(allKeys) {
  const candidates = ['Created Time', 'Created Date', 'Created At', 'Created',
                      'Date', 'Time', 'Timestamp', 'Updated', 'Updated At'];
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const have = new Set([...allKeys].map(norm));
  for (const c of candidates) if (have.has(norm(c))) {
    for (const k of allKeys) if (norm(k) === norm(c)) return k;
  }
  // Fall back: any key containing 'date' or 'time'
  for (const k of allKeys) if (/date|time/i.test(k)) return k;
  return null;
}

function listEntries({ q = '', sheet = '', from = '', to = '', limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (sheet) { where.push('sheet = ?'); params.push(sheet); }
  if (q) { where.push('data_json LIKE ?'); params.push(`%${q}%`); }
  const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const allKeys = new Set();
  for (const r of db.prepare('SELECT data_json FROM fr_entries').all()) {
    let d = {}; try { d = JSON.parse(r.data_json) || {}; } catch (_) {}
    for (const k of Object.keys(d)) allKeys.add(k);
  }
  const dateKey = findDateColumn(allKeys);

  const allRows = db.prepare(
    `SELECT id, row_hash, sheet, data_json, source_file, first_seen, last_seen
     FROM fr_entries ${wsql}
     ORDER BY id DESC`
  ).all(...params);

  const MONTHS = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',sept:'09',oct:'10',nov:'11',dec:'12' };
  const cellDateStr = (raw) => {
    if (raw == null || raw === '') return '';
    const s = String(raw).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})[\/\- ]([A-Za-z]{3,9})[\/\- ](\d{4})/);
    if (m) {
      const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mo) return `${m[3]}-${mo}-${String(m[1]).padStart(2,'0')}`;
    }
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (m) return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
    const t = new Date(s);
    if (!Number.isNaN(t.getTime())) {
      const y = t.getFullYear(), mo = String(t.getMonth()+1).padStart(2,'0'), d = String(t.getDate()).padStart(2,'0');
      return `${y}-${mo}-${d}`;
    }
    return '';
  };
  const fromStr = from && from.length >= 10 ? from.slice(0, 10) : '';
  const toStr   = to   && to.length   >= 10 ? to.slice(0, 10)   : '';
  const dateFiltered = (!fromStr && !toStr) ? allRows : allRows.filter(r => {
    if (!dateKey) return true;
    let d = {}; try { d = JSON.parse(r.data_json) || {}; } catch (_) {}
    const ds = cellDateStr(d[dateKey]);
    if (!ds) return false;
    if (fromStr && ds < fromStr) return false;
    if (toStr   && ds > toStr)   return false;
    return true;
  });

  const total = dateFiltered.length;
  const lim = Math.min(500, +limit || 100);
  const off = Math.max(0, +offset || 0);
  const rows = dateFiltered.slice(off, off + lim);

  // Allow-list of real Feature-Request fields — see isFixedFRColumn above.
  // Anything else (per-person ack columns) is hidden from the table.
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const fixedKeys = Array.from(allKeys).filter(isFixedFRColumn);
  const trackerKeys = Array.from(allKeys).filter(k => !isFixedFRColumn(k)).sort();

  const PRIORITY = ['Created Time', 'Time',
                    'Ticket ID', 'Desk Ticket ID', 'FR ID', 'Request ID', 'ID',
                    'FR Name', 'Title', 'Summary', 'Subject',
                    'Priority', 'Status', 'Product', 'Module', 'Category',
                    'Customer', 'Cx Domain', 'Owner', 'Assignee', 'Reporter'];
  const priorityOrder = new Map(PRIORITY.map((k, i) => [norm(k), i]));
  const keyList = fixedKeys.sort((a, b) => {
    // Date/time column always wins first place.
    if (a === dateKey && b !== dateKey) return -1;
    if (b === dateKey && a !== dateKey) return 1;
    const ai = priorityOrder.has(norm(a)) ? priorityOrder.get(norm(a)) : 100;
    const bi = priorityOrder.has(norm(b)) ? priorityOrder.get(norm(b)) : 100;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
  const fixedColumns = keyList.map(k => ({ key: k, label: k }));

  const items = rows.map(r => {
    let data = {};
    try { data = JSON.parse(r.data_json) || {}; } catch (_) {}
    return {
      id: r.id,
      rowHash: r.row_hash,
      ackKey: ackKey(data, r.row_hash),
      sheet: r.sheet,
      source_file: r.source_file,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      data,
    };
  });
  const sheets = db.prepare('SELECT DISTINCT sheet FROM fr_entries ORDER BY sheet').all().map(r => r.sheet);
  return {
    total,
    items,
    fixedColumns,
    trackerColumns: trackerKeys, // person-name columns from the source sheet (hidden in UI)
    sheets,
    me: getMe(),
    dateKey,
  };
}

function listImports({ limit = 50 } = {}) {
  return db.prepare(`SELECT id, file_name, file_sha256, file_mtime, rows_total, rows_new, sheets, imported_at
                     FROM fr_imports ORDER BY id DESC LIMIT ?`).all(Math.min(200, +limit || 50))
    .map(r => ({ ...r, sheets: safeJson(r.sheets) }));
}
function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } }

// Dashboard summary. Since the FR sheet schema is not pinned down, the
// breakdown bar charts are produced dynamically: any column with ≤25 distinct
// non-empty values across the dataset is treated as categorical and grouped.
function summary() {
  const rows = db.prepare('SELECT row_hash, sheet, source_file, data_json, first_seen FROM fr_entries').all();
  const total = rows.length;
  const parsed = rows.map(r => {
    let d = {}; try { d = JSON.parse(r.data_json) || {}; } catch (_) {}
    return { ...r, data: d };
  });

  const allKeys = new Set();
  for (const r of parsed) for (const k of Object.keys(r.data)) allKeys.add(k);
  const dateKey = findDateColumn(allKeys);

  // Build per-column value frequencies; pick columns with low cardinality
  // (excluding obvious ID / free-text columns).
  const freq = {};
  for (const k of allKeys) freq[k] = new Map();
  for (const r of parsed) {
    for (const k of Object.keys(r.data)) {
      const v = String(r.data[k] || '').trim();
      if (!v) continue;
      // Skip very long free-text values from cardinality calcs.
      if (v.length > 120) continue;
      freq[k].set(v, (freq[k].get(v) || 0) + 1);
    }
  }
  const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  const PRIORITY_DIM = new Set(['priority', 'status', 'product', 'module', 'category',
                                'severity', 'type', 'customer', 'cxdomain', 'cxtype',
                                'owner', 'assignee']);
  const SKIP = new Set([...ID_COLUMN_ALIASES.map(norm), 'title', 'summary', 'subject',
                        'description', 'name', 'notes', 'comment', 'comments',
                        'messagelink', 'url', 'link', 'reporter']);
  const dims = [];
  for (const k of allKeys) {
    const n = norm(k);
    if (SKIP.has(n)) continue;
    if (dateKey && k === dateKey) continue;
    // Skip per-person tracker columns (e.g. "Sundar", "Saairam") — they are
    // not real Feature Request fields, so they shouldn't appear as a dim.
    if (!isFixedFRColumn(k)) continue;
    const distinct = freq[k].size;
    if (distinct < 2 || distinct > 25) continue;
    const items = Array.from(freq[k].entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
    dims.push({ key: k, label: k, items, priority: PRIORITY_DIM.has(n) ? 0 : 1, distinct });
  }
  dims.sort((a, b) => a.priority - b.priority || b.items[0].count - a.items[0].count);

  const bySheet = {};
  for (const r of parsed) {
    if (r.sheet) bySheet[r.sheet] = (bySheet[r.sheet] || 0) + 1;
  }

  const lastImport = db.prepare(
    `SELECT id, file_name, file_mtime, rows_total, rows_new, imported_at
     FROM fr_imports ORDER BY id DESC LIMIT 1`
  ).get() || null;
  const importsCount = db.prepare('SELECT COUNT(*) c FROM fr_imports').get().c;

  const sortTs = (r) => {
    const v = dateKey ? r.data[dateKey] : null;
    if (v != null && v !== '') {
      if (typeof v === 'number' && v > 1 && v < 80000) return Math.round((v - 25569) * 86400 * 1000);
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
    const t2 = Date.parse(r.first_seen || '');
    return Number.isNaN(t2) ? 0 : t2;
  };
  // Pick a "title-ish" column for the recent feed.
  const titleKey = (() => {
    const want = ['Title', 'Summary', 'Subject', 'Name', 'Description'];
    const have = new Set([...allKeys].map(norm));
    for (const w of want) if (have.has(norm(w))) {
      for (const k of allKeys) if (norm(k) === norm(w)) return k;
    }
    return null;
  })();
  const idKey = (() => {
    for (const k of allKeys) if (ID_COLUMN_ALIASES.map(norm).includes(norm(k))) return k;
    return null;
  })();
  const recent = parsed
    .filter(r => titleKey ? (r.data[titleKey] || '').toString().trim() : true)
    .sort((a, b) => sortTs(b) - sortTs(a))
    .slice(0, 8)
    .map(r => ({
      ackKey: ackKey(r.data, r.row_hash),
      id: idKey ? (r.data[idKey] || '') : '',
      title: titleKey ? (r.data[titleKey] || '') : '',
      priority: r.data['Priority'] || r.data['priority'] || '',
      status: r.data['Status'] || r.data['status'] || '',
      product: r.data['Product'] || r.data['product'] || '',
      time: dateKey ? (r.data[dateKey] || r.first_seen) : r.first_seen,
      first_seen: r.first_seen,
      messageLink: r.data['Message Link'] || r.data['MessageLink'] || '',
      crmLink: r.data['CRM Link'] || r.data['CRMLink'] || '',
    }));

  return {
    total,
    importsCount,
    lastImport,
    dimensions: dims,
    bySheet: Object.entries(bySheet).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    recent,
    dateKey,
  };
}

function inboxStatus() {
  ensureInbox();
  const files = listInboxFiles().slice(0, 10).map(f => ({
    name: f.name, size: f.size, mtime: new Date(f.mtimeMs).toISOString(),
  }));
  return { dir: INBOX_DIR, files, downloadUrl: getDownloadUrl() };
}

function setAck({ ackKey: key, person, status }) {
  if (!key || !person) throw new Error('ackKey and person required');
  if (!status || status === 'unread' || status === 'open') {
    db.prepare('DELETE FROM fr_acks WHERE ack_key=? AND person=?').run(key, person);
    return { ack_key: key, person, status: 'unread' };
  }
  db.prepare(`INSERT INTO fr_acks (ack_key, person, status, updated_at)
              VALUES (?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(ack_key, person) DO UPDATE SET
                status = excluded.status,
                updated_at = CURRENT_TIMESTAMP`).run(key, person, status);
  return { ack_key: key, person, status };
}

module.exports = {
  INBOX_DIR,
  runImport,
  listEntries,
  listImports,
  inboxStatus,
  getDownloadUrl,
  setDownloadUrl,
  getMe,
  setMe,
  setAck,
  tryDownloadToInbox,
  summary,
};
