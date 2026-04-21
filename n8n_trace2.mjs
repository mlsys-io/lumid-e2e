import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();

// Intercept every axios request to see options
await page.addInitScript(() => {
  const origFetch = window.fetch;
  window.__reqs = [];
  window.fetch = function(...args) {
    window.__reqs.push({url: args[0], opts: args[1]});
    return origFetch.apply(this, args);
  };
  // And track XHR
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    window.__reqs.push({xhr: true, method, url});
    return origOpen.apply(this, arguments);
  };
});

await page.goto('https://lum.id/n8n/workflow/new', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(2000);
const reqs = await page.evaluate(() => window.__reqs);
console.log('--- all requests ---');
reqs.forEach(r => console.log(JSON.stringify(r)));
await browser.close();
