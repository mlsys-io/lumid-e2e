import { chromium } from "playwright";
import fs from "fs";
const PAT = fs.readFileSync("/work/.pat-tmp","utf8").trim();
const B="https://lum.id";
const browser = await chromium.launch();
const ctx = await browser.newContext({ serviceWorkers: "allow" });
await ctx.route("**/*",(r)=>r.continue({headers:{...r.request().headers(),authorization:`Bearer ${PAT}`}}));
const page = await ctx.newPage();
const errs=[]; page.on("pageerror",e=>errs.push(String(e).slice(0,120)));
await page.goto(B+"/studio",{waitUntil:"load"});
await page.waitForTimeout(4000); // let SW install/activate
const controlled1 = await page.evaluate(()=>!!navigator.serviceWorker.controller);
const reg = await page.evaluate(async()=>{ const r=await navigator.serviceWorker.getRegistration(); return r? (r.active?"active":"installing"):"none"; });
// reload — measure assets served from SW cache
let fromSW=0, fromNet=0;
page.on("response", r=>{ const u=r.url(); if(/\/auth\/assets\/.*\.(js|woff2?)$/.test(u)){ if(r.fromServiceWorker()) fromSW++; else fromNet++; } });
await page.reload({waitUntil:"load"});
await page.waitForTimeout(2500);
const controlled2 = await page.evaluate(()=>!!navigator.serviceWorker.controller);
const rendered = await page.locator("text=/Good (morning|afternoon|evening)|Ask anything/i").count().catch(()=>0);
console.log(`SW registration=${reg}  controlled(1st)=${controlled1}  controlled(reload)=${controlled2}`);
console.log(`on reload — assets fromServiceWorker=${fromSW}  fromNetwork=${fromNet}`);
console.log(`rendered=${rendered>0?"YES":"NO"}  pageErrors=${errs.length}${errs[0]?(" :: "+errs[0]):""}`);
await browser.close();
