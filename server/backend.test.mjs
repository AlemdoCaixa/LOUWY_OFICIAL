import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, symlink, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scryptSync } from "node:crypto";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

// Run the actual HTTP handlers in a disposable copy. The deliberately slow
// state adapter exposes lost-update races without using any real database.
const source = dirname(fileURLToPath(import.meta.url));
let directory;
let child;
let baseUrl;
let output = "";
let proxyServer;
const cookies = {};

async function eventually(check, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail("Timed out waiting for test condition. Server output: " + output);
}

async function api(path, { user = "master", method = "GET", body, headers = {}, ...options } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { ...(cookies[user] ? { Cookie: cookies[user] } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...options
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { response, data };
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "louwy-backend-"));
  await mkdir(join(directory, "data", "audio"), { recursive: true });
  await mkdir(join(directory, "data", "branding"), { recursive: true });
  await mkdir(join(directory, "data", "avatars"), { recursive: true });
  await symlink(resolve(source, "../node_modules"), join(directory, "node_modules"));
  await Promise.all(["index.mjs", "auth.mjs", "church-context.mjs", "plans.mjs", "mercadopago.mjs", "youtube-proxy.mjs"].map((name) => copyFile(join(source, name), join(directory, name))));
  const passwordSalt = "regression-test-salt";
  const passwordHash = scryptSync("test-password", passwordSalt, 64).toString("base64");
  const members = ["master", "vocal", "outsider", "inactive", "replacement"].map((id, index) => ({
    id, name: id, phone: "1199999999" + index, role: id === "master" ? "master" : "member", functions: ["Vocal"],
    active: id !== "inactive", passwordSalt, passwordHash, authVersion: 1,
    ...(id === "vocal" ? { avatarStoredName: "old-avatar.png", avatarUrl: "/member-avatars/old-avatar.png" } : {})
  }));
  members.find((row) => row.id === "inactive").phone = members.find((row) => row.id === "replacement").phone;
  const event = {
    id: "event-a", title: "Private event", modules: [{ kind: "repertoire" }, { kind: "files" }],
    participants: [
      { memberId: "vocal", status: "unavailable", absenceReason: "Private vocal reason" },
      { memberId: "master", status: "unavailable", absenceReason: "Private master reason" }
    ],
    songs: [{ id: "event-song", songId: "song-a", ministerId: "master", vocalAssignments: [{ memberId: "vocal", register: "high", part: 1 }] }],
    messages: [{ id: "message", text: "Secret conversation" }], attachments: [], vocalConfig: { highParts: 3, lowParts: 3 }
  };
  await writeFile(join(directory, "data", "workspace.json"), JSON.stringify({
    branding: { organizationName: "Test", logoStoredName: "old-logo.png", logoUrl: "/tenant-branding/old-logo.png" },
    members, events: [event, { ...event, id: "event-b", title: "Other event", participants: [{ memberId: "outsider" }], songs: [] }], teams: [], profiles: {}
  }));
  const songIds = ["AsyncKnown1", "queue-async", "queue-capacity", "song-a", "media-lyrics", "media-stems", "media-key", "queue-blocker", "dedup-lyrics", "dedup-stems", "dedup-key", "key-delete", ...Array.from({ length: 22 }, (_, index) => "queue-" + index)];
  await writeFile(join(directory, "data", "catalog.json"), JSON.stringify(songIds.map((id) => ({ id, title: "Original title", originalKey: "C" }))));
  await Promise.all(songIds.map((id) => writeFile(join(directory, "data", "audio", id + ".mp3"), "fixture audio")));
  await writeFile(join(directory, "data", "branding", "old-logo.png"), "old logo");
  await writeFile(join(directory, "data", "avatars", "old-avatar.png"), "old avatar");
  await writeFile(join(directory, "state-db.mjs"), `
    import { writeFile } from 'node:fs/promises';
    import { existsSync, readFileSync } from 'node:fs';
    import { randomUUID } from 'node:crypto';
    import { setTimeout as delay } from 'node:timers/promises';
    const realNow = Date.now;
    Date.now = () => realNow() + (existsSync(process.env.TEST_CLOCK) ? Number(readFileSync(process.env.TEST_CLOCK, 'utf8')) : 0);
    const states = new Map();
    const churches = new Map();
    const churchStates = new Map();
    const defaultChurch = { id: 'test-church', slug: 'primicias', name: 'Test', active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const churchKey = (churchId,key) => churchId + ':' + key;
    export const normalizeChurchSlug = value => String(value||'').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').replace(/-{2,}/g,'').slice(0,48);
    export async function initializeDatabase() {}
    export async function ensureState(key, fallback) { if (!states.has(key)) states.set(key, structuredClone(fallback)); }
    export async function readState(key) { return structuredClone(states.get(key)); }
    export async function writeState(key, value) { states.set(key, structuredClone(value)); return { version: 1 }; }
    export async function ensureDefaultChurch({workspace,catalog}) {
      if (!churches.size) churches.set(defaultChurch.id, defaultChurch);
      if (!churchStates.has(churchKey(defaultChurch.id,'workspace'))) churchStates.set(churchKey(defaultChurch.id,'workspace'), structuredClone(states.get('workspace')||workspace));
      if (!churchStates.has(churchKey(defaultChurch.id,'catalog'))) churchStates.set(churchKey(defaultChurch.id,'catalog'), structuredClone(states.get('catalog')||catalog||[]));
      return structuredClone(defaultChurch);
    }
    export async function getDefaultChurch() { return structuredClone(defaultChurch); }
    export async function getChurchById(id) { return structuredClone(churches.get(id)||null); }
    export async function findChurchBySlug(slug) { return structuredClone([...churches.values()].find(c=>c.slug===normalizeChurchSlug(slug))||null); }
    export async function listChurches() { return structuredClone([...churches.values()]); }
    export async function ensureChurchState(churchId,key,fallback) { const k=churchKey(churchId,key); if(!churchStates.has(k)) churchStates.set(k,structuredClone(fallback)); }
    export async function readChurchState(churchId,key) { return structuredClone(churchStates.get(churchKey(churchId,key))); }
    export async function writeChurchState(churchId,key,value) {
      const snapshot=structuredClone(value); const k=churchKey(churchId,key);
      if (key === 'workspace' && (value.branding.organizationName === 'FAIL_SAVE' || value.members.some(m => m.name === 'FAIL_SAVE'))) throw new Error('simulated database failure');
      if (key === 'workspace' && value.teams.some(team => team.name === 'abort-first') && !(churchStates.get(k)?.teams||[]).some(team => team.name === 'abort-first')) { await writeFile(process.env.WORKSPACE_MARKER,'started'); await delay(200); }
      if (key === 'catalog' && value.some(song => song.title === 'Concurrent catalog title')) await delay(150);
      churchStates.set(k,snapshot); return {version:1};
    }
    export async function createChurch({slug,name,workspace,catalog=[]}) { const normalized=normalizeChurchSlug(slug); if([...churches.values()].some(c=>c.slug===normalized)){const error=new Error('taken');error.code='CHURCH_SLUG_TAKEN';throw error;} const church={id:randomUUID(),slug:normalized,name,active:true};churches.set(church.id,church);churchStates.set(churchKey(church.id,'workspace'),structuredClone(workspace));churchStates.set(churchKey(church.id,'catalog'),structuredClone(catalog));return structuredClone(church); }
    export async function stateHealth() { return { database: 'isolated-test', churches: churches.size }; }
    export async function closeDatabase() {}
  `);
  const lyricsBin = join(directory, "fake-lyrics.cjs");
  await writeFile(lyricsBin, `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path'); const id = path.basename(process.argv.at(-1), '.mp3'); const log = (event) => fs.appendFileSync(process.env.MEDIA_LOG, JSON.stringify({id,event})+'\\n'); log('start'); fs.writeFileSync(process.env.LYRICS_MARKER, 'started'); setTimeout(() => { log('end'); console.log(JSON.stringify({text:'one two three four five six seven eight',lines:[{text:'one two three four five six seven eight',time:0}],model:'test'})); }, id.startsWith('queue-') ? 30000 : id.startsWith('media-') ? 300 : 60);\n`, { mode: 0o755 });
  proxyServer = http.createServer();
  proxyServer.listen(0, "127.0.0.1");
  await once(proxyServer, "listening");
  child = spawn(process.execPath, [join(directory, "index.mjs")], {
    env: { ...process.env, PORT: "0", YTDLP_PROXY: `socks5h://127.0.0.1:${proxyServer.address().port}`, PYTHON_BIN: join(directory, "missing-python"), STEM_PYTHON_BIN: join(directory, "missing-stem-python"), SEPARATOR_BIN: join(directory, "missing-separator"), LYRICS_PYTHON_BIN: lyricsBin, LYRICS_MARKER: join(directory, "lyrics-started"), WORKSPACE_MARKER: join(directory, "workspace-started"), MEDIA_LOG: join(directory, "media-log"), TEST_CLOCK: join(directory, "test-clock") },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (data) => { output += data; baseUrl ||= output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; });
  child.stderr.on("data", (data) => { output += data; });
  await eventually(() => Boolean(baseUrl));
  for (const member of members.filter((row) => row.active)) {
    const { response } = await api("/api/auth/login", { user: null, method: "POST", body: { phone: member.phone, password: "test-password" } });
    assert.equal(response.status, 200);
    cookies[member.id] = response.headers.get("set-cookie").split(";")[0];
  }
});

after(async () => {
  if (proxyServer?.listening) await new Promise((resolve) => proxyServer.close(resolve));
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("malformed cookies and malformed JSON return client errors", async () => {
  const invalidCookie = await api("/api/auth/me", { user: null, headers: { Cookie: "louvelab_session=%ZZ" } });
  assert.equal(invalidCookie.response.status, 401);
  const unrelatedCookie = await api("/api/auth/me", { headers: { Cookie: cookies.master + "; broken=%ZZ" } });
  assert.equal(unrelatedCookie.response.status, 200);
  const response = await fetch(baseUrl + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(response.status, 400);
});

test("workspace filters events and masks other participants' absence reasons", async () => {
  const { data } = await api("/api/workspace", { user: "vocal" });
  assert.deepEqual(data.events.map((row) => row.id), ["event-a"]);
  assert.equal(data.events[0].participants.find((row) => row.memberId === "vocal").absenceReason, "Private vocal reason");
  assert.equal(data.events[0].participants.find((row) => row.memberId === "master").absenceReason, "");
  assert.equal(JSON.stringify(data).includes("passwordHash"), false);
  const attendance = await api("/api/events/event-a/attendance", { user: "vocal", method: "POST", body: { status: "confirmed" } });
  assert.equal(attendance.data.participants.find((row) => row.memberId === "master").absenceReason, "");
  const forbidden = await api("/api/events/event-a/messages", { user: "outsider", method: "POST", body: { text: "intrusion" } });
  assert.equal(forbidden.response.status, 403);
});

test("invalid vocal assignments preserve the previous valid assignment", async () => {
  for (const part of ["invalid", null, 1.5, 0, 4]) {
    const { response } = await api("/api/events/event-a/songs/event-song/vocal-part", { user: "vocal", method: "POST", body: { register: "high", part } });
    assert.equal(response.status, 400);
  }
  const { data } = await api("/api/workspace", { user: "vocal" });
  assert.equal(data.events[0].songs[0].vocalAssignments[0].part, 1);
  const cleared = await api("/api/events/event-a/songs/event-song/vocal-part", { user: "vocal", method: "POST", body: { register: null } });
  assert.equal(cleared.response.status, 200);
  assert.deepEqual(cleared.data.vocalAssignments, []);
});

test("master cannot be deactivated and duplicate phones cannot be reactivated", async () => {
  const master = await api("/api/members/master", { method: "PATCH", body: { active: false } });
  assert.equal(master.response.status, 400);
  const reactivated = await api("/api/members/inactive", { method: "PATCH", body: { active: true } });
  assert.equal(reactivated.response.status, 409);
});

test("free plan blocks the sixth active account", async () => {
  const billing = await api("/api/billing");
  assert.equal(billing.response.status, 200);
  assert.equal(billing.data.plan.id, "free");
  assert.equal(billing.data.members, 4);
  assert.equal(billing.data.memberLimit, 5);

  const fifth = await api("/api/members", {
    method: "POST",
    body: { name: "fifth active", phone: "11988887777", functions: ["Vocal"] },
  });
  assert.equal(fifth.response.status, 201);

  const sixth = await api("/api/members", {
    method: "POST",
    body: { name: "sixth active", phone: "11977776666", functions: ["Baixo"] },
  });
  assert.equal(sixth.response.status, 402);
  assert.equal(sixth.data.code, "PLAN_MEMBER_LIMIT");
  assert.equal(sixth.data.billing.members, 5);
});

test("member cannot change the global key through detection", async () => {
  const { response } = await api("/api/detect-key/song-a", { user: "vocal", method: "POST" });
  assert.equal(response.status, 403);
});

test("missing media executables report errors without killing the server", async () => {
  assert.equal((await api("/api/import", { method: "POST", body: { url: "https://www.youtube.com/watch?v=Example0001" } })).response.status, 500);
  assert.equal((await api("/api/detect-key/song-a", { method: "POST" })).response.status, 500);
  assert.equal((await api("/api/stems/song-a", { method: "POST" })).response.status, 202);
  await eventually(async () => (await api("/api/stems/song-a")).data.status === "error");
  assert.equal((await api("/api/health")).response.status, 200);
  assert.equal(child.exitCode, null);
});

test("uploaded MIME headers cannot make a text attachment execute as HTML", async () => {
  const form = new FormData();
  form.append("files", new Blob(["<script>alert(document.cookie)</script>"], { type: "text/html" }), "document.txt");
  const upload = await fetch(baseUrl + "/api/events/event-a/attachments", { method: "POST", headers: { Cookie: cookies.vocal }, body: form });
  assert.equal(upload.status, 201);
  const attachment = (await upload.json()).attachments[0];
  const file = await api("/api/events/event-a/attachments/" + attachment.id + "/file", { user: "vocal" });
  assert.match(file.response.headers.get("content-type"), /^text\/plain/);
  assert.equal(file.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(file.response.headers.get("content-security-policy"), "sandbox");
  assert.equal((await api("/api/events/event-a/attachments/" + attachment.id + "/file", { user: "outsider" })).response.status, 403);
});

test("malformed profile rows and duplicate or null event participants are handled", async () => {
  const profile = await api("/api/profile/vocal", { user: "vocal", method: "PUT", body: { profile: { library: [null] } } });
  assert.equal(profile.response.status, 400);
  assert.equal((await api("/api/profile/vocal", { user: "vocal", method: "PUT", body: { profile: "invalid" } })).response.status, 400);
  const created = await api("/api/events", { method: "POST", body: { title: "Valid event", participants: [null, { memberId: "vocal" }, { memberId: "vocal" }] } });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.participants.length, 1);
  assert.equal((await api("/api/events/" + created.data.id, { method: "PATCH", body: { title: "   " } })).response.status, 400);
});

test("failed database saves preserve the old logo and avatar files", async () => {
  for (const [route, field, textField, oldFile] of [
    ["branding", "logo", "organizationName", "branding/old-logo.png"],
    ["account", "avatar", "name", "avatars/old-avatar.png"]
  ]) {
    const form = new FormData();
    form.append(textField, "FAIL_SAVE");
    form.append(field, new Blob(["new image"], { type: "image/png" }), "new.png");
    const response = await fetch(baseUrl + "/api/" + route, { method: "POST", headers: { Cookie: cookies[route === "branding" ? "master" : "vocal"] }, body: form });
    assert.equal(response.status, 500);
    await access(join(directory, "data", oldFile));
  }
});

test("client disconnect does not release a pending workspace write early", async () => {
  const controller = new AbortController();
  const first = api("/api/teams", { method: "POST", body: { name: "abort-first" }, signal: controller.signal }).catch((error) => error);
  await eventually(async () => { try { await access(join(directory, "workspace-started")); return true; } catch { return false; } });
  controller.abort();
  await first;
  const second = await api("/api/teams", { method: "POST", body: { name: "second-team" } });
  assert.equal(second.response.status, 201);
  const { data } = await api("/api/workspace");
  assert.ok(data.teams.some((row) => row.name === "abort-first"));
  assert.ok(data.teams.some((row) => row.name === "second-team"));
  assert.equal((await api("/api/teams/" + second.data.id, { method: "PATCH", body: { name: " " } })).response.status, 400);
});

test("an interrupted multipart upload releases the mutation queue", async () => {
  const request = http.request(baseUrl + "/api/account", { method: "POST", headers: {
    Cookie: cookies.vocal, "Content-Type": "multipart/form-data; boundary=test-boundary"
  } });
  request.on("error", () => {});
  request.write('--test-boundary\r\nContent-Disposition: form-data; name="avatar"; filename="interrupted.png"\r\nContent-Type: image/png\r\n\r\npartial-image');
  await delay(60);
  request.destroy();
  const result = await api("/api/teams", { method: "POST", body: { name: "after-interrupted-upload" }, signal: AbortSignal.timeout(3000) });
  assert.equal(result.response.status, 201);
});

test("background lyrics and concurrent catalog edits preserve both changes", async () => {
  const lyrics = await api("/api/lyrics/song-a", { method: "POST" });
  assert.equal(lyrics.response.status, 202);
  await eventually(async () => { try { await access(join(directory, "lyrics-started")); return true; } catch { return false; } });
  const patched = await api("/api/catalog/song-a", { method: "PATCH", body: { title: "Concurrent catalog title" } });
  assert.equal(patched.response.status, 200);
  await eventually(async () => (await api("/api/lyrics/song-a")).data.status === "ready");
  const song = (await api("/api/catalog")).data.find((row) => row.id === "song-a");
  assert.equal(song.title, "Concurrent catalog title");
  assert.equal(song.lyrics[0].text, "one two three four five six seven eight");
});

test("lyrics, stems and key detection share one subprocess slot", async () => {
  const common = `const fs=require('node:fs'); const path=require('node:path'); const id=path.basename(process.argv.at(-1),'.mp3'); const log=(event)=>fs.appendFileSync(process.env.MEDIA_LOG,JSON.stringify({id,event})+'\\n'); log('start');`;
  await writeFile(join(directory, "missing-stem-python"), `#!${process.execPath}\n${common} setTimeout(()=>{log('end');console.log(JSON.stringify({key:'D',mode:'major',confidence:90}));},100);\n`, { mode: 0o755 });
  await writeFile(join(directory, "missing-separator"), `#!${process.execPath}\n${common} process.stderr.write('55%|');setTimeout(()=>{const output=process.argv[process.argv.indexOf('--output_dir')+1];for(const stem of ['Vocals','Drums','Bass','Guitar','Piano','Other'])fs.writeFileSync(path.join(output,'test_('+stem+')_stem.mp3'),'test');log('end');},100);\n`, { mode: 0o755 });
  assert.equal((await api("/api/lyrics/media-lyrics", { method: "POST" })).response.status, 202);
  const stems = await api("/api/stems/media-stems", { method: "POST" });
  assert.equal(stems.response.status, 202);
  assert.equal(stems.data.queued, true);
  assert.equal((await api("/api/detect-key/media-key", { method: "POST" })).response.status, 200);
  assert.equal((await api("/api/stems/media-stems")).data.status, "ready");
  assert.equal((await api("/api/lyrics/media-lyrics")).data.status, "ready");
  const log = (await readFile(join(directory, "media-log"), "utf8")).trim().split("\n").map(JSON.parse).filter((row) => row.id.startsWith("media-"));
  assert.deepEqual(log, [
    { id: "media-lyrics", event: "start" }, { id: "media-lyrics", event: "end" },
    { id: "media-stems", event: "start" }, { id: "media-stems", event: "end" },
    { id: "media-key", event: "start" }, { id: "media-key", event: "end" }
  ]);
});

test("media queue is bounded and deleting queued or running songs cancels their jobs", async () => {
  for (let index = 0; index <= 20; index++) {
    assert.equal((await api("/api/lyrics/queue-" + index, { method: "POST" })).response.status, 202);
  }
  const overflow = await api("/api/lyrics/queue-21", { method: "POST" });
  assert.equal(overflow.response.status, 503);
  assert.match(overflow.data.error, /muitas músicas/);
  assert.equal((await api("/api/catalog/queue-10", { method: "DELETE" })).response.status, 200);
  assert.equal((await api("/api/lyrics/queue-21", { method: "POST" })).response.status, 202);
  for (let index = 1; index <= 21; index++) {
    if (index !== 10) assert.equal((await api("/api/catalog/queue-" + index, { method: "DELETE" })).response.status, 200);
  }
  assert.equal((await api("/api/catalog/queue-0", { method: "DELETE" })).response.status, 200);
  const log = (await readFile(join(directory, "media-log"), "utf8")).trim().split("\n").map(JSON.parse).filter((row) => row.id.startsWith("queue-"));
  assert.deepEqual(log, [{ id: "queue-0", event: "start" }]);
  assert.equal((await api("/api/lyrics/queue-0")).response.status, 404);
  assert.equal((await api("/api/lyrics/queue-10")).response.status, 404);
  assert.equal((await api("/api/detect-key/media-key", { method: "POST", signal: AbortSignal.timeout(3000) })).response.status, 200);
  assert.equal((await api("/api/health")).response.status, 200);
});

test("YouTube imports enable Node for both stages and explain provider blocking", async () => {
  const importer = join(directory, "missing-python");
  await writeFile(importer, `#!${process.execPath}\nprocess.stderr.write("Sign in to confirm you're not a bot");process.exit(1);\n`, { mode: 0o755 });
  const blocked = await api("/api/import", { method: "POST", body: { url: "https://www.youtube.com/watch?v=Fixture0001" } });
  assert.equal(blocked.response.status, 502);
  assert.match(blocked.data.error, /YouTube.*bloqueando/);
  await writeFile(importer, `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const args=process.argv; if(!args.includes('--no-playlist')||args[args.indexOf('--js-runtimes')+1]!=='node:'+process.execPath)process.exit(2);fs.appendFileSync(path.join(__dirname,'youtube-stages'),'checked\\n');if(args.includes('--dump-single-json'))console.log(JSON.stringify({id:'Fixture0001',title:'Imported test',duration:5}));else fs.writeFileSync(args[args.indexOf('-o')+1].replace('%(ext)s','mp3'),'audio');\n`, { mode: 0o755 });
  const imported = await api("/api/import", { method: "POST", body: { url: "https://www.youtube.com/watch?v=Fixture0001" } });
  assert.equal(imported.response.status, 201);
  assert.equal(imported.data.id, "Fixture0001");
  assert.equal(await readFile(join(directory, "youtube-stages"), "utf8"), "checked\nchecked\n");
});

test("queued media leaves workspace edits responsive and concurrent media requests deduplicate", async () => {
  await writeFile(join(directory, "missing-python"), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv;const id=new URL(args.at(-1)).searchParams.get('v');if(args.includes('--dump-single-json'))console.log(JSON.stringify({id,title:'Queued import',duration:5}));else fs.writeFileSync(args[args.indexOf('-o')+1].replace('%(ext)s','mp3'),'audio');\n`, { mode: 0o755 });
  assert.equal((await api("/api/lyrics/queue-blocker", { method: "POST" })).response.status, 202);
  await eventually(async () => (await readFile(join(directory, "media-log"), "utf8")).includes('"id":"queue-blocker","event":"start"'));
  const lyrics = await Promise.all(Array.from({ length: 4 }, () => api("/api/lyrics/dedup-lyrics", { method: "POST" })));
  const stems = await Promise.all(Array.from({ length: 4 }, () => api("/api/stems/dedup-stems", { method: "POST" })));
  for (const rows of [lyrics, stems]) {
    assert.ok(rows.every((row) => row.response.status === 202));
    assert.equal(new Set(rows.map((row) => row.data.startedAt)).size, 1);
  }
  let keyFinished = false;
  let importFinished = false;
  const key = Promise.all(Array.from({ length: 2 }, () => api("/api/detect-key/dedup-key", { method: "POST" }))).then((rows) => { keyFinished = true; return rows; });
  const importing = api("/api/import", { method: "POST", body: { url: "https://www.youtube.com/watch?v=Pending0001" } }).then((row) => { importFinished = true; return row; });
  const deletedKey = api("/api/detect-key/key-delete", { method: "POST" });
  await delay(80);
  const edited = await api("/api/teams", { method: "POST", body: { name: "edited-during-media" }, signal: AbortSignal.timeout(1500) });
  assert.equal(edited.response.status, 201);
  assert.equal(keyFinished, false);
  assert.equal(importFinished, false);
  assert.equal((await api("/api/catalog/key-delete", { method: "DELETE" })).response.status, 200);
  assert.equal((await deletedKey).response.status, 404);
  assert.equal((await api("/api/catalog/queue-blocker", { method: "DELETE" })).response.status, 200);
  assert.ok((await key).every((row) => row.response.status === 200));
  assert.equal((await importing).response.status, 201);
  await eventually(async () => (await api("/api/lyrics/dedup-lyrics")).data.status === "ready" && (await api("/api/stems/dedup-stems")).data.status === "ready");
  const log = (await readFile(join(directory, "media-log"), "utf8")).trim().split("\n").map(JSON.parse);
  for (const id of ["dedup-lyrics", "dedup-stems", "dedup-key"]) assert.equal(log.filter((row) => row.id === id && row.event === "start").length, 1);
  assert.equal(log.some((row) => row.id === "key-delete"), false);
});

test("concurrent imports of the same video download once and create one catalog row", async () => {
  const importer = join(directory, "missing-python");
  await writeFile(importer, `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const args=process.argv;if(args.includes('--dump-single-json'))setTimeout(()=>console.log(JSON.stringify({id:'Concurr0001',title:'Concurrent import',duration:5})),100);else { fs.appendFileSync(path.join(__dirname,'concurrent-downloads'),'download\\n');setTimeout(()=>fs.writeFileSync(args[args.indexOf('-o')+1].replace('%(ext)s','mp3'),'audio'),200); }\n`, { mode: 0o755 });
  const imported = await Promise.all([
    api("/api/import", { method: "POST", body: { url: "https://www.youtube.com/watch?v=Concurr0001" } }),
    api("/api/import", { method: "POST", body: { url: "https://youtu.be/Concurr0001" } })
  ]);
  assert.deepEqual(imported.map((row) => row.response.status).sort(), [201, 409]);
  assert.equal(imported.find((row) => row.response.status === 409).data.processing, true);
  assert.equal(await readFile(join(directory, "concurrent-downloads"), "utf8"), "download\n");
  assert.equal((await api("/api/catalog")).data.filter((row) => row.id === "Concurr0001").length, 1);
});

test("async import validates and canonicalizes links, and returns existing songs without contacting YouTube", async () => {
  const importer = join(directory, "missing-python");
  await writeFile(importer, `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');const args=process.argv;const url=new URL(args.at(-1));const id=url.searchParams.get('v');if(url.origin!=='https://www.youtube.com'||url.pathname!=='/watch'||[...url.searchParams.keys()].join()!=='v')process.exit(2);const stage=args.includes('--dump-single-json')?'checking':'downloading';fs.appendFileSync(path.join(__dirname,'async-provider-log'),JSON.stringify({id,stage})+'\\n');if(id==='AsyncFail01'||id.startsWith('Capa')){process.stderr.write("Sign in to confirm you're not a bot");process.exit(1);}if(stage==='checking')setTimeout(()=>console.log(JSON.stringify({id,title:'Async imported song',duration:5})),60);else setTimeout(()=>fs.writeFileSync(args[args.indexOf('-o')+1].replace('%(ext)s','mp3'),'audio'),60);\n`, { mode: 0o755 });
  for (const url of [
    "https://youtu.be/AsyncKnown1?si=share-tracking&t=10",
    "https://m.youtube.com/watch?v=AsyncKnown1&feature=share",
    "https://www.youtube.com/shorts/AsyncKnown1?si=tracking",
    "https://music.youtube.com/watch?v=AsyncKnown1&list=ignored"
  ]) {
    const duplicate = await api("/api/import", { method: "POST", body: { url, asynchronous: true } });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.data.song.id, "AsyncKnown1");
    assert.equal(duplicate.data.duplicate, true);
  }
  await assert.rejects(access(join(directory, "async-provider-log")));
  for (const url of ["https://youtu.be/short", "https://youtube.com.evil.example/watch?v=AsyncKnown1", "https://user:password@youtube.com/watch?v=AsyncKnown1", "https://youtu.be/AsyncKnown1/extra", "ftp://youtu.be/AsyncKnown1", "https://youtube.com/watch?v=../secret"]) {
    assert.equal((await api("/api/import", { method: "POST", body: { url, asynchronous: true } })).response.status, 400);
  }
});

test("async jobs return promptly behind long media, share work safely and expire only after finishing", async () => {
  assert.equal((await api("/api/lyrics/queue-async", { method: "POST" })).response.status, 202);
  await eventually(async () => (await readFile(join(directory, "media-log"), "utf8")).includes('"id":"queue-async","event":"start"'));
  const first = await api("/api/import", { method: "POST", body: { url: "https://youtu.be/AsyncTest01?si=share", asynchronous: true }, signal: AbortSignal.timeout(1500) });
  assert.equal(first.response.status, 202);
  assert.equal(first.data.status, "queued");
  assert.ok(first.data.jobId);
  const sameOwner = await api("/api/import", { method: "POST", body: { url: "https://www.youtube.com/shorts/AsyncTest01", asynchronous: true } });
  assert.equal(sameOwner.data.jobId, first.data.jobId);
  const otherOwner = await api("/api/import", { user: "vocal", method: "POST", body: { url: "https://m.youtube.com/watch?v=AsyncTest01&feature=share", asynchronous: true } });
  assert.equal(otherOwner.response.status, 202);
  assert.notEqual(otherOwner.data.jobId, first.data.jobId);
  const endpoint = "/api/import-jobs/" + first.data.jobId;
  assert.equal((await api(endpoint, { user: "vocal" })).response.status, 404);
  assert.equal((await api(endpoint, { user: null })).response.status, 401);
  assert.equal((await api("/api/import-jobs/missing-job")).response.status, 404);
  const queued = await api(endpoint);
  assert.equal(queued.data.status, "queued");
  assert.equal(queued.data.stage, "checking");
  assert.equal(queued.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(queued.data).sort(), ["jobId", "stage", "status"]);
  await writeFile(join(directory, "test-clock"), String(31 * 60 * 1000));
  assert.equal((await api(endpoint)).data.status, "queued", "active jobs must survive the retention interval");
  assert.equal((await api("/api/catalog/queue-async", { method: "DELETE" })).response.status, 200);
  await eventually(async () => (await api(endpoint)).data.status === "ready");
  const ready = (await api(endpoint)).data;
  assert.equal(ready.song.id, "AsyncTest01");
  assert.equal(ready.song.youtubeUrl, "https://www.youtube.com/watch?v=AsyncTest01");
  assert.equal(ready.song.addedBy, "master");
  assert.equal(ready.duplicate, false);
  assert.equal((await api("/api/import-jobs/" + otherOwner.data.jobId, { user: "vocal" })).data.song.id, "AsyncTest01");
  const calls = (await readFile(join(directory, "async-provider-log"), "utf8")).trim().split("\n").map(JSON.parse).filter((row) => row.id === "AsyncTest01");
  assert.deepEqual(calls.map((row) => row.stage), ["checking", "downloading"]);
  const duplicate = await api("/api/import", { method: "POST", body: { url: "https://youtu.be/AsyncTest01", asynchronous: true } });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.data.song.id, "AsyncTest01");
  await writeFile(join(directory, "test-clock"), String(62 * 60 * 1000));
  assert.equal((await api(endpoint)).response.status, 404);
});

test("async provider errors are useful and a failed job can be retried", async () => {
  const submit = () => api("/api/import", { method: "POST", body: { url: "https://youtu.be/AsyncFail01", asynchronous: true } });
  const first = await submit();
  assert.equal(first.response.status, 202);
  const endpoint = "/api/import-jobs/" + first.data.jobId;
  await eventually(async () => (await api(endpoint)).data.status === "error");
  const failed = (await api(endpoint)).data;
  assert.equal(failed.code, "YOUTUBE_BLOCKED");
  assert.match(failed.error, /YouTube.*bloqueando/);
  assert.equal("detail" in failed, false);
  assert.equal("ownerId" in failed, false);
  const retry = await submit();
  assert.equal(retry.response.status, 202);
  assert.notEqual(retry.data.jobId, first.data.jobId);
  await eventually(async () => (await api("/api/import-jobs/" + retry.data.jobId)).data.status === "error");
});

test("async imports cap active jobs and release capacity after failure", async () => {
  assert.equal((await api("/api/lyrics/queue-capacity", { method: "POST" })).response.status, 202);
  const ids = [];
  for (let index = 0; index < 20; index++) {
    const row = await api("/api/import", { method: "POST", body: { url: "https://youtu.be/Capa" + String(index).padStart(7, "0"), asynchronous: true } });
    assert.equal(row.response.status, 202);
    ids.push(row.data.jobId);
  }
  const overflow = await api("/api/import", { method: "POST", body: { url: "https://youtu.be/Capa9999999", asynchronous: true } });
  assert.equal(overflow.response.status, 503);
  assert.equal(overflow.data.code, "MEDIA_BUSY");
  assert.equal((await api("/api/catalog/queue-capacity", { method: "DELETE" })).response.status, 200);
  await eventually(async () => (await api("/api/import-jobs/" + ids.at(-1))).data.status === "error", 10000);
  const retry = await api("/api/import", { method: "POST", body: { url: "https://youtu.be/Capa9999999", asynchronous: true } });
  assert.equal(retry.response.status, 202);
  await eventually(async () => (await api("/api/import-jobs/" + retry.data.jobId)).data.status === "error");
});

test("proxy outage fails promptly in both import APIs while existing songs remain usable", async () => {
  await new Promise((resolve) => proxyServer.close(resolve));
  const start = Date.now();
  const synchronous = await api("/api/import", { method: "POST", body: { url: "https://youtu.be/ProxyDown01" } });
  assert.equal(synchronous.response.status, 503);
  assert.equal(synchronous.data.code, "YOUTUBE_PROXY_UNAVAILABLE");
  const asynchronous = await api("/api/import", { method: "POST", body: { url: "https://youtu.be/ProxyDown02", asynchronous: true } });
  assert.equal(asynchronous.response.status, 202);
  const endpoint = "/api/import-jobs/" + asynchronous.data.jobId;
  await eventually(async () => (await api(endpoint)).data.status === "error");
  const failed = (await api(endpoint)).data;
  assert.equal(failed.code, "YOUTUBE_PROXY_UNAVAILABLE");
  assert.match(failed.error, /serviço de importação.*indisponível/);
  assert.ok(Date.now() - start < 3000);
  const existing = await api("/api/import", { method: "POST", body: { url: "https://youtu.be/AsyncKnown1", asynchronous: true } });
  assert.equal(existing.response.status, 409);
  assert.equal(existing.data.duplicate, true);
});
