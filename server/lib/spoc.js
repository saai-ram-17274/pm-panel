// SPOC sheet ingest.
//
// Behaviour:
//   1. Watch ~/pm-panel/spoc-inbox/ (override with SPOC_INBOX_DIR).
//   2. Pick the newest .xlsx / .xls / .csv in there.
//   3. Skip if its sha256 already shows up in `spoc_imports` (file-level dedup).
//   4. Parse all sheets, take row 1 of each as headers, build per-row JSON.
//   5. Hash each row's normalised JSON; INSERT OR IGNORE keeps duplicates out
//      across runs (row-level dedup).
//
// Schema is intentionally generic — the user said "all data" and the SPOC sheet
// columns may evolve. We store the full row as JSON plus extracted columns for
// quick listing in the UI.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const xlsx = require('xlsx');
const db = require('../db');

const INBOX_DIR = process.env.SPOC_INBOX_DIR || path.join(os.homedir(), 'pm-panel', 'spoc-inbox');

// XLSX = ZIP (PK\x03\x04). XLS = D0 CF 11 E0 (OLE2 compound). CSV = ASCII text.
function sniffFormat(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'xlsx';
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'xls';
  // Cheap CSV check: first KB is printable + has at least one comma/newline.
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
function getDownloadUrl() { return readSetting('spoc_download_url') || ''; }
function setDownloadUrl(u) { writeSetting('spoc_download_url', u || ''); }
function getMe() { return readSetting('spoc_me') || ''; }
function setMe(p) { writeSetting('spoc_me', p || ''); }

// Stable identity for a row. Prefer Ticket ID (unique per support ticket and
// preserved across re-imports); fall back to row_hash so tracker-only
// changes still keep acks attached.
function ackKey(data, rowHash) {
  const t = data && (data['Ticket ID'] || data.ticket_id || data.TicketId || data.ticketId);
  if (t != null && String(t).trim()) return `ticket:${String(t).trim()}`;
  return `hash:${rowHash}`;
}

// Attempt to fetch the remote URL and drop the result into the inbox if it
// really is a spreadsheet. Two-step strategy:
//   1. Plain HTTP GET. If the response is a real file (sniffed by content-type
//      + magic bytes), use it directly. This is fast and dependency-free for
//      URLs that already serve raw files.
//   2. Otherwise (Zoho WorkDrive external-share `download` URLs always fall
//      here — they return their JS viewer), open the URL in headless Chromium,
//      click the visible "Download" button and capture the resulting download
//      event. Requires Playwright + Chromium to be installed.
async function tryDownloadToInbox(onProgress) {
  const emit = (stage, pct, detail) => { try { onProgress && onProgress(stage, pct, detail); } catch (_) {} };
  const url = getDownloadUrl();
  if (!url) { emit('download', 100, 'no remote URL configured — using inbox only'); return { attempted: false }; }
  ensureInbox();
  emit('download', 5, 'fetching remote URL');
  // ---------- Step 1: plain GET ----------
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
          filename = `spoc-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
        }
        const full = path.join(INBOX_DIR, filename);
        fs.writeFileSync(full, buf);
        emit('download', 35, `downloaded ${filename} (${buf.length} bytes via http)`);
        return { attempted: true, ok: true, file: filename, bytes: buf.length, via: 'http', sniffed, contentType: ctype };
      }
      // Fall through to headless-browser path.
    }
  } catch (e) {
    // Fall through; the browser path may still succeed.
    var fetchErr = e.message;
  }
  // ---------- Step 2: headless browser ----------
  emit('download', 12, 'http fetch returned a viewer page — launching headless Chromium');
  return await downloadViaBrowser(url, emit);
}

async function downloadViaBrowser(url, emit) {
  emit = emit || (() => {});
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) {
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
    // Wait for a clickable Download button (Zoho external-share viewer pattern).
    // If a future page layout puts the file in an <a download> link instead,
    // the same waitForEvent('download') still fires.
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
    const suggested = download.suggestedFilename() || `spoc-${new Date().toISOString().replace(/[:.]/g, '-')}.xlsx`;
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
    CREATE TABLE IF NOT EXISTS spoc_imports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_name   TEXT NOT NULL,
      file_sha256 TEXT NOT NULL UNIQUE,
      file_mtime  TEXT,
      rows_total  INTEGER NOT NULL DEFAULT 0,
      rows_new    INTEGER NOT NULL DEFAULT 0,
      sheets      TEXT,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS spoc_entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      dedup_key   TEXT NOT NULL UNIQUE,
      row_hash    TEXT NOT NULL,
      sheet       TEXT,
      data_json   TEXT NOT NULL,
      source_file TEXT,
      first_seen  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_spoc_entries_sheet ON spoc_entries(sheet);
    -- Per-person read tracker. Keyed on the stable identity of a row
    -- (Ticket ID when present, else row_hash) so acks survive re-imports
    -- where the row content changes slightly (e.g. new "Open" columns added).
    CREATE TABLE IF NOT EXISTS spoc_acks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ack_key    TEXT NOT NULL,
      person     TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'read',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(ack_key, person)
    );
    CREATE INDEX IF NOT EXISTS idx_spoc_acks_key ON spoc_acks(ack_key);
  `);
  // Migration: older builds keyed dedup on row_hash. Add dedup_key (Ticket ID
  // when present) and rebuild the table without the UNIQUE constraint on
  // row_hash so the same Ticket ID collapses to a single row across re-imports.
  const cols = db.prepare("PRAGMA table_info(spoc_entries)").all();
  if (!cols.some(c => c.name === 'dedup_key')) {
    db.exec('DROP INDEX IF EXISTS idx_spoc_entries_sheet;');
    db.exec('ALTER TABLE spoc_entries RENAME TO spoc_entries_old;');
    db.exec(`
      CREATE TABLE spoc_entries (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        dedup_key   TEXT NOT NULL UNIQUE,
        row_hash    TEXT NOT NULL,
        sheet       TEXT,
        data_json   TEXT NOT NULL,
        source_file TEXT,
        first_seen  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_spoc_entries_sheet ON spoc_entries(sheet);
    `);
    const oldRows = db.prepare(
      'SELECT row_hash, sheet, data_json, source_file, first_seen, last_seen FROM spoc_entries_old ORDER BY first_seen'
    ).all();
    const mig = db.prepare(`INSERT INTO spoc_entries
        (dedup_key, row_hash, sheet, data_json, source_file, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dedup_key) DO UPDATE SET
          row_hash    = excluded.row_hash,
          sheet       = excluded.sheet,
          data_json   = excluded.data_json,
          source_file = excluded.source_file,
          last_seen   = excluded.last_seen`);
    const tx = db.transaction(() => {
      for (const r of oldRows) {
        let d = {};
        try { d = JSON.parse(r.data_json) || {}; } catch (_) {}
        const key = ackKey(d, r.row_hash);
        mig.run(key, r.row_hash, r.sheet, r.data_json, r.source_file, r.first_seen, r.last_seen);
      }
    });
    tx();
    db.exec('DROP TABLE spoc_entries_old;');
  }
}
ensureSchema();

// Columns we render as the "main" SPOC fields, in this order. Anything else
// (typically person names like Saairam, Sundar … — the per-person status
// columns from the source sheet) becomes a tracker.
const FIXED_COLUMNS = [
  'Time', 'Ticket ID', 'Query Summary', 'Build Number',
  'Cx Domain', 'Cx Type', 'Module', 'Product', 'Priority',
  'Query / Description', 'Sender', 'Message Link',
];
// Aliases (case/spacing variants) -> canonical name from FIXED_COLUMNS.
function matchFixed(header) {
  const norm = header.replace(/\s+/g, '').toLowerCase();
  for (const fc of FIXED_COLUMNS) {
    if (fc.replace(/\s+/g, '').toLowerCase() === norm) return fc;
  }
  // Common variants seen in the wild.
  if (/^query[\/_ ]?desc/i.test(header)) return 'Query / Description';
  if (/^message[ _]?link$/i.test(header)) return 'Message Link';
  if (/^cx[ _]?domain$/i.test(header)) return 'Cx Domain';
  if (/^cx[ _]?type$/i.test(header)) return 'Cx Type';
  if (/^build[ _]?(no|number)$/i.test(header)) return 'Build Number';
  if (/^ticket[ _]?id$/i.test(header)) return 'Ticket ID';
  return null;
}

function ensureInbox() {
  try { fs.mkdirSync(INBOX_DIR, { recursive: true }); } catch (_) {}
}

function listInboxFiles() {
  ensureInbox();
  const all = fs.readdirSync(INBOX_DIR, { withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => {
      const full = path.join(INBOX_DIR, d.name);
      const st = fs.statSync(full);
      return { name: d.name, full, mtimeMs: st.mtimeMs, size: st.size };
    })
    .filter(f => /\.(xlsx|xls|csv)$/i.test(f.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return all;
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

// Stable JSON for hashing — keys sorted, trimmed string values.
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
  const out = []; // { sheet, rows: [ {col: val, ...}, ... ] }

  // Only ingest sheets that look like SPOC. Several real-world download files
  // bundle multiple sheets (e.g. "Feature Requests_SPOC.xlsx" has both a
  // "SPOC" and a "Feature Requests" sheet). The Feature Requests sheet has a
  // completely different column set (FR Name / CRM Link / Priority / etc.)
  // and is handled by lib/feature-requests.js with its own table, so pulling
  // those rows into spoc_entries mixes incompatible schemas and makes every
  // SPOC row look like it's "missing" half its fields.
  //
  // Strategy:
  //   1. Prefer sheets whose name contains "spoc" (case-insensitive).
  //   2. If none match (single-sheet legacy file like "SPOC.xlsx" with
  //      sheet name "Sheet1"), fall back to all sheets so we don't drop data.
  const spocSheets = wb.SheetNames.filter(n => /spoc/i.test(n));
  const namesToIngest = spocSheets.length ? spocSheets : wb.SheetNames;

  for (const sheetName of namesToIngest) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    // header:1 returns array-of-arrays so we can use the first non-empty row as headers.
    const rows = xlsx.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null, raw: false });
    if (!rows.length) continue;
    // Find first row that has at least one non-empty cell — that's the header row.
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

// Run import for the newest file in the inbox. Returns a summary suitable for
// the scheduler `lastresult` payload.
async function runImport({ force = false, onProgress } = {}) {
  const emit = (stage, pct, detail) => { try { onProgress && onProgress(stage, pct, detail); } catch (_) {} };
  const startedAt = Date.now();
  ensureInbox();
  emit('start', 1, 'starting import');
  // Best-effort remote pull first. Failure here is non-fatal — we still try
  // the inbox so a manually-dropped file works regardless.
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
    const existing = db.prepare('SELECT id FROM spoc_imports WHERE file_sha256=?').get(sha);
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
  // Dedup is keyed on Ticket ID (when present) so the same ticket reappearing
  // on a later day overwrites the existing row instead of inserting a copy.
  // row_hash and data_json are refreshed so the latest values from the sheet
  // win; first_seen is preserved by ON CONFLICT.
  const ins = db.prepare(`INSERT INTO spoc_entries
          (dedup_key, row_hash, sheet, data_json, source_file)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(dedup_key) DO UPDATE SET
            row_hash    = excluded.row_hash,
            sheet       = excluded.sheet,
            data_json   = excluded.data_json,
            source_file = excluded.source_file,
            last_seen   = CURRENT_TIMESTAMP`);
  const sel = db.prepare('SELECT id FROM spoc_entries WHERE dedup_key=?');
  const totalRowsAcrossSheets = sheets.reduce((n, s) => n + s.rows.length, 0) || 1;
  let processed = 0;
  let lastEmit = 0;
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
        // Emit at most every 25 rows to avoid log spam.
        if (processed - lastEmit >= 25 || processed === totalRowsAcrossSheets) {
          lastEmit = processed;
          const pct = 70 + Math.round((processed / totalRowsAcrossSheets) * 25); // 70 → 95
          emit('write', pct, `writing rows ${processed}/${totalRowsAcrossSheets} (${rowsNew} new)`);
        }
      }
    }
    db.prepare(`INSERT OR REPLACE INTO spoc_imports
                (file_name, file_sha256, file_mtime, rows_total, rows_new, sheets)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(f.name, sha, new Date(f.mtimeMs).toISOString(),
           rowsTotal, rowsNew, JSON.stringify(sheets.map(s => ({ sheet: s.sheet, rows: s.rows.length }))));
  });
  tx();
  // Cleanup: after a successful import, delete the source file from the inbox
  // so the folder doesn't accumulate one .xlsx per day. The import row in
  // `spoc_imports` already records the file name + sha256 + row stats, and the
  // parsed rows live in `spoc_entries`, so the file itself is no longer needed.
  // Set SPOC_KEEP_FILES=1 in the env if you want to keep them around for audit.
  let deleted = false;
  if (!process.env.SPOC_KEEP_FILES) {
    try { fs.unlinkSync(f.full); deleted = true; }
    catch (e) { console.warn(`[spoc] could not delete ${f.full}: ${e.message}`); }
  }
  emit('done', 100, `imported ${rowsNew}/${rowsTotal} new rows from ${f.name}`);
  return { startedAt, finishedAt: Date.now(), file: f.name, sha,
           rowsTotal, rowsNew, sheets: sheets.map(s => ({ sheet: s.sheet, rows: s.rows.length })),
           download, deleted };
}

function listEntries({ q = '', sheet = '', from = '', to = '', limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (sheet) { where.push('sheet = ?'); params.push(sheet); }
  if (q) { where.push('data_json LIKE ?'); params.push(`%${q}%`); }
  const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Resolve the actual header used for the canonical "Time" column so we can
  // date-filter on it. The header text varies across sheets (e.g. "Time",
  // "Timestamp"), so we scan known keys and pick whatever maps to FIXED 'Time'.
  let timeKey = null;
  const sampleKeys = new Set();
  for (const r of db.prepare('SELECT data_json FROM spoc_entries').all()) {
    let d = {}; try { d = JSON.parse(r.data_json) || {}; } catch (_) {}
    for (const k of Object.keys(d)) sampleKeys.add(k);
  }
  for (const k of sampleKeys) { if (matchFixed(k) === 'Time') { timeKey = k; break; } }

  // Date filter is applied in JS (the data lives inside data_json). For
  // correctness we pull ALL rows that match the SQL filter, drop the ones
  // outside the date window, then paginate the remainder. The SPOC table is
  // small (hundreds–low thousands of rows) so the extra scan is fine.
  const allRows = db.prepare(
    `SELECT id, row_hash, sheet, data_json, source_file, first_seen, last_seen
     FROM spoc_entries ${wsql}
     ORDER BY id DESC`
  ).all(...params);

  // Pure calendar-day comparison — avoids all timezone math. We extract a
  // YYYY-MM-DD string from each row's Time cell and string-compare against
  // the filter bounds (which are already YYYY-MM-DD from <input type=date>).
  //
  // Formats seen in the wild for the Time column:
  //   "2024-08-12"                     ISO (from xlsx dateNF)
  //   "2024-08-12 14:32:15"            ISO with time
  //   "12-08-2024", "12/08/2024 14:32" DD-MM-YYYY (Indian)
  //   "16-May-2026 02:59:25"           DD-Mon-YYYY (most common in SPOC sheet)
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
    // Last resort: let Date parse it, then take its local YYYY-MM-DD.
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
    if (!timeKey) return true;
    let d = {}; try { d = JSON.parse(r.data_json) || {}; } catch (_) {}
    const ds = cellDateStr(d[timeKey]);
    if (!ds) return false;
    if (fromStr && ds < fromStr) return false;
    if (toStr   && ds > toStr)   return false;
    return true;
  });

  const total = dateFiltered.length;
  const lim = Math.min(500, +limit || 100);
  const off = Math.max(0, +offset || 0);
  const rows = dateFiltered.slice(off, off + lim);

  // Discover person columns across the FULL dataset (not just this page) so
  // the tracker UI is stable as you paginate. A column is a "person" if it's
  // not in FIXED_COLUMNS (or its aliases) and shows up at least once.
  const allKeys = new Set();
  for (const r of db.prepare('SELECT data_json FROM spoc_entries').all()) {
    let d = {}; try { d = JSON.parse(r.data_json) || {}; } catch (_) {}
    for (const k of Object.keys(d)) allKeys.add(k);
  }
  const fixedPresent = [];
  const fixedSeen = new Set();
  // Preserve FIXED_COLUMNS order.
  for (const fc of FIXED_COLUMNS) {
    for (const k of allKeys) {
      if (matchFixed(k) === fc && !fixedSeen.has(fc)) { fixedPresent.push({ key: k, label: fc }); fixedSeen.add(fc); break; }
    }
  }
  const trackerCols = Array.from(allKeys).filter(k => !matchFixed(k)).sort();

  // Look up acks for every row on this page in one shot.
  const ackKeys = rows.map(r => {
    let d = {}; try { d = JSON.parse(r.data_json) || {}; } catch (_) {}
    return ackKey(d, r.row_hash);
  });
  const acksByKey = {};
  if (ackKeys.length) {
    const placeholders = ackKeys.map(() => '?').join(',');
    const ackRows = db.prepare(
      `SELECT ack_key, person, status, updated_at FROM spoc_acks WHERE ack_key IN (${placeholders})`
    ).all(...ackKeys);
    for (const a of ackRows) {
      (acksByKey[a.ack_key] = acksByKey[a.ack_key] || []).push(a);
    }
  }

  const items = rows.map((r, i) => {
    let data = {};
    try { data = JSON.parse(r.data_json) || {}; } catch (_) {}
    const key = ackKeys[i];
    return {
      id: r.id,
      rowHash: r.row_hash,
      ackKey: key,
      sheet: r.sheet,
      source_file: r.source_file,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      data,
      acks: acksByKey[key] || [],
    };
  });
  const sheets = db.prepare('SELECT DISTINCT sheet FROM spoc_entries ORDER BY sheet').all().map(r => r.sheet);
  return {
    total,
    items,
    fixedColumns: fixedPresent,   // { key: actualHeader, label: canonical }
    trackerColumns: trackerCols,  // person names from the source sheet
    sheets,
    me: getMe(),
  };
}

function setAck({ ackKey: key, person, status }) {
  if (!key || !person) throw new Error('ackKey and person required');
  if (!status || status === 'unread' || status === 'open') {
    db.prepare('DELETE FROM spoc_acks WHERE ack_key=? AND person=?').run(key, person);
    return { ack_key: key, person, status: 'unread' };
  }
  db.prepare(`INSERT INTO spoc_acks (ack_key, person, status, updated_at)
              VALUES (?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(ack_key, person) DO UPDATE SET
                status = excluded.status,
                updated_at = CURRENT_TIMESTAMP`).run(key, person, status);
  return { ack_key: key, person, status };
}

function listImports({ limit = 50 } = {}) {
  return db.prepare(`SELECT id, file_name, file_sha256, file_mtime, rows_total, rows_new, sheets, imported_at
                     FROM spoc_imports ORDER BY id DESC LIMIT ?`).all(Math.min(200, +limit || 50))
    .map(r => ({ ...r, sheets: safeJson(r.sheets) }));
}

function safeJson(s) { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } }

// Aggregate metrics for the SPOC dashboard. We do this in JS rather than SQL
// because the per-row payload is JSON; the entry table is small (typically
// hundreds of rows) so a single full scan is fine.
function summary() {
  const rows = db.prepare('SELECT row_hash, sheet, source_file, data_json, first_seen, last_seen FROM spoc_entries').all();
  const total = rows.length;

  // Discover person columns the same way listEntries does.
  const allKeys = new Set();
  const parsed = rows.map(r => {
    let d = {}; try { d = JSON.parse(r.data_json) || {}; } catch (_) {}
    for (const k of Object.keys(d)) allKeys.add(k);
    return { ...r, data: d };
  });
  const trackerCols = Array.from(allKeys).filter(k => !matchFixed(k)).sort();
  const fixedKeyByLabel = {};
  for (const k of allKeys) {
    const fc = matchFixed(k);
    if (fc && !fixedKeyByLabel[fc]) fixedKeyByLabel[fc] = k;
  }

  // Pull every ack in one go and group by ackKey.
  const acks = db.prepare('SELECT ack_key, person, status, updated_at FROM spoc_acks').all();
  const acksByKey = {};
  for (const a of acks) (acksByKey[a.ack_key] = acksByKey[a.ack_key] || []).push(a);

  // Effective read status: ack override else source-sheet value.
  const isRead = (data, key, person) => {
    const ack = (acksByKey[key] || []).find(a => a.person === person);
    if (ack) return ack.status === 'read';
    const v = data[person];
    if (v == null || v === '') return false;
    const s = String(v).toLowerCase();
    return !(s === 'open' || s === 'pending' || s === 'todo');
  };

  const bump = (obj, k) => { if (k == null || k === '') return; obj[k] = (obj[k] || 0) + 1; };
  const byPriority = {};
  const byModule = {};
  const byProduct = {};
  const byCxType = {};
  const bySheet = {};
  // Per-person counts: { read, unread, total }.
  const perPerson = Object.fromEntries(trackerCols.map(p => [p, { read: 0, unread: 0 }]));
  // Per-row aggregate read count, used to compute "fully read" / "untouched".
  let fullyRead = 0;
  let untouched = 0;
  let unreadByMe = 0; // ignored — no logged-in user concept
  let totalReadEvents = 0;

  for (const r of parsed) {
    const d = r.data;
    bump(byPriority, d[fixedKeyByLabel['Priority']]);
    bump(byModule, d[fixedKeyByLabel['Module']]);
    bump(byProduct, d[fixedKeyByLabel['Product']]);
    bump(byCxType, d[fixedKeyByLabel['Cx Type']]);
    bump(bySheet, r.sheet);
    const key = ackKey(d, r.row_hash);
    let readN = 0;
    for (const p of trackerCols) {
      if (isRead(d, key, p)) { perPerson[p].read += 1; readN += 1; totalReadEvents += 1; }
      else perPerson[p].unread += 1;
    }
    if (trackerCols.length > 0) {
      if (readN === trackerCols.length) fullyRead += 1;
      if (readN === 0) untouched += 1;
    }
  }

  const toSorted = (obj) => Object.entries(obj)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  // Most recent import + recently-added rows for an activity feed. We sort by
  // the sheet's own "Time" column when parseable (so the latest customer
  // message floats to the top), falling back to the row's first_seen which is
  // when our importer first observed it.
  const lastImport = db.prepare(
    `SELECT id, file_name, file_mtime, rows_total, rows_new, imported_at
     FROM spoc_imports ORDER BY id DESC LIMIT 1`
  ).get() || null;
  const importsCount = db.prepare('SELECT COUNT(*) c FROM spoc_imports').get().c;
  const timeKey = fixedKeyByLabel['Time'];
  const linkKey = fixedKeyByLabel['Message Link'];
  const sortTs = (r) => {
    const v = timeKey ? r.data[timeKey] : null;
    if (v != null && v !== '') {
      // Excel serial (days since 1899-12-30): roughly 1..80000 range.
      if (typeof v === 'number' && v > 1 && v < 80000) {
        return Math.round((v - 25569) * 86400 * 1000);
      }
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
    const t2 = Date.parse(r.first_seen || '');
    return Number.isNaN(t2) ? 0 : t2;
  };
  const recent = parsed
    .slice()
    // Skip rows that have neither a customer summary nor a chat link — those
    // are blank/footer rows in the source sheet, not real activity.
    .filter(r => {
      const sm = (r.data[fixedKeyByLabel['Query Summary']] || '').toString().trim();
      const lk = linkKey ? (r.data[linkKey] || '').toString().trim() : '';
      return sm || lk;
    })
    .sort((a, b) => sortTs(b) - sortTs(a))
    .slice(0, 8)
    .map(r => ({
      ackKey: ackKey(r.data, r.row_hash),
      ticketId: r.data[fixedKeyByLabel['Ticket ID']] || '',
      messageLink: linkKey ? (r.data[linkKey] || '') : '',
      summary: r.data[fixedKeyByLabel['Query Summary']] || '',
      priority: r.data[fixedKeyByLabel['Priority']] || '',
      module: r.data[fixedKeyByLabel['Module']] || '',
      product: r.data[fixedKeyByLabel['Product']] || '',
      time: r.data[fixedKeyByLabel['Time']] || r.first_seen,
      first_seen: r.first_seen,
    }));

  return {
    total,
    importsCount,
    lastImport,
    trackerColumns: trackerCols,
    fullyRead,
    untouched,
    partiallyRead: total - fullyRead - untouched,
    totalReadEvents,
    totalReadSlots: total * trackerCols.length,
    byPriority: toSorted(byPriority),
    byModule: toSorted(byModule),
    byProduct: toSorted(byProduct),
    byCxType: toSorted(byCxType),
    bySheet: toSorted(bySheet),
    perPerson: trackerCols.map(p => ({
      person: p,
      read: perPerson[p].read,
      unread: perPerson[p].unread,
      pct: total ? Math.round((perPerson[p].read / total) * 100) : 0,
    })).sort((a, b) => b.read - a.read),
    recent,
  };
}

function inboxStatus() {
  ensureInbox();
  const files = listInboxFiles().slice(0, 10).map(f => ({
    name: f.name, size: f.size, mtime: new Date(f.mtimeMs).toISOString(),
  }));
  return { dir: INBOX_DIR, files, downloadUrl: getDownloadUrl() };
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
