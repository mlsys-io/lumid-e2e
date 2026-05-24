import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();

const routes = [
  '/app', '/app/workflows', '/app/workflow', '/app/tasks',
  '/app/schedules', '/app/gpu-rentals', '/app/billing',
  '/app/api-docs', '/app/profile', '/app/n8n',
  '/app/lumilake', '/app/lumilake/data', '/app/lumilake/sql',
  '/app/lumilake/python', '/app/lumilake/low-code', '/app/lumilake/modelling',
  '/app/lumilake/data-label', '/app/lumilake/jobs',
  '/app/admin', '/app/admin/users', '/app/admin/nodes', '/app/admin/billing',
  '/app/admin/workflow-review', '/app/admin/invitations',
  '/dashboard', '/dashboard/profile', '/dashboard/tokens', '/dashboard/connect',
];

const issues = {};
for (const path of routes) {
  try {
    await page.goto('https://lum.id' + path, { waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(500);
  } catch {}
  const info = await page.evaluate(() => {
    const out = { bodyOverflowX: false, mainOverflowX: false, cardDepth: 0, titleCount: 0, fontSample: {} };
    // Did any element create a horizontal scroll?
    const docW = document.documentElement.scrollWidth;
    const viewW = window.innerWidth;
    out.bodyOverflowX = docW > viewW + 2;
    // Count nested rounded white cards as proxy for "card in card"
    // (white bg + shadow + rounded)
    const cards = [...document.querySelectorAll('div[class*="rounded"][class*="bg-white"]')];
    out.cardCount = cards.length;
    // Find the deepest nesting of card-in-card
    let maxDepth = 0;
    for (const c of cards) {
      let depth = 0;
      let p = c.parentElement;
      while (p) {
        if (p.className && typeof p.className === 'string' &&
            /rounded/.test(p.className) && /bg-white/.test(p.className)) depth++;
        p = p.parentElement;
      }
      if (depth > maxDepth) maxDepth = depth;
    }
    out.maxNestedCardDepth = maxDepth;
    // Count h1s  
    out.titleCount = document.querySelectorAll('h1').length;
    // Sample the first h1 + a body text element's font sizes
    const h1 = document.querySelector('h1');
    if (h1) out.fontSample.h1 = getComputedStyle(h1).fontSize;
    const body = document.querySelector('main p, main span');
    if (body) out.fontSample.bodyText = getComputedStyle(body).fontSize;
    // any element wider than viewport?
    const wide = [...document.querySelectorAll('main *')]
      .filter(e => e.getBoundingClientRect().right > viewW + 5)
      .slice(0, 2)
      .map(e => ({ tag: e.tagName, cls: (e.className || '').toString().slice(0, 80), right: Math.round(e.getBoundingClientRect().right) }));
    out.overflow = wide;
    return out;
  });
  issues[path] = info;
}
await browser.close();

// Print report
console.log('route                               bodyOver  cardDepth  h1s  h1fs   bodyFs  overflow');
console.log('---------------------------------   --------  ---------  ---  ----   ------  --------');
for (const [p, i] of Object.entries(issues)) {
  const pad = (s, n) => (s || '').toString().padEnd(n).slice(0, n);
  console.log(
    pad(p, 35),
    pad(i.bodyOverflowX ? '✗' : '✓', 9),
    pad(i.maxNestedCardDepth, 10),
    pad(i.titleCount, 4),
    pad(i.fontSample?.h1 || '—', 6),
    pad(i.fontSample?.bodyText || '—', 7),
    (i.overflow || []).map(o => `${o.tag} r=${o.right}`).join(', ') || ''
  );
}
