// Thin client over GitHub Models with multi-token fallback support.
// Tokens are stored in the `llm_tokens` table (priority-ordered). The active
// token is the lowest-priority one whose `exhausted_until` is null or past.
// On a rate-limit / auth failure the current token is marked exhausted until
// midnight (server local time) and the call is retried with the next token.
// Docs: https://docs.github.com/en/github-models

const db = require('../db');

const ENDPOINT = 'https://models.github.ai/inference/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';

// ── settings helpers (kept for model + back-compat migration) ────────────────
function readSetting(key) {
  try { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return r?.value || null; } catch (_) { return null; }
}
function writeSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).run(key, value);
}
function deleteSetting(key) { db.prepare('DELETE FROM settings WHERE key=?').run(key); }

function getModel() { return readSetting('llm_model') || process.env.LLM_MODEL || DEFAULT_MODEL; }

// ── one-time migration: lift legacy single-token settings into llm_tokens ──
(function migrateLegacyToken() {
  try {
    const legacy = readSetting('github_token');
    if (!legacy) return;
    const existing = db.prepare('SELECT id FROM llm_tokens WHERE token=?').get(legacy);
    if (existing) { deleteSetting('github_token'); deleteSetting('github_token_expires_at'); return; }
    const expiry = readSetting('github_token_expires_at') || null;
    db.prepare(`INSERT INTO llm_tokens (label, token, expires_at, priority)
                VALUES (?, ?, ?, ?)`).run('Primary', legacy, expiry, 10);
    deleteSetting('github_token');
    deleteSetting('github_token_expires_at');
    console.log('[llm] Migrated legacy github_token into llm_tokens table.');
  } catch (e) { console.error('[llm] migration error:', e.message); }
})();

function maskToken(t) {
  if (!t) return '';
  if (t.length <= 8) return '••••';
  return t.slice(0, 4) + '…' + t.slice(-4);
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const ms = Date.parse(dateStr);
  if (Number.isNaN(ms)) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  return Math.ceil((ms - today.getTime()) / 86400000);
}

// Compute an exhausted_until timestamp (UTC ISO 'YYYY-MM-DD HH:MM:SS') for a
// given failure. For rate_limit we honor the Retry-After header (seconds) with
// a 60s floor — the per-minute bucket resets in about a minute, so a short
// cooldown lets us re-use the same token shortly. For auth errors we lock for
// 6 hours; those need user intervention so we don't want to keep retrying
// hard. Caps at end-of-day so we never lock for more than ~24h.
function computeUnlockIso(kind, retryAfterSec) {
  const now = Date.now();
  const eod = (() => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); })();
  let ms;
  if (kind === 'rate_limit') {
    const sec = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 60;
    ms = Math.max(60, sec) * 1000;
  } else if (kind === 'auth') {
    ms = 6 * 60 * 60 * 1000; // 6 hours
  } else {
    ms = 60 * 1000;
  }
  const unlock = Math.min(now + ms, eod);
  return new Date(unlock).toISOString().replace('T', ' ').slice(0, 19);
}

function parseRetryAfter(headerVal) {
  if (!headerVal) return null;
  const n = Number(headerVal);
  if (Number.isFinite(n) && n >= 0) return n;
  const ms = Date.parse(headerVal);
  if (!Number.isNaN(ms)) return Math.max(0, Math.round((ms - Date.now()) / 1000));
  return null;
}

// Return all tokens with computed runtime state.
function listTokens() {
  const rows = db.prepare(`SELECT id, label, token, expires_at, priority,
                                  exhausted_until, last_used_at, last_error, created_at
                           FROM llm_tokens ORDER BY priority ASC, id ASC`).all();
  const now = Date.now();
  return rows.map(r => {
    const exhMs = r.exhausted_until ? Date.parse((r.exhausted_until || '').replace(' ', 'T') + 'Z') : null;
    const isExhausted = exhMs && exhMs > now;
    const daysLeft = daysUntil(r.expires_at);
    const expired = daysLeft != null && daysLeft < 0;
    let state = 'active';
    if (expired) state = 'expired';
    else if (isExhausted) state = 'exhausted';
    return {
      id: r.id,
      label: r.label,
      tokenMasked: maskToken(r.token),
      expiresAt: r.expires_at || null,
      daysLeft,
      priority: r.priority,
      exhaustedUntil: isExhausted ? r.exhausted_until : null,
      lastUsedAt: r.last_used_at,
      lastError: r.last_error,
      state, // 'active' | 'exhausted' | 'expired'
    };
  });
}

// Pick the active token row (full record incl. raw token). Skips exhausted/expired.
function pickActiveTokenRow(excludeIds = []) {
  const rows = db.prepare(`SELECT * FROM llm_tokens ORDER BY priority ASC, id ASC`).all();
  const now = Date.now();
  for (const r of rows) {
    if (excludeIds.includes(r.id)) continue;
    const exhMs = r.exhausted_until ? Date.parse((r.exhausted_until || '').replace(' ', 'T') + 'Z') : null;
    if (exhMs && exhMs > now) continue;
    const daysLeft = daysUntil(r.expires_at);
    if (daysLeft != null && daysLeft < 0) continue;
    return r;
  }
  // Fallback: env var
  if (process.env.GITHUB_TOKEN && !excludeIds.includes('env')) {
    return { id: 'env', token: process.env.GITHUB_TOKEN, label: 'env' };
  }
  return null;
}

function classifyHttpError(status, body) {
  const m = (body || '').toLowerCase();
  if (status === 429 || m.includes('rate limit') || m.includes('too many requests')) return 'rate_limit';
  if (status === 401 || status === 403 || m.includes('unauthor') || m.includes('forbidden')) return 'auth';
  if (status >= 500) return 'server';
  return 'other';
}

function markExhausted(id, kind, errMsg, retryAfterSec) {
  if (id === 'env') return; // can't mark env
  const unlock = computeUnlockIso(kind, retryAfterSec);
  db.prepare(`UPDATE llm_tokens SET exhausted_until = ?, last_error = ? WHERE id = ?`)
    .run(unlock, `[${kind}] ${(errMsg || '').slice(0, 280)}`, id);
}
function markUsed(id) {
  if (id === 'env') return;
  db.prepare(`UPDATE llm_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
}
function clearExhausted(id) {
  db.prepare(`UPDATE llm_tokens SET exhausted_until = NULL, last_error = NULL WHERE id = ?`).run(id);
}

// Auto-clear `exhausted_until` and `last_error` on any token whose unlock time
// has already passed. The token would be picked up by pickActiveTokenRow either
// way (it only skips while exhausted_until > now), but clearing the columns
// keeps the UI honest — the row flips back to 'active' without a manual Reset
// click. Returns the number of rows cleared.
function autoReleaseExpired() {
  const rows = db.prepare(`SELECT id, exhausted_until FROM llm_tokens
                           WHERE exhausted_until IS NOT NULL`).all();
  if (!rows.length) return 0;
  const now = Date.now();
  const stale = rows.filter(r => {
    const t = Date.parse((r.exhausted_until || '').replace(' ', 'T') + 'Z');
    return Number.isFinite(t) && t <= now;
  });
  if (!stale.length) return 0;
  const upd = db.prepare(`UPDATE llm_tokens SET exhausted_until = NULL, last_error = NULL WHERE id = ?`);
  const tx = db.transaction(() => { for (const r of stale) upd.run(r.id); });
  tx();
  return stale.length;
}

// Core fetch — tries the active token, falls back to the next on rate-limit/auth.
async function callApi(body) {
  const triedIds = [];
  const failures = []; // { kind, status, msg, retryAfterSec }
  while (true) {
    const row = pickActiveTokenRow(triedIds);
    if (!row) {
      // Build a precise diagnostic from accumulated failures.
      const totalTokens = db.prepare('SELECT COUNT(*) n FROM llm_tokens').get().n;
      if (totalTokens === 0 && !process.env.GITHUB_TOKEN) {
        throw new Error('LLM_NOT_CONFIGURED: No GitHub token saved. Open Settings → AI & Tokens to add one.');
      }
      const rateLimited = failures.filter(f => f.kind === 'rate_limit');
      const authFailed = failures.filter(f => f.kind === 'auth');
      // Look up the soonest unlock time across all tokens so the user knows
      // when to retry.
      const rows = db.prepare("SELECT exhausted_until FROM llm_tokens WHERE exhausted_until IS NOT NULL").all();
      let earliest = null;
      for (const r of rows) {
        const t = Date.parse((r.exhausted_until || '').replace(' ', 'T') + 'Z');
        if (!Number.isNaN(t) && (earliest == null || t < earliest)) earliest = t;
      }
      let msg;
      if (rateLimited.length && !authFailed.length) {
        const when = earliest ? new Date(earliest).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'soon';
        msg = `All ${triedIds.length} token${triedIds.length === 1 ? ' is' : 's are'} rate-limited. Earliest one resumes at ${when}.`;
      } else if (authFailed.length && !rateLimited.length) {
        msg = `All ${triedIds.length} token${triedIds.length === 1 ? '' : 's'} rejected (401/403). Check Catalog → AI Settings.`;
      } else if (rateLimited.length || authFailed.length) {
        const when = earliest ? new Date(earliest).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'soon';
        msg = `All ${triedIds.length} tokens exhausted (${rateLimited.length} rate-limited, ${authFailed.length} rejected). Earliest unlock: ${when}.`;
      } else {
        const last = failures[failures.length - 1];
        msg = `All configured tokens are exhausted or invalid. Last error: ${last ? last.msg : 'unknown'}`;
      }
      throw new Error(msg);
    }
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${row.token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // Network error — don't mark exhausted; just retry next token.
      triedIds.push(row.id);
      failures.push({ kind: 'network', status: 0, msg: e.message });
      continue;
    }
    if (res.ok) {
      markUsed(row.id);
      const data = await res.json();
      return { data, tokenLabel: row.label };
    }
    const txt = await res.text().catch(() => '');
    const kind = classifyHttpError(res.status, txt);
    const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'));
    const errMsg = `${res.status}: ${txt.slice(0, 240)}`;
    if (kind === 'rate_limit' || kind === 'auth') {
      markExhausted(row.id, kind, errMsg, retryAfterSec);
      triedIds.push(row.id);
      failures.push({ kind, status: res.status, msg: errMsg, retryAfterSec });
      continue; // try next token
    }
    // Server / other errors: don't burn through tokens, surface immediately.
    throw new Error(`LLM ${res.status}: ${txt.slice(0, 300)}`);
  }
}

async function chat(messages, { json = true, temperature = 0.2 } = {}) {
  const body = { model: getModel(), messages, temperature, ...(json ? { response_format: { type: 'json_object' } } : {}) };
  const { data } = await callApi(body);
  const content = data.choices?.[0]?.message?.content || '';
  if (!json) return content;
  const parsed = safeJson(content);
  if (parsed && parsed.error === 'invalid_json') throw new Error('LLM returned non-JSON: ' + String(parsed.raw).slice(0, 200));
  return parsed;
}

async function chatRaw(messages, { tools, tool_choice, temperature = 0.3 } = {}) {
  const body = { model: getModel(), messages, temperature };
  if (tools && tools.length) body.tools = tools;
  if (tool_choice) body.tool_choice = tool_choice;
  const { data } = await callApi(body);
  return data.choices?.[0]?.message || { role: 'assistant', content: '' };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch (_) {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) try { return JSON.parse(m[0]); } catch (_) {}
    return { error: 'invalid_json', raw: s };
  }
}

// ── Token management API (used by index.js endpoints) ────────────────────────
function addToken({ label, token, expiresAt, priority }) {
  if (!token || !token.trim()) throw new Error('Token required');
  if (!label || !label.trim()) label = 'Token';
  if (!/^[A-Za-z0-9_\-]{20,255}$/.test(token.trim())) throw new Error('Token format looks invalid.');
  if (expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(String(expiresAt))) throw new Error('expiresAt must be YYYY-MM-DD');
  // Auto priority: next slot after the current max.
  let pr = Number(priority);
  if (!Number.isFinite(pr)) {
    const max = db.prepare('SELECT COALESCE(MAX(priority), 0) m FROM llm_tokens').get().m;
    pr = max + 10;
  }
  const r = db.prepare(`INSERT INTO llm_tokens (label, token, expires_at, priority)
                        VALUES (?, ?, ?, ?)`).run(label.trim(), token.trim(), expiresAt || null, pr);
  return r.lastInsertRowid;
}
function updateToken(id, { label, expiresAt, priority, token }) {
  const cur = db.prepare('SELECT * FROM llm_tokens WHERE id=?').get(id);
  if (!cur) throw new Error('Not found');
  const newLabel = (label && label.trim()) || cur.label;
  const newExpiry = expiresAt === '' ? null : (expiresAt ?? cur.expires_at);
  const newPriority = (priority != null && Number.isFinite(+priority)) ? +priority : cur.priority;
  const newToken = (token && token.trim()) ? token.trim() : cur.token;
  if (newExpiry && !/^\d{4}-\d{2}-\d{2}$/.test(newExpiry)) throw new Error('expiresAt must be YYYY-MM-DD');
  db.prepare(`UPDATE llm_tokens SET label=?, expires_at=?, priority=?, token=?,
                                    exhausted_until=NULL, last_error=NULL
              WHERE id=?`).run(newLabel, newExpiry, newPriority, newToken, id);
}
function deleteTokenRow(id) {
  db.prepare('DELETE FROM llm_tokens WHERE id=?').run(id);
}
function moveToken(id, direction) {
  const rows = db.prepare('SELECT id, priority FROM llm_tokens ORDER BY priority ASC, id ASC').all();
  const idx = rows.findIndex(r => r.id === Number(id));
  if (idx < 0) throw new Error('Not found');
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= rows.length) return;
  const a = rows[idx], b = rows[swapIdx];
  const tmp = a.priority;
  db.prepare('UPDATE llm_tokens SET priority=? WHERE id=?').run(b.priority, a.id);
  db.prepare('UPDATE llm_tokens SET priority=? WHERE id=?').run(tmp, b.id);
}

// Promote a token to the top of the priority list (becomes the preferred
// active token). Also clears any exhausted/error flag on that row so the
// fallback chain will actually pick it.
function promoteToken(id) {
  const cur = db.prepare('SELECT id FROM llm_tokens WHERE id=?').get(Number(id));
  if (!cur) throw new Error('Not found');
  const min = db.prepare('SELECT COALESCE(MIN(priority), 10) m FROM llm_tokens').get().m;
  db.prepare(`UPDATE llm_tokens SET priority=?, exhausted_until=NULL, last_error=NULL WHERE id=?`)
    .run(min - 10, Number(id));
}

// Test a specific token by making one tiny chat request with its PAT directly.
// Bypasses the fallback chain so the user can verify a single row. Side effects:
// on rate_limit/auth -> marks the row exhausted (same as production path);
// on success -> updates last_used_at.
async function testToken(id) {
  const row = db.prepare('SELECT * FROM llm_tokens WHERE id=?').get(Number(id));
  if (!row) throw new Error('Not found');
  const started = Date.now();
  const body = {
    model: getModel(),
    messages: [
      { role: 'system', content: 'Reply with exactly the word: pong' },
      { role: 'user',   content: 'ping' },
    ],
    temperature: 0,
  };
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${row.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, kind: 'network', error: e.message };
  }
  const latency_ms = Date.now() - started;
  if (res.ok) {
    const data = await res.json().catch(() => ({}));
    const text = (data.choices?.[0]?.message?.content || '').toString().trim().slice(0, 40);
    markUsed(row.id);
    return { ok: true, model: getModel(), latency_ms, sample: text };
  }
  const txt = await res.text().catch(() => '');
  const kind = classifyHttpError(res.status, txt);
  const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'));
  const errMsg = `${res.status}: ${txt.slice(0, 240)}`;
  if (kind === 'rate_limit' || kind === 'auth') {
    markExhausted(row.id, kind, errMsg, retryAfterSec);
  }
  return { ok: false, kind, status: res.status, error: errMsg, latency_ms };
}

const hasToken = () => !!pickActiveTokenRow();

module.exports = {
  chat,
  chatRaw,
  hasToken,
  getModel,
  maskToken,
  listTokens,
  // Settings management
  saveConfig({ model }) {
    if (typeof model === 'string' && model.trim()) writeSetting('llm_model', model.trim());
  },
  addToken,
  updateToken,
  deleteToken: deleteTokenRow,
  moveToken,
  promoteToken,
  testToken,
  clearExhausted,
  autoReleaseExpired,
  // Status snapshot for the UI.
  status() {
    const tokens = listTokens();
    const active = pickActiveTokenRow();
    return {
      enabled: !!active,
      model: getModel(),
      tokens,
      activeTokenId: active ? (active.id === 'env' ? 'env' : active.id) : null,
      activeTokenLabel: active ? active.label : null,
    };
  },
};
