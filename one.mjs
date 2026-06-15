import { chromium } from "playwright";
import fs from "fs";
const PAT = fs.readFileSync("/work/.pat-tmp","utf8").trim();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport:{width:1440,height:900} });
await ctx.route("**/*",(r)=>r.continue({headers:{...r.request().headers(),authorization:`Bearer ${PAT}`}}));
const page = await ctx.newPage();
for (let i=0;i<3;i++){ try{ await page.goto("https://lum.id/studio",{waitUntil:"load",timeout:30000}); break; }catch(e){ if(i===2)throw e; await page.waitForTimeout(1500);} }
await page.waitForTimeout(3500);
await page.screenshot({path:"/out/chat-home.png"});
console.log("ok");
await browser.close();
