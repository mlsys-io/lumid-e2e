import { chromium } from "playwright";
import fs from "fs";
const PAT = fs.readFileSync("/work/.pat-tmp","utf8").trim();
const BASE="https://lum.id";
const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.route("**/*",(r)=>r.continue({headers:{...r.request().headers(),authorization:`Bearer ${PAT}`}}));
const page = await ctx.newPage();
const tally={}; let total=0;
page.on("request", rq=>{ const u=rq.url(); const m=u.match(/\/api\/v1\/me\/[^?]*/); if(m){ tally[m[0]]=(tally[m[0]]||0)+1; total++; } });
const errs=[]; page.on("console", m=>{ if(m.type()==="error") errs.push(m.text().slice(0,120)); });
await page.goto(BASE+"/studio/apps",{waitUntil:"domcontentloaded"}).catch(()=>{});
await page.waitForTimeout(12000);  // watch for 12s
console.log("TOTAL /me requests in ~12s:", total);
for(const [k,v] of Object.entries(tally).sort((a,b)=>b[1]-a[1]).slice(0,12)) console.log(`  ${String(v).padStart(5)}  ${k}`);
console.log("console errors:", errs.length); errs.slice(0,3).forEach(e=>console.log("  ERR "+e));
await browser.close();
