import { chromium } from "playwright";
import fs from "fs";
const PAT = fs.readFileSync("/work/.pat-tmp","utf8").trim();
const B="https://lum.id";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport:{width:1600,height:1000} });
await ctx.route("**/*",(r)=>r.continue({headers:{...r.request().headers(),authorization:`Bearer ${PAT}`}}));
const page = await ctx.newPage();
const errs=[]; page.on("pageerror",e=>errs.push(String(e).slice(0,140)));
for(let i=0;i<3;i++){ try{ await page.goto(B+"/studio/apps/mbb-ai",{waitUntil:"load",timeout:30000}); break;}catch(e){ if(i===2)errs.push("goto:"+e.message.slice(0,50)); await page.waitForTimeout(1200);} }
await page.waitForTimeout(6500);
const opener = await page.locator("text=/diagnose the failure|run a workflow|what it learned|failing|looks healthy|What next/i").allInnerTexts().catch(()=>[]);
const goalTop = await page.locator("text=/GOAL|HOW IT/i").first().isVisible().catch(()=>false);
await page.screenshot({path:"/out/ws3.png", fullPage:false});
console.log(`errs=${errs.length}${errs[0]?(' :: '+errs[0]):''}`);
console.log(`opener/chips seen: ${JSON.stringify(opener.slice(0,5))}`);
await browser.close();
