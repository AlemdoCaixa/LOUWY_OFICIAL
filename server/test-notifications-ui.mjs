import pg from "pg";
import puppeteer from "puppeteer-core";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const state = await pool.query("select value from app_state where key='workspace'");
const workspace = state.rows[0].value;
const member = workspace.members.find((item) => item.role === "master" && item.active !== false);
const secret = (await readFile("server/data/auth-secret.txt", "utf8")).trim();
const payload = { sub: member.id, exp: Math.floor(Date.now()/1000)+600, ver:Number(member.authVersion||1) };
const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
const token = body + "." + createHmac("sha256", secret).update(body).digest("base64url");

const browser = await puppeteer.launch({
  headless:true,
  executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args:["--no-sandbox","--disable-gpu"]
});
async function openPage(width,height){
  const page=await browser.newPage();
  await page.setViewport({width,height,deviceScaleFactor:1});
  await page.setCookie({name:"louvelab_session",value:token,domain:"localhost",path:"/",httpOnly:true,sameSite:"Strict"});
  await page.goto("http://localhost:5173",{waitUntil:"networkidle2"});
  return page;
}

const desktop=await openPage(1440,1000);
const desktopBefore=await desktop.evaluate(()=>{
  const button=document.querySelector(".notification-button");
  const rect=button?.getBoundingClientRect();
  return {
    exists:Boolean(button),
    display:button?getComputedStyle(button).display:"missing",
    visibility:button?getComputedStyle(button).visibility:"missing",
    opacity:button?getComputedStyle(button).opacity:"missing",
    width:rect?.width||0,
    height:rect?.height||0,
    inViewport:Boolean(rect&&rect.top>=0&&rect.left>=0&&rect.bottom<=innerHeight&&rect.right<=innerWidth)
  };
});
console.log("DESKTOP_BUTTON",JSON.stringify(desktopBefore));
await desktop.click(".notification-button");
await desktop.waitForSelector(".notification-panel");
const desktopPanel=await desktop.evaluate(()=>({
  panel:Boolean(document.querySelector(".notification-panel")),
  title:document.querySelector(".notification-panel-head strong")?.textContent,
  empty:document.querySelector(".notification-empty")?.textContent?.trim()
}));
console.log("DESKTOP_PANEL",JSON.stringify(desktopPanel));
await desktop.screenshot({path:"/tmp/louwy-notifications-desktop.png",fullPage:false});

const mobile=await openPage(390,844);
const mobileCheck=await mobile.evaluate(()=>{
  const button=document.querySelector(".notification-button");
  const logo=document.querySelector(".mobile-top-logo");
  const product=document.querySelector(".topbar-product-text");
  const rect=button?.getBoundingClientRect();
  return {
    button:Boolean(button),
    buttonDisplay:button?getComputedStyle(button).display:"missing",
    buttonWidth:rect?.width||0,
    logoWidth:logo?.getBoundingClientRect().width||0,
    logoLoaded:logo instanceof HTMLImageElement?logo.complete&&logo.naturalWidth>0:false,
    productDisplay:product?getComputedStyle(product).display:"missing",
    bodyWidth:document.body.scrollWidth,
    viewportWidth:innerWidth
  };
});
console.log("MOBILE",JSON.stringify(mobileCheck));
await mobile.screenshot({path:"/tmp/louwy-notifications-mobile.png",fullPage:false});

await browser.close();
await pool.end();
