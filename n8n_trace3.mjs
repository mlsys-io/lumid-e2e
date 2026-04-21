import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const xhr = [];
page.on('requestfinished', async r => {
  const u = r.url();
  if (/rest|settings/.test(u)) {
    xhr.push(`${r.method()} ${u}`);
  }
});
await page.goto('https://lum.id/n8n/workflow/new', { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForTimeout(2500);
// Inspect __pinia state if exposed
const state = await page.evaluate(() => {
  const pinia = window.__pinia || window.Pinia || (window.__VUE_DEVTOOLS_GLOBAL_HOOK__?.apps?.[0]?.config?.globalProperties?.$pinia);
  // Try multiple common exposure patterns
  const roots = [];
  try {
    // search for any computed named restUrl
    for (const k in window) {
      if (/pinia|store/i.test(k)) roots.push(k);
    }
  } catch {}
  return {
    basePath: window.BASE_PATH,
    piniaKeys: roots,
    n8nConfig: [...document.querySelectorAll('meta[name^=n8n]')].map(m => [m.name, m.content]),
  };
});
console.log(JSON.stringify(state, null, 2));
console.log('\n--- rest/settings requests ---');
xhr.forEach(r => console.log(r));
await browser.close();
