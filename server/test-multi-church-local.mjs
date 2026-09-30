import assert from "node:assert/strict";
import pg from "pg";
import { createHmac, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const base = "http://127.0.0.1:5174";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const slug = "qa-" + Date.now().toString(36);
const password = "Qa-" + randomUUID();
let testChurchId = "";

function sessionCookie(member, churchId, secret) {
  const payload = { sub: member.id, cid: churchId, exp: Math.floor(Date.now() / 1000) + 900, ver: Number(member.authVersion || 1) };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const token = body + "." + createHmac("sha256", secret).update(body).digest("base64url");
  return "louvelab_session=" + encodeURIComponent(token);
}

async function request(path, { method = "GET", cookie = "", church = "", body, form } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (church) headers["X-Church-Slug"] = church;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(base + path, { method, headers, body: form || (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { response, data };
}

try {
  const churches = await pool.query("SELECT id, slug FROM churches WHERE active = true ORDER BY created_at");
  const defaultChurch = churches.rows.find((row) => row.slug === "primicias") || churches.rows[0];
  assert.ok(defaultChurch, "default church must exist");
  const defaultState = await pool.query("SELECT value FROM church_state WHERE church_id = $1 AND key = 'workspace'", [defaultChurch.id]);
  const defaultWorkspace = defaultState.rows[0].value;
  const defaultMaster = defaultWorkspace.members.find((member) => member.role === "master" && member.active !== false);
  assert.ok(defaultMaster?.phone, "default master must have a phone");
  const secret = (await readFile("server/data/auth-secret.txt", "utf8")).trim();
  const defaultCookie = sessionCookie(defaultMaster, defaultChurch.id, secret);

  const context = await request("/api/church-context");
  assert.equal(context.response.status, 200);
  assert.equal(context.data.church.slug, defaultChurch.slug);

  const defaultCatalog = await request("/api/catalog", { cookie: defaultCookie, church: defaultChurch.slug });
  assert.equal(defaultCatalog.response.status, 200);
  assert.ok(Array.isArray(defaultCatalog.data));

  const registration = await request("/api/auth/register-church", {
    method: "POST",
    body: {
      organizationName: "Igreja QA Multi",
      churchSlug: slug,
      name: "Master QA",
      phone: defaultMaster.phone,
      password,
      confirmation: password,
    },
  });
  assert.equal(registration.response.status, 201, JSON.stringify(registration.data));
  assert.equal(registration.data.church.slug, slug);
  testChurchId = registration.data.church.id;
  const masterCookie = registration.response.headers.get("set-cookie").split(";")[0];

  const logoBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8j8AAAAASUVORK5CYII=", "base64");
  const brandingForm = new FormData();
  brandingForm.append("organizationName", "Igreja QA Multi");
  brandingForm.append("accentColor", "#a47b22");
  brandingForm.append("logo", new Blob([logoBytes], { type: "image/png" }), "logo.png");
  const brandingUpdate = await request("/api/branding", { method: "POST", cookie: masterCookie, church: slug, form: brandingForm });
  assert.equal(brandingUpdate.response.status, 200, JSON.stringify(brandingUpdate.data));
  assert.match(brandingUpdate.data.logoUrl, new RegExp(`church=${slug}$`));
  const publicLogo = await fetch(base + brandingUpdate.data.logoUrl);
  assert.equal(publicLogo.status, 200);
  assert.equal(publicLogo.headers.get("content-type"), "image/png");

  const isolatedCatalog = await request("/api/catalog", { cookie: masterCookie, church: slug });
  assert.equal(isolatedCatalog.response.status, 200);
  assert.deepEqual(isolatedCatalog.data, []);
  const wrongChurch = await request("/api/workspace", { cookie: masterCookie, church: defaultChurch.slug });
  assert.equal(wrongChurch.response.status, 401);

  const login = await request("/api/auth/login", {
    method: "POST",
    church: slug,
    body: { phone: defaultMaster.phone, password },
  });
  assert.equal(login.response.status, 200, JSON.stringify(login.data));
  assert.equal(login.data.member.churchSlug, slug);

  async function createMember(name, phone) {
    const result = await request("/api/members", {
      method: "POST", cookie: masterCookie, church: slug,
      body: { name, phone, functions: ["Vocal"] },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data;
  }

  const leaderOne = await createMember("Líder Um", "11988888001");
  const leaderTwo = await createMember("Líder Dois", "11988888002");

  const firstAccessOne = await request("/api/auth/first-access", {
    method: "POST", church: slug,
    body: { phone: "11988888001", password: "LeaderOne2026!", confirmation: "LeaderOne2026!" },
  });
  assert.equal(firstAccessOne.response.status, 200, JSON.stringify(firstAccessOne.data));
  const leaderOneCookie = firstAccessOne.response.headers.get("set-cookie").split(";")[0];

  const firstAccessTwo = await request("/api/auth/first-access", {
    method: "POST", church: slug,
    body: { phone: "11988888002", password: "LeaderTwo2026!", confirmation: "LeaderTwo2026!" },
  });
  assert.equal(firstAccessTwo.response.status, 200, JSON.stringify(firstAccessTwo.data));
  const leaderTwoCookie = firstAccessTwo.response.headers.get("set-cookie").split(";")[0];

  async function createTeam(name, leaderId) {
    const result = await request("/api/teams", {
      method: "POST", cookie: masterCookie, church: slug,
      body: { name, memberIds: [leaderId], leaderId, vocalConfig: { highParts: 2, lowParts: 2 } },
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return result.data;
  }

  const teamOne = await createTeam("Equipe Um", leaderOne.id);
  const teamTwo = await createTeam("Equipe Dois", leaderTwo.id);

  const eventOne = await request("/api/events", {
    method: "POST", cookie: leaderOneCookie, church: slug,
    body: {
      title: "Culto Equipe Um",
      date: "2026-10-04",
      time: "19:00",
      location: "Templo",
      teamId: teamOne.id,
      modules: [
        { id: randomUUID(), kind: "participants", title: "Participantes", order: 0 },
        { id: randomUUID(), kind: "chat", title: "Conversas", order: 1 },
        { id: randomUUID(), kind: "files", title: "Arquivos", order: 2 },
      ],
      participants: [{ memberId: leaderOne.id, function: "Vocal" }],
    },
  });
  assert.equal(eventOne.response.status, 201, JSON.stringify(eventOne.data));

  const forbiddenTeam = await request("/api/events", {
    method: "POST", cookie: leaderOneCookie, church: slug,
    body: { title: "Evento indevido", teamId: teamTwo.id, participants: [] },
  });
  assert.equal(forbiddenTeam.response.status, 403);

  const leaderOneEdit = await request(`/api/events/${eventOne.data.id}`, {
    method: "PATCH", cookie: leaderOneCookie, church: slug,
    body: { title: "Culto Equipe Um Atualizado" },
  });
  assert.equal(leaderOneEdit.response.status, 200, JSON.stringify(leaderOneEdit.data));

  const leaderTwoEdit = await request(`/api/events/${eventOne.data.id}`, {
    method: "PATCH", cookie: leaderTwoCookie, church: slug,
    body: { title: "Invasão" },
  });
  assert.equal(leaderTwoEdit.response.status, 403);

  const workspaceOne = await request("/api/workspace", { cookie: leaderOneCookie, church: slug });
  assert.equal(workspaceOne.response.status, 200);
  assert.ok(workspaceOne.data.events.some((event) => event.id === eventOne.data.id));

  const workspaceTwo = await request("/api/workspace", { cookie: leaderTwoCookie, church: slug });
  assert.equal(workspaceTwo.response.status, 200);
  assert.equal(workspaceTwo.data.events.some((event) => event.id === eventOne.data.id), false);
  const agendaItem = workspaceTwo.data.agenda.find((event) => event.id === eventOne.data.id);
  assert.ok(agendaItem);
  assert.deepEqual(Object.keys(agendaItem).sort(), ["color", "date", "emoji", "id", "location", "teamId", "teamName", "time", "title"].sort());
  assert.equal(agendaItem.teamName, "Equipe Um");

  const groupAccess = await request(`/api/events/${eventOne.data.id}/messages`, {
    method: "POST", cookie: leaderTwoCookie, church: slug, body: { text: "Não deveria entrar" },
  });
  assert.equal(groupAccess.response.status, 403);

  const form = new FormData();
  form.append("files", new Blob(["isolated file"], { type: "text/plain" }), "isolated.txt");
  const upload = await request(`/api/events/${eventOne.data.id}/attachments`, {
    method: "POST", cookie: leaderOneCookie, church: slug, form,
  });
  assert.equal(upload.response.status, 201, JSON.stringify(upload.data));
  const attachmentId = upload.data.attachments[0].id;
  const deniedFile = await request(`/api/events/${eventOne.data.id}/attachments/${attachmentId}/file`, {
    cookie: leaderTwoCookie, church: slug,
  });
  assert.equal(deniedFile.response.status, 403);

  const teamEdit = await request(`/api/teams/${teamOne.id}`, {
    method: "PATCH", cookie: leaderOneCookie, church: slug,
    body: { description: "Equipe administrada pelo líder", memberIds: [leaderOne.id] },
  });
  assert.equal(teamEdit.response.status, 200, JSON.stringify(teamEdit.data));
  const otherTeamEdit = await request(`/api/teams/${teamTwo.id}`, {
    method: "PATCH", cookie: leaderOneCookie, church: slug,
    body: { description: "Não autorizado" },
  });
  assert.equal(otherTeamEdit.response.status, 403);

  const duplicateSlug = await request("/api/auth/register-church", {
    method: "POST",
    body: { organizationName: "Duplicada", churchSlug: slug, name: "Outro", phone: "11977777000", password, confirmation: password },
  });
  assert.equal(duplicateSlug.response.status, 409);

  const finalDefaultCatalog = await request("/api/catalog", { cookie: defaultCookie, church: defaultChurch.slug });
  assert.deepEqual(finalDefaultCatalog.data, defaultCatalog.data);

  console.log(JSON.stringify({
    ok: true,
    defaultChurch: defaultChurch.slug,
    testChurch: slug,
    samePhoneAcrossChurches: true,
    isolatedCatalog: isolatedCatalog.data.length,
    leaderOwnTeamAllowed: teamEdit.response.status,
    leaderOtherTeamDenied: otherTeamEdit.response.status,
    publicAgendaFields: Object.keys(agendaItem),
    privateGroupDenied: groupAccess.response.status,
    crossChurchSessionDenied: wrongChurch.response.status,
  }, null, 2));
} finally {
  if (testChurchId) {
    await pool.query("DELETE FROM churches WHERE id = $1", [testChurchId]).catch(() => {});
    for (const folder of ["audio", "stems", "event-files", "branding", "avatars"]) {
      await rm(join("server", "data", folder, testChurchId), { recursive: true, force: true }).catch(() => {});
    }
  }
  await pool.end();
}
