// Zoho Mail REST integration. Authenticates with the refresh-token grant and
// caches the resulting access token in the `settings` table so we only hit
// accounts.zoho.in once an hour (the token is valid for ~1h).
//
// Required env vars (see .env.example):
//   ZOHO_MAIL_CLIENT_ID
//   ZOHO_MAIL_CLIENT_SECRET
//   ZOHO_MAIL_REFRESH_TOKEN
//   ZOHO_MAIL_ACCOUNT_ID
//   ZOHO_MAIL_FROM                (sender address belonging to the account)
//   ZOHO_MAIL_DAILY_TO            (comma-separated recipients for daily digest)
//
// Optional:
//   ZOHO_ACCOUNTS_BASE  (default https://accounts.zoho.in)
//   ZOHO_MAIL_API_BASE  (default https://mail.zoho.in/api)
const db = require('../db');

const ACCOUNTS_BASE = process.env.ZOHO_ACCOUNTS_BASE || 'https://accounts.zoho.in';
const MAIL_API_BASE = process.env.ZOHO_MAIL_API_BASE || 'https://mail.zoho.in/api';

function env(name) { return process.env[name] || ''; }

function isConfigured() {
  return !!(env('ZOHO_MAIL_CLIENT_ID') && env('ZOHO_MAIL_CLIENT_SECRET') &&
            env('ZOHO_MAIL_REFRESH_TOKEN') && env('ZOHO_MAIL_ACCOUNT_ID') &&
            env('ZOHO_MAIL_FROM'));
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

const TOKEN_KEY = 'zoho_mail_access_token';
const TOKEN_EXP_KEY = 'zoho_mail_access_token_exp';

async function refreshAccessToken() {
  const params = new URLSearchParams({
    refresh_token: env('ZOHO_MAIL_REFRESH_TOKEN'),
    client_id: env('ZOHO_MAIL_CLIENT_ID'),
    client_secret: env('ZOHO_MAIL_CLIENT_SECRET'),
    grant_type: 'refresh_token',
  });
  const res = await fetch(`${ACCOUNTS_BASE}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { throw new Error(`token refresh: bad JSON: ${text.slice(0, 200)}`); }
  if (!res.ok || !json.access_token) {
    throw new Error(`token refresh failed (${res.status}): ${json.error || text.slice(0, 200)}`);
  }
  const ttlMs = Math.max(60, (json.expires_in || 3600) - 60) * 1000;
  const exp = Date.now() + ttlMs;
  writeSetting(TOKEN_KEY, json.access_token);
  writeSetting(TOKEN_EXP_KEY, String(exp));
  return json.access_token;
}

async function getAccessToken() {
  const cached = readSetting(TOKEN_KEY);
  const exp = +readSetting(TOKEN_EXP_KEY) || 0;
  if (cached && exp > Date.now() + 30_000) return cached;
  return refreshAccessToken();
}

async function sendMail({ to, cc, bcc, subject, html, text, askReceipt }) {
  if (!isConfigured()) throw new Error('Zoho Mail not configured (missing ZOHO_MAIL_* env vars)');
  if (!to) throw new Error('mailer.sendMail: `to` is required');
  const accountId = env('ZOHO_MAIL_ACCOUNT_ID');
  const body = {
    fromAddress: env('ZOHO_MAIL_FROM'),
    toAddress: Array.isArray(to) ? to.join(',') : String(to),
    subject: subject || '(no subject)',
    content: html != null ? html : (text || ''),
    mailFormat: html != null ? 'html' : 'plaintext',
  };
  if (cc) body.ccAddress = Array.isArray(cc) ? cc.join(',') : String(cc);
  if (bcc) body.bccAddress = Array.isArray(bcc) ? bcc.join(',') : String(bcc);
  if (askReceipt) body.askReceipt = 'yes';

  const doRequest = async (token) => fetch(`${MAIL_API_BASE}/accounts/${accountId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  let token = await getAccessToken();
  let res = await doRequest(token);
  // Token might have been revoked / expired early; force a refresh once.
  if (res.status === 401) {
    token = await refreshAccessToken();
    res = await doRequest(token);
  }
  const respText = await res.text();
  let json;
  try { json = JSON.parse(respText); } catch (_) { json = null; }
  if (!res.ok || (json && json.status && json.status.code && json.status.code !== 200)) {
    const reason = (json && (json.status?.description || json.data?.errorCode)) || respText.slice(0, 300);
    throw new Error(`sendMail failed (${res.status}): ${reason}`);
  }
  return json && json.data ? json.data : { ok: true };
}

module.exports = { isConfigured, getAccessToken, refreshAccessToken, sendMail };
