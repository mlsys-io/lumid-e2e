import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();

const paths = [
  '/app', '/app/workflows', '/app/workflow', '/app/n8n', '/app/tasks',
  '/app/schedules', '/app/gpu-rentals', '/app/billing', '/app/api-docs', '/app/profile',
  '/app/lumilake', '/app/lumilake/data', '/app/lumilake/sql',
  '/app/lumilake/python', '/app/lumilake/low-code', '/app/lumilake/modelling',
  '/app/lumilake/data-label', '/app/lumilake/jobs',
  '/app/admin', '/app/admin/users', '/app/admin/lumilake-workers',
  '/dashboard', '/dashboard/profile', '/dashboard/tokens', '/auth/login',
];

const results = [];
for (const path of paths) {
  const errors = [];
  const pageErrors = [];
  const onConsole = (m) => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(m.text()); };
  const onError = (e) => pageErrors.push(e.message);
  page.on('console', onConsole);
  page.on('pageerror', onError);
  try {
    const resp = await page.goto('https://lum.id' + path, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(500);
    const title = await page.title();
    const url = page.url();
    const redirected = !url.endsWith(path) && url !== 'https://lum.id' + path;
    results.push({ path, status: resp?.status(), title, redirectedTo: redirected ? url.replace('https://lum.id', '') : null, consoleErrors: errors.length, pageErrors: pageErrors.length, firstError: pageErrors[0] || errors[0] || null });
  } catch (e) {
    results.push({ path, status: 'ERR', title: '', consoleErrors: 0, pageErrors: 0, firstError: e.message.slice(0, 120) });
  }
  page.off('console', onConsole);
  page.off('pageerror', onError);
}
await browser.close();

console.log('path                                      status  redirect         title                  errs');
console.log('----                                      ------  --------         -----                  ----');
for (const r of results) {
  const col = (s, n) => (s ?? '').toString().padEnd(n).slice(0, n);
  const errMark = r.pageErrors > 0 ? '✗' + r.pageErrors : r.consoleErrors > 0 ? '⚠' + r.consoleErrors : '✓';
  console.log(col(r.path, 42), col(r.status, 7), col(r.redirectedTo || '—', 16), col(r.title, 22), errMark);
}
const broken = results.filter(r => r.pageErrors > 0);
if (broken.length) {
  console.log('\n=== PAGE ERRORS ===');
  broken.forEach(r => console.log('  ' + r.path + ': ' + r.firstError));
}
console.log('\ntotal=' + results.length + '  ok=' + results.filter(r => r.status === 200 && r.pageErrors === 0).length + '  pageErrors=' + broken.length);
