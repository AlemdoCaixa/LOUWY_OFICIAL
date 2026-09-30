import assert from "node:assert/strict";
import pg from "pg";
import puppeteer from "puppeteer-core";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";

const appUrl = "http://localhost:5173";
const apiUrl = "http://127.0.0.1:5174";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const stamp = Date.now().toString().slice(-7);
const slug = "ui-" + Date.now().toString(36);
const masterPhone = "119" + stamp.padStart(8, "0");
const masterPassword = "UiMaster-" + randomUUID();
let churchId = "";
let browser;

async function api(path, { method = "GET", cookie = "", body } = {}) {
  const response = await fetch(apiUrl + path, {
    method,
    headers: {
      "X-Church-Slug": slug,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { response, data };
}

try {
  browser = await puppeteer.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto(appUrl, { waitUntil: "networkidle2" });
  await page.waitForSelector(".auth-secondary-actions");
  await page.click(".auth-secondary-actions button:nth-child(2)");
  await page.waitForFunction(() => document.querySelector(".auth-card h2")?.textContent?.includes("Cadastre"));
  const inputs = await page.$$(".auth-card input");
  assert.equal(inputs.length, 6);
  const values = ["Igreja UI QA", slug, "Master UI", masterPhone, masterPassword, masterPassword];
  for (let index = 0; index < values.length; index += 1) await inputs[index].type(values[index]);
  await page.click(".auth-submit");
  await page.waitForSelector(".hero", { timeout: 15000 });
  const storedSlug = await page.evaluate(() => localStorage.getItem("louwy-church-slug"));
  assert.equal(storedSlug, slug);
  const cookie = (await page.cookies()).find((item) => item.name === "louvelab_session");
  assert.ok(cookie);
  const masterCookie = `${cookie.name}=${cookie.value}`;
  const churchRow = await pool.query("SELECT id FROM churches WHERE slug = $1", [slug]);
  churchId = churchRow.rows[0]?.id || "";
  assert.ok(churchId);

  async function createMember(name, phone) {
    const result = await api("/api/members", { method: "POST", cookie: masterCookie, body: { name, phone, functions: ["Vocal"] } });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  const leaderOne = await createMember("Líder Visual Um", "118" + stamp.padStart(8, "0"));
  const leaderTwo = await createMember("Líder Visual Dois", "117" + stamp.padStart(8, "0"));

  async function firstAccess(phone, password) {
    const result = await api("/api/auth/first-access", { method: "POST", body: { phone, password, confirmation: password } });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    return result.response.headers.get("set-cookie").split(";")[0];
  }
  const leaderOneCookie = await firstAccess("118" + stamp.padStart(8, "0"), "LeaderVisualOne2026!");
  const leaderTwoCookie = await firstAccess("117" + stamp.padStart(8, "0"), "LeaderVisualTwo2026!");

  async function createTeam(name, leaderId) {
    const result = await api("/api/teams", { method: "POST", cookie: masterCookie, body: { name, leaderId, memberIds: [leaderId], vocalConfig: { highParts: 2, lowParts: 2 } } });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  const teamOne = await createTeam("Equipe Visual Um", leaderOne.id);
  await createTeam("Equipe Visual Dois", leaderTwo.id);
  const event = await api("/api/events", {
    method: "POST", cookie: leaderOneCookie,
    body: { title: "Evento Público da Equipe Um", date: "2026-10-11", time: "18:30", location: "Auditório", teamId: teamOne.id, modules: [{ id: randomUUID(), kind: "chat", title: "Conversas", order: 0 }], participants: [{ memberId: leaderOne.id, function: "Vocal" }] },
  });
  assert.equal(event.response.status, 201, JSON.stringify(event.data));

  const leaderPage = await browser.newPage();
  await leaderPage.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await leaderPage.evaluateOnNewDocument((churchSlug) => localStorage.setItem("louwy-church-slug", churchSlug), slug);
  const [cookieName, cookieValue] = leaderTwoCookie.split("=");
  await leaderPage.setCookie({ name: cookieName, value: decodeURIComponent(cookieValue), domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" });
  await leaderPage.goto(appUrl, { waitUntil: "networkidle2" });
  await leaderPage.waitForSelector(".hero");
  await leaderPage.evaluate(() => [...document.querySelectorAll(".nav-button")].find((button) => button.textContent?.includes("Eventos"))?.click());
  await leaderPage.waitForSelector(".church-agenda-card");
  const agendaUi = await leaderPage.evaluate(() => ({
    title: document.querySelector(".church-agenda-card strong")?.textContent,
    team: document.querySelector(".church-agenda-card .agenda-team-name")?.textContent,
    readonly: document.querySelector(".church-agenda-card .agenda-readonly-badge")?.textContent,
    accessibleEventCards: document.querySelectorAll(".modular-event-card").length,
    canCreate: [...document.querySelectorAll(".module-head button")].some((button) => button.textContent?.includes("Novo evento")),
  }));
  assert.equal(agendaUi.title, "Evento Público da Equipe Um");
  assert.equal(agendaUi.team, "Equipe Visual Um");
  assert.match(agendaUi.readonly || "", /Somente agenda/);
  assert.equal(agendaUi.accessibleEventCards, 0);
  assert.equal(agendaUi.canCreate, true);

  await leaderPage.evaluate(() => [...document.querySelectorAll(".nav-button")].find((button) => button.textContent?.includes("Pessoas"))?.click());
  await leaderPage.waitForSelector(".custom-team-card");
  const teamUi = await leaderPage.evaluate(() => ({
    cards: document.querySelectorAll(".custom-team-card").length,
    editableCards: document.querySelectorAll(".custom-team-card .team-card-actions").length,
    leaderLabels: [...document.querySelectorAll(".team-leader-label")].map((node) => node.textContent),
  }));
  assert.equal(teamUi.cards, 2);
  assert.equal(teamUi.editableCards, 1);
  assert.ok(teamUi.leaderLabels.some((label) => label?.includes("Líder Visual Dois")));
  await leaderPage.screenshot({ path: "/tmp/louwy-multi-church-ui.png", fullPage: true });

  console.log(JSON.stringify({
    ok: true,
    registrationScreen: true,
    registeredChurch: slug,
    leaderAgenda: agendaUi,
    leaderTeamControls: teamUi,
  }, null, 2));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (churchId) {
    await pool.query("DELETE FROM churches WHERE id = $1", [churchId]).catch(() => {});
    for (const folder of ["audio", "stems", "event-files", "branding", "avatars"]) {
      await rm(join("server", "data", folder, churchId), { recursive: true, force: true }).catch(() => {});
    }
  }
  await pool.end();
}
