import { chromium } from "playwright";
import fs from "fs";
const PAT = fs.readFileSync("/work/.pat-tmp","utf8").trim();
const BASE="https://lum.id";
const browser = await chromium.launch();
for (const [label,path] of [["/studio/apps (index)","/studio/apps"],["/studio/apps/mbb-ai (overview)","/studio/apps/mbb-ai"]]) {
  const ctx = await browser.newContext();
  await ctx.route("**/*",(r)=>r.continue({headers:{...r.request().headers(),authorization:`Bearer ${PAT}`}}));
  const page = await ctx.newPage();
  const js=new Set(); const errs=[];
  page.on("response", r=>{ const u=r.url(); if(u.endsWith(".js")&&u.includes("/assets/")) js.add(u.split("/assets/")[1].replace(/-[A-Za-z0-9_]+\.js$/,".js")); });
  page.on("pageerror", e=>errs.push(String(e).slice(0,120)));
  await page.goto(BASE+path,{waitUntil:"load"}).catch(()=>{});
  await page.waitForTimeout(3500);
  const heavy = [...js].filter(c=>/vendor-flow|vendor-charts|vendor-markdown|vendor-emoji/.test(c));
  const cards = await page.locator("text=/Systems Optimizer|MBB Coach|Auto-Quant|healthy|Workflows|Run now|Regression/i").count().catch(()=>0);
  console.log(`\n## ${label}  rendered=${cards>0?"YES":"NO"} errors=${errs.length}`);
  console.log(`   heavy chunks loaded: ${heavy.length?heavy.join(", "):"(none)"}`);
  if(errs.length) console.log("   ERR: "+errs[0]);
  await ctx.close();
}
await browser.close();
