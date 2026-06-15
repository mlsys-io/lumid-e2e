import { chromium } from "playwright";
import fs from "fs";
const PAT = fs.readFileSync("/work/.pat-tmp","utf8").trim();
const BASE="https://lum.id";
const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.route("**/*",(r)=>r.continue({headers:{...r.request().headers(),authorization:`Bearer ${PAT}`}}));
const page = await ctx.newPage();
let total=0, got429=0, cooldownBlocked=0;
const tally={};
page.on("request", rq=>{ const m=rq.url().match(/\/api\/v1\/me\/[^?]*/); if(m){ total++; tally[m[0]]=(tally[m[0]]||0)+1; } });
page.on("response", async r=>{ if(r.url().includes("/api/v1/me/") && r.status()===429) got429++; });
// Pre-trip the limiter for THIS bearer bucket: hammer /me/apps to exceed 300
await page.goto(BASE+"/studio",{waitUntil:"domcontentloaded"}).catch(()=>{});
await page.evaluate(async ()=>{ const p=[]; for(let i=0;i<330;i++) p.push(fetch("/api/v1/me/apps",{headers:{},credentials:"include"}).catch(()=>{})); await Promise.allSettled(p); });
console.log("pre-trip done; now navigating to /studio/apps under rate-limit pressure");
const t0=Date.now(); total=0; got429=0;
await page.goto(BASE+"/studio/apps",{waitUntil:"domcontentloaded"}).catch(()=>{});
await page.waitForTimeout(15000);  // 15s: does it storm or back off?
console.log(`\nAfter trip → /studio/apps over 15s:`);
console.log(`  total /me reqs (app-driven): ${total}   429s: ${got429}`);
for(const [k,v] of Object.entries(tally).sort((a,b)=>b[1]-a[1]).slice(0,8)) console.log(`    ${String(v).padStart(4)}  ${k}`);
await browser.close();
