import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const reqs = [];
page.on('request', r => {
  const u = r.url();
  if (u.includes('settings') || u.includes('/rest/') || u.includes('/n8n/rest/')) {
    reqs.push(r.method() + ' ' + u);
  }
});
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
await page.goto('https://lum.id/n8n/workflow/new', { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(2000);
console.log('--- matching requests ---');
reqs.forEach(r => console.log(r));
await browser.close();
