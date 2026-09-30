import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const browser = await puppeteer.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--host-resolver-rules=MAP louwy.com.br 127.0.0.1, MAP *.louwy.com.br 127.0.0.1",
  ],
});
try {
  const root = await browser.newPage();
  await root.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await root.goto("http://louwy.com.br:5173", { waitUntil: "networkidle2" });
  await root.waitForSelector(".institutional-page");
  const rootUi = await root.evaluate(() => ({
    title: document.title,
    heading: document.querySelector(".institutional-hero h1")?.textContent,
    access: [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("Acessar minha igreja")),
    register: [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("Cadastrar minha igreja")),
  }));
  assert.equal(rootUi.title, "Louwy | Plataforma para ministérios de louvor");
  assert.ok(rootUi.heading?.includes("Todo o ministério afinado"));
  assert.equal(rootUi.access, true);
  assert.equal(rootUi.register, true);
  await root.screenshot({ path: "/tmp/louwy-institucional.png", fullPage: true });

  const tenant = await browser.newPage();
  await tenant.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await tenant.goto("http://primicias.louwy.com.br:5173", { waitUntil: "networkidle2" });
  await tenant.waitForSelector(".auth-page");
  const tenantUi = await tenant.evaluate(() => ({
    title: document.title,
    institutional: Boolean(document.querySelector(".institutional-page")),
    logoAlt: document.querySelector(".auth-ministry-lockup img")?.getAttribute("alt"),
    loginHeading: document.querySelector(".auth-card h2")?.textContent,
  }));
  assert.equal(tenantUi.institutional, false);
  assert.equal(tenantUi.logoAlt, "Ministério Primícias");
  assert.ok(tenantUi.loginHeading?.includes("Entre pelo seu celular"));
  await tenant.screenshot({ path: "/tmp/louwy-primicias-subdomain.png", fullPage: true });
  console.log(JSON.stringify({ ok: true, root: rootUi, tenant: tenantUi }, null, 2));
} finally {
  await browser.close();
}
