import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
page.on('response', async r => {
  const u = r.url();
  if (u.includes('runmesh.ai') || u.includes('session-bearer')) {
    console.log(`[${r.status()}] ${r.request().method()} ${u}`);
    if (r.status() >= 400 || u.includes('session-bearer')) {
      try { console.log('  body:', (await r.text()).slice(0, 300)); } catch {}
    }
  }
});
// Visit /app unauthed first to see what runmesh call pattern is tried
await page.goto('https://lum.id/app', { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(2000);
await browser.close();
