import { chromium } from "playwright";
import fs from "fs";
const PAT = fs.readFileSync("/work/.pat-tmp","utf8").trim();
const B="https://lum.id";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport:{width:1600,height:1000} });
await ctx.route("**/*",(r)=>r.continue({headers:{...r.request().headers(),authorization:`Bearer ${PAT}`}}));
const page = await ctx.newPage();
const errs=[]; page.on("pageerror",e=>errs.push(String(e).slice(0,140)));
for (const [name,path] of [["front2","/studio"],["app2","/studio/apps/mbb-ai"]]) {
  for(let i=0;i<3;i++){ try{ await page.goto(B+path,{waitUntil:"load",timeout:30000}); break;}catch(e){ if(i===2)errs.push("goto:"+e.message.slice(0,50)); await page.waitForTimeout(1200);} }
  await page.waitForTimeout(6500);
  const wf = await page.locator("text=/Regression sweep|Case cycle|No workflows discovered/i").allInnerTexts().catch(()=>[]);
  await page.screenshot({path:`/out/${name}.png`});
  console.log(`${name}: errs=${errs.length} wf=${JSON.stringify(wf.slice(0,4))}`);
  errs.length=0;
}
await browser.close();
