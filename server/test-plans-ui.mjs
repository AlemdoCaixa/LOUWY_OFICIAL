import pg from "pg";
import puppeteer from "puppeteer-core";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const churchResult = await pool.query("select id,slug from churches where slug='primicias' limit 1");
const church = churchResult.rows[0];
const state = await pool.query("select value from church_state where church_id=$1 and key='workspace'", [church.id]);
const workspace = state.rows[0].value;
const master = workspace.members.find((item) => item.role === "master" && item.active !== false);
const secret = (await readFile("server/data/auth-secret.txt", "utf8")).trim();
const payload = { sub: master.id, cid: church.id, exp: Math.floor(Date.now()/1000)+600, ver:Number(master.authVersion||1) };
const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
const token = body + "." + createHmac("sha256", secret).update(body).digest("base64url");

const browser = await puppeteer.launch({
  headless:true,
  executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args:["--no-sandbox","--disable-gpu","--host-resolver-rules=MAP louwy.com.br 127.0.0.1, MAP *.louwy.com.br 127.0.0.1"]
});
const institutional = await browser.newPage();
await institutional.setViewport({width:1440,height:1100,deviceScaleFactor:1});
await institutional.goto("http://louwy.com.br:5173",{waitUntil:"networkidle2"});
const landing = await institutional.evaluate(() => ({
  cards: document.querySelectorAll(".institutional-plan-card").length,
  prices: [...document.querySelectorAll(".institutional-plan-price strong")].map((item)=>item.textContent?.trim()),
  heading: document.querySelector(".institutional-pricing h2")?.textContent?.trim(),
  width: document.body.scrollWidth,
  viewport: window.innerWidth,
}));
console.log("LANDING",JSON.stringify(landing));
await institutional.screenshot({path:"/tmp/louwy-plans-institutional.png",fullPage:true});

const tenant = await browser.newPage();
await tenant.setViewport({width:1440,height:1000,deviceScaleFactor:1});
await tenant.setCookie({name:"louvelab_session",value:token,domain:"primicias.louwy.com.br",path:"/",httpOnly:true,sameSite:"Lax"});
await tenant.goto("http://primicias.louwy.com.br:5173",{waitUntil:"networkidle2"});
await tenant.waitForSelector(".hero");
await tenant.click(".account-plan-button");
await tenant.waitForSelector(".billing-modal");
const modal = await tenant.evaluate(() => ({
  cards: document.querySelectorAll(".billing-plan-card").length,
  active: document.querySelector(".billing-plan-card.active .billing-plan-title strong")?.textContent?.trim(),
  usage: [...document.querySelectorAll(".billing-usage strong")].map((item)=>item.textContent?.trim()),
  buttons: [...document.querySelectorAll(".billing-plan-card button")].map((item)=>item.textContent?.trim()),
  width: document.body.scrollWidth,
  viewport: window.innerWidth,
}));
console.log("MODAL",JSON.stringify(modal));
await tenant.screenshot({path:"/tmp/louwy-plans-modal.png",fullPage:true});

await tenant.evaluate(()=>[...document.querySelectorAll(".nav-button")].find((item)=>item.textContent?.includes("Pessoas"))?.click());
await tenant.waitForSelector(".plan-usage-card");
const people = await tenant.evaluate(() => ({
  plan: document.querySelector(".plan-usage-card h2")?.textContent?.trim(),
  usage: document.querySelector(".plan-usage-card p")?.textContent?.trim(),
  limitReached: document.querySelector(".plan-usage-card")?.classList.contains("limit-reached"),
}));
console.log("PEOPLE",JSON.stringify(people));
await browser.close();
await pool.end();
