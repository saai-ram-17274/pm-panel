const Parser = require('rss-parser');
const cheerio = require('cheerio');
const crypto = require('crypto');

const rss = new Parser({ timeout: 15000 });

const str = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v._ || v['#'] || JSON.stringify(v);
  return String(v);
};

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

async function ingestRss(url) {
  const feed = await rss.parseURL(url);
  return (feed.items || []).map(it => ({
    title: str(it.title) || '(untitled)',
    url: str(it.link) || '',
    published_at: str(it.isoDate) || str(it.pubDate) || null,
    content: stripHtml(str(it.contentSnippet) || str(it.content) || str(it.summary)),
    hash: hash(str(it.guid) + '|' + str(it.link) + '|' + str(it.title) + '|' + str(it.isoDate)),
  }));
}

async function ingestHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'PM-Panel/1.0' } });
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
    hash: hash(url + text.slice(0, 500)),
  }];
}

function ingestManual({ title, content, url }) {
  return [{
    title: title || 'Manual entry',
    url: url || '',
    published_at: new Date().toISOString(),
    content: content || '',
    hash: hash((title || '') + (content || '').slice(0, 500)),
  }];
}

function stripHtml(s) {
  if (!s) return '';
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = { ingestRss, ingestHtml, ingestManual };
