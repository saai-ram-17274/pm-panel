const Parser = require('rss-parser');
const cheerio = require('cheerio');
const crypto = require('crypto');

// Some publishers (BleepingComputer, a few WAFs in front of WordPress feeds)
// return 403 to the default `rss-parser` UA. Send a normal browser UA + the
// Accept header most feed CDNs whitelist. Keep timeout generous for slow
// publishers.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const rss = new Parser({
  timeout: 20000,
  headers: {
    'User-Agent': BROWSER_UA,
    'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
    'Accept-Language': 'en-US,en;q=0.8',
  },
});

const str = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v._ || v['#'] || JSON.stringify(v);
  return String(v);
};

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// Normalize a URL the same way the digest does, so dedup is stable across
// http/https, www, trailing slash, tracking query params, and fragments.
// Used as the PRIMARY identity for an article — every other ingestion path
// should hash the same way so re-fetches collapse via INSERT OR IGNORE.
function normUrl(u) {
  if (!u) return '';
  let s = String(u).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('#')[0].split('?')[0];
  s = s.replace(/\/+$/, '');
  return s;
}

// Build the dedup hash for an item. Title-first (most stable identifier
// across locale variants like /blog/ vs /blog-uk/, and across feed proxies
// like feedblitz vs fortinet that rewrite the URL); fall back to normalized
// URL when title is missing/too-short to be unique.
// CRITICAL: do NOT include guid, pubDate, or isoDate here — many feeds
// rotate those on every poll which used to defeat INSERT OR IGNORE and
// caused the same article to accumulate dozens of rows in raw_items.
function itemHash({ url, title }) {
  const t = String(title || '').trim().toLowerCase();
  const key = (t && t.length > 5) ? ('t:' + t) : ('u:' + normUrl(url));
  return hash(key && key !== 't:' && key !== 'u:' ? key : crypto.randomBytes(8).toString('hex'));
}

async function ingestRss(url) {
  const feed = await rss.parseURL(url);
  // Window outside which a future-dated pubDate is treated as garbage. Some
  // feeds (Dark Reading /events/, vendor "upcoming webinar" posts) publish
  // calendar-event items with the *event start date* as <pubDate>, which then
  // surface as "news from the future" in our timeline. Anything more than a
  // day ahead of now is almost certainly not real news, so we drop it.
  const FUTURE_LIMIT_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  return (feed.items || [])
    .map(it => {
      const link = str(it.link);
      const title = str(it.title) || '(untitled)';
      const pubRaw = str(it.isoDate) || str(it.pubDate) || null;

      // Detect event/webinar items that snuck into a news feed. Most use
      // /events/ or /webinars/ in the URL; some encode it in the categories.
      const lcUrl = link.toLowerCase();
      const cats = (it.categories || []).map(c => String(c || '').toLowerCase()).join(' ');
      const isEvent =
        /\/(events?|webinars?|conferences?)\//.test(lcUrl) ||
        /\b(event|webinar|conference|virtual event)\b/.test(cats);

      // Future-dated check (>24h ahead).
      let isFuture = false;
      if (pubRaw) {
        const t = Date.parse(pubRaw);
        if (Number.isFinite(t) && t - now > FUTURE_LIMIT_MS) isFuture = true;
      }

      return {
        title, url: link, pubRaw, isEvent, isFuture,
        content: stripHtml(str(it.contentSnippet) || str(it.content) || str(it.summary)),
      };
    })
    .filter(it => !it.isEvent && !it.isFuture)
    .map(it => ({
      title: it.title,
      url: it.url,
      published_at: it.pubRaw,
      content: it.content,
      hash: itemHash({ url: it.url, title: it.title }),
    }));
}

async function ingestHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  $('script, style, nav, footer, header').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 8000);
  const title = $('title').text().trim() || url;
  return [{
    title,
    url,
    published_at: new Date().toISOString(),
    content: text,
    hash: itemHash({ url, title }),
  }];
}

function ingestManual({ title, content, url }) {
  return [{
    title: title || 'Manual entry',
    url: url || '',
    published_at: new Date().toISOString(),
    content: content || '',
    hash: itemHash({ url, title: title || (content || '').slice(0, 80) }),
  }];
}

function stripHtml(s) {
  if (!s) return '';
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { ingestRss, ingestHtml, ingestManual };
