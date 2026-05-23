const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'https://workdrive.zohoexternal.in/external/507c680250917eb05eb5b3c143989ea2f03302569ed7abbb83f60a835879b093/download';
const OUT = '/tmp/spoc-probe';
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('download', async d => {
    const f = path.join(OUT, d.suggestedFilename() || 'download.bin');
    await d.saveAs(f);
    console.log('DOWNLOAD ->', f, '| url=', d.url());
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('button:has-text("Download")', { timeout: 30000 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }).catch(e => { console.log('no download event:', e.message); return null; }),
    page.click('button:has-text("Download")'),
  ]);
  if (download) {
    const f = path.join(OUT, download.suggestedFilename() || 'download.bin');
    await download.saveAs(f);
    console.log('SAVED', f);
  }
  await page.waitForTimeout(3000);
  await browser.close();
})();
