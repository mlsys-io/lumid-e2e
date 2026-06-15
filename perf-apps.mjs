import { chromium } from "playwright";
import fs from "fs";
const PAT = fs.readFileSync("/work/.pat-tmp","utf8").trim();
const BASE = "https://lum.id";
const browser = await chromium.launch();
for (const [label, path, cache] of [["apps COLD","/studio/apps",false],["apps WARM","/studio/apps",true],["chat WARM","/studio",true]]) {
  const ctx = await browser.newContext();
  await ctx.route("**/*",(r)=>r.continue({headers:{...r.request().headers(),authorization:`Bearer ${PAT}`}}));
  const page = await ctx.newPage();
  const reqs=[];
  page.on("requestfinished", async (rq)=>{ try{ const t=rq.timing(); const resp=await rq.response(); const len=(await resp.headerValue("content-length"))||0; reqs.push({url:rq.url().replace(BASE,""),dur:Math.round(t.responseEnd-t.startTime),len:+len}); }catch{} });
  if (cache){ await page.goto(BASE+path,{waitUntil:"load"}); await page.waitForTimeout(500); reqs.length=0; await page.reload({waitUntil:"load"}); } 
  const t0=Date.now();
  await page.goto(BASE+path,{waitUntil:"domcontentloaded"}).catch(()=>{});
  const dcl=Date.now()-t0;
  await page.waitForLoadState("load").catch(()=>{});
  const load=Date.now()-t0;
  const nav = await page.evaluate(()=>{const n=performance.getEntriesByType("navigation")[0]||{};return {ttfb:Math.round(n.responseStart),dom:Math.round(n.domContentLoadedEventEnd),load:Math.round(n.loadEventEnd),transfer:n.transferSize};});
  const top = reqs.sort((a,b)=>b.dur-a.dur).slice(0,6);
  console.log(`\n## ${label}  dcl=${dcl}ms load=${load}ms  TTFB=${nav.ttfb}ms domDone=${nav.dom}ms`);
  for(const r of top) console.log(`   ${String(r.dur).padStart(5)}ms ${(r.len/1024).toFixed(0).padStart(5)}KB  ${r.url.slice(0,70)}`);
  await ctx.close();
}
await browser.close();
