import { chromium } from "playwright";
import fs from "fs";
const PAT = fs.readFileSync("/work/.pat-tmp","utf8").trim();
const B="https://lum.id";
const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.route("**/*",(r)=>r.continue({headers:{...r.request().headers(),authorization:`Bearer ${PAT}`}}));
const page = await ctx.newPage();
// warm the cache
await page.goto(B+"/studio/library",{waitUntil:"load"}).catch(()=>{});
await page.waitForTimeout(1500);
// measure a reload (cached bundle) — isolates render/compute from download
const t0=Date.now();
await page.reload({waitUntil:"load"}).catch(()=>{});
const reloadMs=Date.now()-t0;
const nav = await page.evaluate(()=>{const n=performance.getEntriesByType("navigation")[0]||{};return {ttfb:Math.round(n.responseStart),dcl:Math.round(n.domContentLoadedEventEnd),load:Math.round(n.loadEventEnd)};});
// time-to-cards: when does the first catalog card appear after a fresh nav?
await page.goto("about:blank");
const t1=Date.now();
await page.goto(B+"/studio/library",{waitUntil:"domcontentloaded"}).catch(()=>{});
await page.locator("text=/Install|MBB|Auto-|marketplace/i").first().waitFor({timeout:15000}).catch(()=>{});
console.log(`warm reload=${reloadMs}ms  (TTFB=${nav.ttfb} dcl=${nav.dcl} load=${nav.load})`);
console.log(`cold time-to-first-card=${Date.now()-t1}ms`);
await browser.close();
