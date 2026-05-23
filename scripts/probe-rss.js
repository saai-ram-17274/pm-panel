// Probe each enabled RSS source, print HTTP status + first parse error.
const db = require('../db');
const Parser = require('rss-parser');
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const rss = new Parser({
  timeout: 20000,
  headers: {
    'User-Agent': BROWSER_UA,
    'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
  },
});

(async () => {
  const sources = db.prepare("SELECT id, url, label, product_id, kind FROM sources WHERE kind='rss' ORDER BY id").all();
  console.log(`Probing ${sources.length} RSS sources...`);
  const bad = [];
  for (const s of sources) {
    process.stdout.write(`  [${String(s.id).padStart(3)}] ${s.url.slice(0,70).padEnd(72)} `);
    try {
      const r = await fetch(s.url, { headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } });
      if (!r.ok) { console.log(`HTTP ${r.status}`); bad.push({ ...s, err: `HTTP ${r.status}` }); continue; }
      const body = await r.text();
      try {
        await rss.parseString(body);
        console.log('OK');
      } catch (pe) {
        console.log(`PARSE: ${pe.message}`);
        bad.push({ ...s, err: pe.message, bodyLen: body.length, head: body.slice(0, 600) });
      }
    } catch (e) {
      console.log(`NET: ${e.message}`);
      bad.push({ ...s, err: e.message });
    }
  }
  console.log('\n=== broken sources ===');
  for (const b of bad) {
    console.log(`\nid=${b.id}  product_id=${b.product_id}  label=${b.label || ''}`);
    console.log(`  url:  ${b.url}`);
    console.log(`  err:  ${b.err}`);
    if (b.head) {
      console.log('  head:');
      console.log(b.head.split('\n').slice(0, 30).map(l => '    ' + l).join('\n'));
    }
  }
  if (!bad.length) console.log('(none)');
})();
