import express from "express";
import multer from "multer";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createAuth, normalizePhone } from "./auth.mjs";
import { closeDatabase, ensureState, initializeDatabase, readState, stateHealth, writeState } from "./state-db.mjs";

const base = dirname(fileURLToPath(import.meta.url));
const python = join(base, ".venv", "bin", "python3.13");
const stemPython = join(base, ".stems-venv", "bin", "python3");
const separatorBin = join(base, ".stems-venv", "bin", "audio-separator");
const lyricsPython = join(base, ".lyrics-venv", "bin", "python3");
const detectKeyScript = join(base, "detect_key.py");
const transcribeLyricsScript = join(base, "transcribe_lyrics.py");
const dataDir = join(base, "data");
const audioDir = join(dataDir, "audio");
const stemsDir = join(dataDir, "stems");
const eventFilesDir = join(dataDir, "event-files");
const modelsDir = join(base, "models");
const catalogPath = join(dataDir, "catalog.json");
const workspacePath = join(dataDir, "workspace.json");
const authSecretPath = join(dataDir, "auth-secret.txt");

mkdirSync(audioDir, { recursive: true });
mkdirSync(stemsDir, { recursive: true });
mkdirSync(eventFilesDir, { recursive: true });
mkdirSync(modelsDir, { recursive: true });

const fallbackCatalog = existsSync(catalogPath)
  ? JSON.parse(readFileSync(catalogPath, "utf8"))
  : [];
const fallbackWorkspace = existsSync(workspacePath)
  ? JSON.parse(readFileSync(workspacePath, "utf8"))
  : {
      members: [{ id: "master", name: "Conta Master", role: "master", functions: ["Gestor"], active: true }],
      teams: [],
      events: [],
      profiles: { master: { folders: [], library: [], playlists: [] } }
    };

await initializeDatabase();
await ensureState("catalog", fallbackCatalog);
await ensureState("workspace", fallbackWorkspace);

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

const EVENT_FILE_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".png", ".jpg", ".jpeg", ".webp", ".mp3", ".wav", ".m4a",
  ".aac", ".zip", ".txt"
]);

function cleanOriginalName(value) {
  const name = basename(String(value || "arquivo"));
  try {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    return decoded.includes("�") ? name : decoded;
  } catch {
    return name;
  }
}

const eventFileStorage = multer.diskStorage({
  destination(req, _file, callback) {
    const eventId = String(req.params.id || "").replace(/[^a-zA-Z0-9_-]/g, "");
    if (!eventId) return callback(new Error("Evento inválido."));
    const directory = join(eventFilesDir, eventId);
    mkdirSync(directory, { recursive: true });
    callback(null, directory);
  },
  filename(_req, file, callback) {
    const extension = extname(file.originalname || "").toLowerCase();
    callback(null, randomUUID() + (EVENT_FILE_EXTENSIONS.has(extension) ? extension : ""));
  }
});

const uploadEventFiles = multer({
  storage: eventFileStorage,
  limits: { fileSize: 50 * 1024 * 1024, files: 5 },
  fileFilter(_req, file, callback) {
    const extension = extname(file.originalname || "").toLowerCase();
    if (!EVENT_FILE_EXTENSIONS.has(extension)) return callback(new Error("Tipo de arquivo não permitido."));
    callback(null, true);
  }
}).array("files", 5);

function removeUploadedFiles(files = []) {
  for (const file of files) {
    if (file?.path && existsSync(file.path)) rmSync(file.path, { force: true });
  }
}

let writeQueue = Promise.resolve();
app.use(async (req, res, next) => {
  if (!new Set(["POST", "PUT", "PATCH", "DELETE"]).has(req.method)) return next();
  let release;
  const previous = writeQueue;
  writeQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  let released = false;
  const unlock = () => {
    if (released) return;
    released = true;
    release();
  };
  res.once("finish", unlock);
  res.once("close", unlock);
  next();
});

const readCatalog = () => readState("catalog");
const saveCatalog = (rows) => writeState("catalog", rows);
function defaultProfile() {
  return { folders: [], library: [], playlists: [] };
}

const MODULE_KINDS = new Set(["participants", "confirmations", "repertoire", "vocal-arrangement", "chat", "files"]);

function clampParts(value, fallback = 3) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(8, Math.round(number))) : fallback;
}

function normalizeModules(modules) {
  if (!Array.isArray(modules)) return [];
  return modules
    .filter((module) => module && MODULE_KINDS.has(module.kind))
    .map((module, index) => ({
      id: String(module.id || randomUUID()),
      kind: module.kind,
      title: String(module.title || "").trim() || module.kind,
      order: Number.isFinite(Number(module.order)) ? Number(module.order) : index
    }))
    .sort((a, b) => a.order - b.order)
    .map((module, index) => ({ ...module, order: index }));
}

function normalizeWorkspace(workspace) {
  workspace.members = Array.isArray(workspace.members) ? workspace.members : [];
  workspace.profiles = workspace.profiles && typeof workspace.profiles === "object" ? workspace.profiles : {};

  const legacyGroups = Array.isArray(workspace.eventGroups) ? workspace.eventGroups : [];
  workspace.teams = Array.isArray(workspace.teams) ? workspace.teams : legacyGroups.map((group) => ({
    id: group.id, name: group.name, description: group.description || "", color: "#d8ff55", emoji: "🎵",
    memberIds: Array.isArray(group.memberIds) ? group.memberIds : [],
    vocalConfig: { highParts: 3, lowParts: 3 }, archived: false, createdAt: group.createdAt || new Date().toISOString()
  }));
  workspace.teams = workspace.teams.map((team) => ({
    ...team, memberIds: Array.isArray(team.memberIds) ? team.memberIds : [],
    vocalConfig: { highParts: clampParts(team.vocalConfig?.highParts), lowParts: clampParts(team.vocalConfig?.lowParts) },
    archived: Boolean(team.archived)
  }));

  workspace.events = Array.isArray(workspace.events) ? workspace.events : [];
  workspace.events = workspace.events.map((event) => {
    const participants = Array.isArray(event.participants) ? event.participants : (Array.isArray(event.assignments) ? event.assignments : []);
    const modules = Array.isArray(event.modules) ? normalizeModules(event.modules) : normalizeModules([
      { kind: "participants", title: "Participantes", order: 0 },
      { kind: "confirmations", title: "Confirmações", order: 1 },
      { kind: "repertoire", title: "Repertório", order: 2 },
      { kind: "vocal-arrangement", title: "Arranjo vocal", order: 3 },
      { kind: "chat", title: "Conversas", order: 4 }
    ]);
    return {
      ...event, teamId: event.teamId || event.groupId || "", modules, participants,
      vocalConfig: { highParts: clampParts(event.vocalConfig?.highParts), lowParts: clampParts(event.vocalConfig?.lowParts) },
      songs: (Array.isArray(event.songs) ? event.songs : []).map((song) => ({
        ...song, ministerId: song.ministerId || song.submittedBy,
        vocalAssignments: Array.isArray(song.vocalAssignments) ? song.vocalAssignments : []
      })),
      messages: Array.isArray(event.messages) ? event.messages : [],
      attachments: Array.isArray(event.attachments) ? event.attachments : [],
      archived: Boolean(event.archived)
    };
  });

  for (const member of workspace.members) {
    member.phoneNormalized = normalizePhone(member.phoneNormalized || member.phone);
    member.authVersion = Number(member.authVersion || 1);
    if (!workspace.profiles[member.id]) workspace.profiles[member.id] = defaultProfile();
  }
  delete workspace.eventGroups;
  return workspace;
}

const readWorkspace = async () => normalizeWorkspace(await readState("workspace"));
const saveWorkspace = async (workspace) => writeState("workspace", normalizeWorkspace(workspace));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => out += d.toString());
    child.stderr.on("data", (d) => err += d.toString());
    child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(err || "Processo terminou com código " + code)));
  });
}

async function detectKey(audioPath) {
  const raw = await run(stemPython, [detectKeyScript, audioPath]);
  return JSON.parse(raw);
}

const stemJobs = new Map();
const lyricsJobs = new Map();
const STEM_NAMES = ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Other"];

function collectStems(songId) {
  const dir = join(stemsDir, songId);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".mp3"));
  const stems = {};
  for (const stem of STEM_NAMES) {
    const file = files.find((name) => name.includes("_(" + stem + ")_"));
    if (file) stems[stem.toLowerCase()] = "/stems/" + songId + "/" + encodeURIComponent(file);
  }
  return Object.keys(stems).length >= 6 ? stems : null;
}

async function updateSong(songId, patch) {
  const catalog = await readCatalog();
  const index = catalog.findIndex((item) => item.id === songId);
  if (index < 0) return null;
  catalog[index] = Object.assign({}, catalog[index], patch);
  await saveCatalog(catalog);
  return catalog[index];
}

const isMaster = (workspace, actorId) => workspace.members.some((member) => member.id === actorId && member.role === "master" && member.active !== false);
const findEvent = (workspace, eventId) => workspace.events.find((event) => event.id === eventId);

function lyricsLooksBad(result) {
  const text = String(result?.text || "").toLowerCase();
  const words = text.replace(/[^a-zà-ÿ0-9\s]/gi, " ").split(/\s+/).filter(Boolean);
  if (words.length < 4) return true;
  const uniqueRatio = new Set(words).size / Math.max(1, words.length);
  const promptLeak = words.filter((word) => word === "transcribe" || word === "worship").length;
  return uniqueRatio < 0.18 || promptLeak > 3;
}

const auth = createAuth({ readWorkspace, saveWorkspace, secretPath: authSecretPath });
auth.registerRoutes(app);

app.get("/api/health", async (_req, res) => res.json({ ok: true, database: await stateHealth() }));
app.use("/audio", auth.requireAuth, express.static(audioDir, { maxAge: "7d" }));
app.use("/stems", auth.requireAuth, express.static(stemsDir, { maxAge: "30d" }));
app.use("/api", auth.requireAuth);

app.get("/api/workspace", async (req, res) => {
  const workspace = await readWorkspace();
  const memberId = req.auth.memberId;
  res.json({
    ...workspace,
    members: workspace.members.map(auth.safeMember),
    profiles: { [memberId]: workspace.profiles[memberId] || defaultProfile() }
  });
});

app.get("/api/profile/:memberId", async (req, res) => {
  const workspace = await readWorkspace();
  const memberId = req.params.memberId;
  if (req.auth.memberId !== memberId && !isMaster(workspace, req.auth.memberId)) {
    return res.status(403).json({ error: "Você só pode acessar sua própria biblioteca." });
  }
  const member = workspace.members.find((item) => item.id === memberId);
  if (!member) return res.status(404).json({ error: "Membro não encontrado." });
  res.json(workspace.profiles[member.id] || defaultProfile());
});

app.put("/api/profile/:memberId", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const memberId = req.params.memberId;
  if (actorId !== memberId && !isMaster(workspace, actorId)) {
    return res.status(403).json({ error: "Você só pode alterar sua própria biblioteca." });
  }
  if (!workspace.members.some((item) => item.id === memberId)) {
    return res.status(404).json({ error: "Membro não encontrado." });
  }
  const incoming = req.body?.profile || {};
  const profile = {
    folders: Array.isArray(incoming.folders) ? incoming.folders : [],
    library: Array.isArray(incoming.library) ? incoming.library : [],
    playlists: Array.isArray(incoming.playlists) ? incoming.playlists : []
  };
  workspace.profiles[memberId] = profile;
  await saveWorkspace(workspace);
  res.json(profile);
});

function validMemberIds(workspace, values) {
  return (Array.isArray(values) ? values : [])
    .map(String)
    .filter((id, index, rows) => rows.indexOf(id) === index)
    .filter((id) => workspace.members.some((member) => member.id === id && member.active !== false));
}

function isVocalMember(member) {
  return Boolean(member && /vocal|voz|louvor|worship|cantor|cantora/i.test((member.functions || []).join(" ")));
}

function canAccessEvent(workspace, event, actorId) {
  return isMaster(workspace, actorId) || event.participants.some((item) => item.memberId === actorId);
}

function eventHasModule(event, kind) {
  return event.modules.some((module) => module.kind === kind);
}

app.post("/api/teams", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode criar equipes." });
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Informe o nome da equipe." });
  const team = {
    id: randomUUID(),
    name,
    description: String(req.body?.description || "").trim(),
    color: String(req.body?.color || "#d8ff55"),
    emoji: String(req.body?.emoji || "🎵").slice(0, 8),
    memberIds: validMemberIds(workspace, req.body?.memberIds),
    vocalConfig: {
      highParts: clampParts(req.body?.vocalConfig?.highParts),
      lowParts: clampParts(req.body?.vocalConfig?.lowParts)
    },
    archived: false,
    createdAt: new Date().toISOString()
  };
  workspace.teams.push(team);
  await saveWorkspace(workspace);
  res.status(201).json(team);
});

app.patch("/api/teams/:id", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode editar equipes." });
  const team = workspace.teams.find((item) => item.id === req.params.id);
  if (!team) return res.status(404).json({ error: "Equipe não encontrada." });
  for (const field of ["name", "description", "color", "emoji"]) {
    if (typeof req.body?.[field] === "string") team[field] = req.body[field].trim();
  }
  if (Array.isArray(req.body?.memberIds)) team.memberIds = validMemberIds(workspace, req.body.memberIds);
  if (req.body?.vocalConfig) {
    team.vocalConfig = {
      highParts: clampParts(req.body.vocalConfig.highParts, team.vocalConfig?.highParts ?? 3),
      lowParts: clampParts(req.body.vocalConfig.lowParts, team.vocalConfig?.lowParts ?? 3)
    };
  }
  if (typeof req.body?.archived === "boolean") team.archived = req.body.archived;
  await saveWorkspace(workspace);
  res.json(team);
});

app.delete("/api/teams/:id", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode excluir equipes." });
  const before = workspace.teams.length;
  workspace.teams = workspace.teams.filter((team) => team.id !== req.params.id);
  if (before === workspace.teams.length) return res.status(404).json({ error: "Equipe não encontrada." });
  for (const event of workspace.events) if (event.teamId === req.params.id) event.teamId = "";
  await saveWorkspace(workspace);
  res.json({ ok: true });
});

app.post("/api/members", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode cadastrar músicos." });
  const name = String(req.body?.name || "").trim();
  const phone = normalizePhone(req.body?.phone);
  if (!name) return res.status(400).json({ error: "Informe o nome do músico." });
  if (phone.length !== 10 && phone.length !== 11) return res.status(400).json({ error: "Informe um celular válido com DDD." });
  if (workspace.members.some((item) => item.active !== false && normalizePhone(item.phoneNormalized || item.phone) === phone)) {
    return res.status(409).json({ error: "Este celular já está vinculado a outra conta." });
  }
  const register = ["high", "low", "flex"].includes(req.body?.vocalRegister) ? req.body.vocalRegister : undefined;
  const member = {
    id: randomUUID(),
    name,
    email: String(req.body?.email || "").trim(),
    phone,
    phoneNormalized: phone,
    authVersion: 1,
    role: "member",
    functions: Array.isArray(req.body?.functions) ? req.body.functions.map(String).map((item) => item.trim()).filter(Boolean) : [],
    vocalRegister: register,
    active: true
  };
  workspace.members.push(member);
  workspace.profiles[member.id] = defaultProfile();
  await saveWorkspace(workspace);
  res.status(201).json(auth.safeMember(member));
});

app.patch("/api/members/:id", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode editar músicos." });
  const member = workspace.members.find((item) => item.id === req.params.id);
  if (!member) return res.status(404).json({ error: "Músico não encontrado." });
  for (const field of ["name", "email"]) {
    if (typeof req.body?.[field] === "string") member[field] = req.body[field].trim();
  }
  if (typeof req.body?.phone === "string") {
    const phone = normalizePhone(req.body.phone);
    if (phone.length !== 10 && phone.length !== 11) return res.status(400).json({ error: "Informe um celular válido com DDD." });
    if (workspace.members.some((item) => item.id !== member.id && item.active !== false && normalizePhone(item.phoneNormalized || item.phone) === phone)) {
      return res.status(409).json({ error: "Este celular já está vinculado a outra conta." });
    }
    member.phone = phone;
    member.phoneNormalized = phone;
  }
  if (Array.isArray(req.body?.functions)) member.functions = req.body.functions.map(String).map((item) => item.trim()).filter(Boolean);
  if (["high", "low", "flex"].includes(req.body?.vocalRegister)) member.vocalRegister = req.body.vocalRegister;
  if (req.body?.vocalRegister === "") delete member.vocalRegister;
  if (typeof req.body?.active === "boolean") member.active = req.body.active;
  await saveWorkspace(workspace);
  res.json(auth.safeMember(member));
});

app.delete("/api/members/:id", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode excluir músicos." });
  const member = workspace.members.find((item) => item.id === req.params.id);
  if (!member) return res.status(404).json({ error: "Músico não encontrado." });
  if (member.role === "master") return res.status(400).json({ error: "A conta master não pode ser excluída." });
  workspace.members = workspace.members.filter((item) => item.id !== req.params.id);
  delete workspace.profiles[req.params.id];
  for (const team of workspace.teams) team.memberIds = team.memberIds.filter((id) => id !== req.params.id);
  for (const event of workspace.events) {
    event.participants = event.participants.filter((item) => item.memberId !== req.params.id);
    event.messages = event.messages.filter((item) => item.authorId !== req.params.id);
    for (const song of event.songs) {
      song.taggedMemberIds = (song.taggedMemberIds || []).filter((id) => id !== req.params.id);
      song.vocalAssignments = (song.vocalAssignments || []).filter((item) => item.memberId !== req.params.id);
    }
  }
  await saveWorkspace(workspace);
  res.json({ ok: true });
});

app.post("/api/events", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode criar eventos." });
  const title = String(req.body?.title || "").trim();
  if (!title) return res.status(400).json({ error: "Informe o nome do evento." });
  const teamId = String(req.body?.teamId || "");
  const team = workspace.teams.find((item) => item.id === teamId && !item.archived);
  const participants = (Array.isArray(req.body?.participants) ? req.body.participants : [])
    .filter((item) => workspace.members.some((member) => member.id === item.memberId && member.active !== false))
    .map((item) => ({ memberId: String(item.memberId), function: String(item.function || "Equipe"), status: "pending" }));
  const event = {
    id: randomUUID(),
    title,
    date: String(req.body?.date || ""),
    time: String(req.body?.time || ""),
    location: String(req.body?.location || "").trim(),
    description: String(req.body?.description || "").trim(),
    color: String(req.body?.color || team?.color || "#d8ff55"),
    emoji: String(req.body?.emoji || team?.emoji || "✦").slice(0, 8),
    teamId: team?.id || "",
    vocalConfig: {
      highParts: clampParts(req.body?.vocalConfig?.highParts, team?.vocalConfig?.highParts ?? 3),
      lowParts: clampParts(req.body?.vocalConfig?.lowParts, team?.vocalConfig?.lowParts ?? 3)
    },
    createdBy: actorId,
    modules: normalizeModules(req.body?.modules),
    participants,
    songs: [],
    messages: [],
    attachments: [],
    archived: false,
    createdAt: new Date().toISOString()
  };
  workspace.events.push(event);
  await saveWorkspace(workspace);
  res.status(201).json(event);
});

app.patch("/api/events/:id", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode editar eventos." });
  const event = findEvent(workspace, req.params.id);
  if (!event) return res.status(404).json({ error: "Evento não encontrado." });
  for (const field of ["title", "date", "time", "location", "description", "color", "emoji", "teamId"]) {
    if (typeof req.body?.[field] === "string") event[field] = req.body[field].trim();
  }
  if (Array.isArray(req.body?.modules)) event.modules = normalizeModules(req.body.modules);
  if (req.body?.vocalConfig) {
    event.vocalConfig = {
      highParts: clampParts(req.body.vocalConfig.highParts, event.vocalConfig?.highParts ?? 3),
      lowParts: clampParts(req.body.vocalConfig.lowParts, event.vocalConfig?.lowParts ?? 3)
    };
  }
  if (Array.isArray(req.body?.participants)) {
    const previous = new Map(event.participants.map((item) => [item.memberId, item.status]));
    event.participants = req.body.participants
      .filter((item) => workspace.members.some((member) => member.id === item.memberId && member.active !== false))
      .map((item) => ({
        memberId: String(item.memberId),
        function: String(item.function || "Equipe"),
        status: previous.get(item.memberId) || "pending"
      }));
  }
  if (typeof req.body?.archived === "boolean") event.archived = req.body.archived;
  await saveWorkspace(workspace);
  res.json(event);
});

app.post("/api/events/:id/duplicate", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode duplicar eventos." });
  const source = findEvent(workspace, req.params.id);
  if (!source) return res.status(404).json({ error: "Evento não encontrado." });
  const copy = JSON.parse(JSON.stringify(source));
  copy.id = randomUUID();
  copy.title = String(req.body?.title || source.title + " · cópia");
  copy.date = String(req.body?.date || "");
  copy.createdBy = actorId;
  copy.createdAt = new Date().toISOString();
  copy.archived = false;
  copy.participants = copy.participants.map((item) => ({ ...item, status: "pending" }));
  copy.songs = copy.songs.map((song) => ({ ...song, id: randomUUID(), comments: [], vocalAssignments: [] }));
  copy.messages = [];
  copy.attachments = [];
  workspace.events.push(copy);
  await saveWorkspace(workspace);
  res.status(201).json(copy);
});

app.delete("/api/events/:id", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode excluir eventos." });
  const removed = findEvent(workspace, req.params.id);
  if (!removed) return res.status(404).json({ error: "Evento não encontrado." });
  workspace.events = workspace.events.filter((event) => event.id !== req.params.id);
  await saveWorkspace(workspace);
  const directory = join(eventFilesDir, removed.id);
  if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  res.json({ ok: true });
});

app.post("/api/events/:id/attendance", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const memberId = String(req.body?.memberId || actorId);
  const event = findEvent(workspace, req.params.id);
  if (!event) return res.status(404).json({ error: "Evento não encontrado." });
  if (actorId !== memberId && !isMaster(workspace, actorId)) return res.status(403).json({ error: "Você só pode responder por sua própria presença." });
  const participant = event.participants.find((item) => item.memberId === memberId);
  if (!participant) return res.status(404).json({ error: "Membro não participa deste evento." });
  participant.status = ["pending", "confirmed", "unavailable"].includes(req.body?.status) ? req.body.status : "pending";
  await saveWorkspace(workspace);
  res.json(event);
});

app.post("/api/events/:id/messages", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const event = findEvent(workspace, req.params.id);
  if (!event) return res.status(404).json({ error: "Evento não encontrado." });
  if (!canAccessEvent(workspace, event, actorId)) return res.status(403).json({ error: "Você não participa deste evento." });
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Escreva uma mensagem." });
  const message = { id: randomUUID(), authorId: actorId, text, createdAt: new Date().toISOString() };
  event.messages.push(message);
  await saveWorkspace(workspace);
  res.status(201).json(message);
});

app.post("/api/events/:id/attachments", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const event = findEvent(workspace, req.params.id);
  if (!event) return res.status(404).json({ error: "Evento não encontrado." });
  if (!canAccessEvent(workspace, event, actorId)) return res.status(403).json({ error: "Você não participa deste evento." });

  uploadEventFiles(req, res, async (uploadError) => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (uploadError) {
      removeUploadedFiles(files);
      const tooLarge = uploadError instanceof multer.MulterError && uploadError.code === "LIMIT_FILE_SIZE";
      const tooMany = uploadError instanceof multer.MulterError && uploadError.code === "LIMIT_FILE_COUNT";
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? "Cada arquivo pode ter no máximo 50 MB." : tooMany ? "Envie no máximo 5 arquivos por vez." : uploadError.message
      });
    }
    if (!files.length) return res.status(400).json({ error: "Selecione pelo menos um arquivo." });

    try {
      const createdAt = new Date().toISOString();
      const attachments = files.map((file) => {
        const originalName = cleanOriginalName(file.originalname);
        return {
          id: randomUUID(),
          title: originalName,
          originalName,
          storedName: file.filename,
          mimeType: file.mimetype || "application/octet-stream",
          size: Number(file.size || 0),
          authorId: actorId,
          createdAt
        };
      });
      event.attachments.push(...attachments);
      await saveWorkspace(workspace);
      res.status(201).json({ attachments });
    } catch (error) {
      removeUploadedFiles(files);
      console.error("Falha ao salvar anexos", error);
      res.status(500).json({ error: "Não foi possível concluir o upload." });
    }
  });
});

app.get("/api/events/:eventId/attachments/:attachmentId/file", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const event = findEvent(workspace, req.params.eventId);
  if (!event) return res.status(404).json({ error: "Evento não encontrado." });
  if (!canAccessEvent(workspace, event, actorId)) return res.status(403).json({ error: "Você não participa deste evento." });
  const attachment = event.attachments.find((item) => item.id === req.params.attachmentId);
  if (!attachment) return res.status(404).json({ error: "Arquivo não encontrado." });
  if (!attachment.storedName && attachment.url) return res.redirect(attachment.url);

  const storedName = basename(String(attachment.storedName || ""));
  if (!storedName || storedName !== attachment.storedName) return res.status(400).json({ error: "Arquivo inválido." });
  const filePath = join(eventFilesDir, event.id, storedName);
  if (!existsSync(filePath)) return res.status(404).json({ error: "O arquivo não está mais disponível." });
  const displayName = attachment.originalName || attachment.title || storedName;
  if (req.query.download === "1") return res.download(filePath, displayName);
  res.setHeader("Content-Type", attachment.mimeType || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(displayName)}`);
  res.sendFile(filePath);
});

app.delete("/api/events/:eventId/attachments/:attachmentId", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const event = findEvent(workspace, req.params.eventId);
  if (!event) return res.status(404).json({ error: "Evento não encontrado." });
  const attachment = event.attachments.find((item) => item.id === req.params.attachmentId);
  if (!attachment) return res.status(404).json({ error: "Arquivo não encontrado." });
  if (!isMaster(workspace, actorId) && attachment.authorId !== actorId) return res.status(403).json({ error: "Você não pode remover este arquivo." });
  event.attachments = event.attachments.filter((item) => item.id !== req.params.attachmentId);
  await saveWorkspace(workspace);
  if (attachment.storedName) {
    const filePath = join(eventFilesDir, event.id, basename(attachment.storedName));
    if (existsSync(filePath)) rmSync(filePath, { force: true });
  }
  res.json({ ok: true });
});

app.post("/api/events/:id/songs", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const event = findEvent(workspace, req.params.id);
  if (!event) return res.status(404).json({ error: "Evento não encontrado." });
  if (!eventHasModule(event, "repertoire")) return res.status(400).json({ error: "Este evento não possui o bloco de repertório." });
  const actor = workspace.members.find((member) => member.id === actorId);
  const participant = event.participants.find((item) => item.memberId === actorId);
  if (!isMaster(workspace, actorId) && (!participant || !isVocalMember(actor))) {
    return res.status(403).json({ error: "Somente vocais participantes ou a conta master podem enviar músicas." });
  }
  const songId = String(req.body?.songId || "");
  const catalog = await readCatalog();
  if (!catalog.some((song) => song.id === songId)) return res.status(404).json({ error: "Música não encontrada no catálogo." });
  let ministerId = isMaster(workspace, actorId) ? String(req.body?.ministerId || actorId) : actorId;
  const minister = workspace.members.find((member) => member.id === ministerId);
  if (!isMaster(workspace, ministerId) && (!event.participants.some((item) => item.memberId === ministerId) || !isVocalMember(minister))) {
    ministerId = actorId;
  }
  const eventSong = {
    id: randomUUID(), songId, submittedBy: actorId, ministerId,
    key: String(req.body?.key || "").trim(),
    description: String(req.body?.description || "").trim(),
    message: String(req.body?.message || "").trim(),
    taggedMemberIds: validMemberIds(workspace, req.body?.taggedMemberIds).filter((id) => event.participants.some((item) => item.memberId === id)),
    vocalAssignments: [], comments: [], order: event.songs.length + 1,
    createdAt: new Date().toISOString()
  };
  event.songs.push(eventSong);
  await saveWorkspace(workspace);
  res.status(201).json(eventSong);
});

app.patch("/api/events/:eventId/songs/:itemId", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const event = findEvent(workspace, req.params.eventId);
  if (!event) return res.status(404).json({ error: "Evento não encontrado." });
  const item = event.songs.find((song) => song.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: "Música não encontrada no evento." });
  if (!isMaster(workspace, actorId) && item.ministerId !== actorId) return res.status(403).json({ error: "Somente o ministrante desta música pode editá-la." });
  for (const field of ["key", "description", "message"]) if (typeof req.body?.[field] === "string") item[field] = req.body[field].trim();
  if (isMaster(workspace, actorId) && typeof req.body?.ministerId === "string") item.ministerId = req.body.ministerId;
  if (Array.isArray(req.body?.taggedMemberIds)) item.taggedMemberIds = validMemberIds(workspace, req.body.taggedMemberIds).filter((id) => event.participants.some((entry) => entry.memberId === id));
  await saveWorkspace(workspace);
  res.json(item);
});

app.post("/api/events/:eventId/songs/:itemId/vocal-part", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const event = findEvent(workspace, req.params.eventId);
  if (!event) return res.status(404).json({ error: "Evento não encontrado." });
  const song = event.songs.find((item) => item.id === req.params.itemId);
  if (!song) return res.status(404).json({ error: "Música não encontrada no evento." });
  const memberId = isMaster(workspace, actorId) && req.body?.memberId ? String(req.body.memberId) : actorId;
  const member = workspace.members.find((item) => item.id === memberId);
  if (!event.participants.some((item) => item.memberId === memberId) || !isVocalMember(member)) return res.status(403).json({ error: "A divisão vocal só pode ser escolhida por vocais participantes." });
  if (song.ministerId === memberId) return res.status(400).json({ error: "O ministrante já ocupa a voz principal." });
  song.vocalAssignments = (song.vocalAssignments || []).filter((item) => item.memberId !== memberId);
  if (req.body?.register === "high" || req.body?.register === "low") {
    const limit = req.body.register === "high" ? event.vocalConfig.highParts : event.vocalConfig.lowParts;
    const part = Math.round(Number(req.body?.part));
    if (part < 1 || part > limit) return res.status(400).json({ error: "Divisão vocal inválida." });
    song.vocalAssignments.push({ memberId, register: req.body.register, part, updatedAt: new Date().toISOString() });
  }
  await saveWorkspace(workspace);
  res.json(song);
});

app.post("/api/events/:eventId/songs/reorder", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const event = findEvent(workspace, req.params.eventId);
  if (!event) return res.status(404).json({ error: "Evento não encontrado." });
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode reorganizar o repertório." });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  event.songs.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  event.songs.forEach((song, index) => song.order = index + 1);
  await saveWorkspace(workspace);
  res.json(event.songs);
});

app.delete("/api/events/:eventId/songs/:itemId", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const event = findEvent(workspace, req.params.eventId);
  if (!event) return res.status(404).json({ error: "Evento não encontrado." });
  const item = event.songs.find((song) => song.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: "Música não encontrada no evento." });
  if (!isMaster(workspace, actorId) && item.ministerId !== actorId) return res.status(403).json({ error: "Você não pode remover esta música." });
  event.songs = event.songs.filter((song) => song.id !== req.params.itemId);
  event.songs.forEach((song, index) => song.order = index + 1);
  await saveWorkspace(workspace);
  res.json({ ok: true });
});

app.post("/api/events/:eventId/songs/:itemId/comments", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const event = findEvent(workspace, req.params.eventId);
  if (!event) return res.status(404).json({ error: "Evento não encontrado." });
  if (!canAccessEvent(workspace, event, actorId)) return res.status(403).json({ error: "Você não participa deste evento." });
  const item = event.songs.find((song) => song.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: "Música não encontrada no evento." });
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Escreva uma mensagem." });
  const comment = { id: randomUUID(), authorId: actorId, text, taggedMemberIds: [], createdAt: new Date().toISOString() };
  item.comments = Array.isArray(item.comments) ? item.comments : [];
  item.comments.push(comment);
  await saveWorkspace(workspace);
  res.status(201).json(comment);
});

app.get("/api/catalog", async (_req, res) => res.json(await readCatalog()));

app.patch("/api/catalog/:id", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode editar dados globais da música." });
  const catalog = await readCatalog();
  const index = catalog.findIndex((item) => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: "Música não encontrada." });
  const allowed = ["originalKey", "title", "artist"];
  for (const key of allowed) {
    if (typeof req.body?.[key] === "string") catalog[index][key] = req.body[key].trim();
  }
  if (typeof req.body?.originalKey === "string") {
    catalog[index].keySource = "manual";
    catalog[index].keyConfidence = 100;
  }
  await saveCatalog(catalog);
  res.json(catalog[index]);
});

app.delete("/api/catalog/:id", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode excluir músicas definitivamente." });

  const catalog = await readCatalog();
  const song = catalog.find((item) => item.id === req.params.id);
  if (!song) return res.status(404).json({ error: "Música não encontrada." });

  await saveCatalog(catalog.filter((item) => item.id !== req.params.id));

  const audioPath = join(audioDir, req.params.id + ".mp3");
  const songStemsDir = join(stemsDir, req.params.id);
  if (existsSync(audioPath)) rmSync(audioPath, { force: true });
  if (existsSync(songStemsDir)) rmSync(songStemsDir, { recursive: true, force: true });

  for (const event of workspace.events) {
    event.songs = event.songs.filter((item) => item.songId !== req.params.id);
    event.songs.forEach((item, index) => item.order = index + 1);
  }
  for (const profile of Object.values(workspace.profiles)) {
    profile.library = (profile.library || []).filter((item) => item.songId !== req.params.id);
    profile.playlists = (profile.playlists || []).map((playlist) => ({
      ...playlist,
      songIds: (playlist.songIds || []).filter((songId) => songId !== req.params.id)
    }));
  }
  await saveWorkspace(workspace);
  res.json({ ok: true });
});

app.post("/api/detect-key/:songId", async (req, res) => {
  const songId = req.params.songId;
  const input = join(audioDir, songId + ".mp3");
  if (!existsSync(input)) return res.status(400).json({ error: "Áudio original não encontrado." });
  try {
    const keyData = await detectKey(input);
    const updated = await updateSong(songId, {
      originalKey: keyData.key,
      keyMode: keyData.mode,
      keyConfidence: Number(keyData.confidence || 0),
      keySource: "detected"
    });
    if (!updated) return res.status(404).json({ error: "Música não encontrada." });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: "Não consegui detectar o tom.", detail: String(error?.message || error).slice(0, 500) });
  }
});

app.post("/api/import", async (req, res) => {
  const url = String(req.body && req.body.url || "").trim();
  if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url)) {
    return res.status(400).json({ error: "Cole um link válido do YouTube." });
  }

  try {
    const raw = await run(python, ["-m", "yt_dlp", "--no-playlist", "--dump-single-json", url]);
    const meta = JSON.parse(raw);
    const id = String(meta.id);
    const catalog = await readCatalog();
    const existing = catalog.find((item) => item.id === id);
    if (existing) {
      return res.status(409).json({
        error: "Essa versão da música já existe na plataforma.",
        duplicate: true,
        song: existing
      });
    }
    const output = join(audioDir, id + ".mp3");

    if (!existsSync(output)) {
      await run(python, [
        "-m", "yt_dlp", "--no-playlist", "-x",
        "--audio-format", "mp3",
        "--audio-quality", "192K",
        "-o", join(audioDir, id + ".%(ext)s"),
        url
      ]);
    }

    let keyData = null;
    try { keyData = await detectKey(output); }
    catch (keyError) { console.warn("Falha ao detectar tom:", keyError?.message || keyError); }

    const song = {
      id,
      title: meta.title || "Sem título",
      artist: meta.artist || meta.uploader || meta.channel || "YouTube",
      originalKey: keyData?.key || "C",
      keyMode: keyData?.mode || "major",
      keyConfidence: Number(keyData?.confidence || 0),
      keySource: "detected",
      duration: Number(meta.duration || 0),
      cover: meta.thumbnail || "",
      youtubeUrl: url,
      audioUrl: "/audio/" + id + ".mp3",
      source: "youtube",
      addedBy: req.auth.memberId,
      stems: collectStems(id) || undefined,
      uses: 0
    };

    catalog.unshift(song);
    await saveCatalog(catalog);
    res.status(201).json(song);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Não consegui importar esse vídeo agora.",
      detail: String(error && error.message || error).slice(0, 700)
    });
  }
});

app.get("/api/lyrics/:songId", async (req, res) => {
  const songId = req.params.songId;
  const song = (await readCatalog()).find((item) => item.id === songId);
  if (!song) return res.status(404).json({ error: "Música não encontrada." });
  const job = lyricsJobs.get(songId);
  if (job?.status === "processing" || job?.status === "error") return res.json(job);
  if (Array.isArray(song.lyrics) && song.lyrics.length) {
    return res.json({ status: "ready", lyrics: song.lyrics, model: song.lyricsModel || "", source: song.lyricsSource || "" });
  }
  return res.json(job || { status: "idle" });
});

app.post("/api/lyrics/:songId", async (req, res) => {
  const songId = req.params.songId;
  const song = (await readCatalog()).find((item) => item.id === songId);
  if (!song) return res.status(404).json({ error: "Música não encontrada." });

  if (Array.isArray(song.lyrics) && song.lyrics.length && req.body?.force !== true) {
    return res.json({ status: "ready", lyrics: song.lyrics, model: song.lyricsModel || "" });
  }

  const current = lyricsJobs.get(songId);
  if (current?.status === "processing") return res.status(202).json(current);

  const stemFiles = collectStems(songId);
  let input = join(audioDir, songId + ".mp3");
  let source = "original";

  if (stemFiles?.vocals) {
    const vocalName = decodeURIComponent(stemFiles.vocals.split("/").pop());
    const vocalPath = join(stemsDir, songId, vocalName);
    if (existsSync(vocalPath)) {
      input = vocalPath;
      source = "vocals";
    }
  }

  if (!existsSync(input)) return res.status(400).json({ error: "Áudio não encontrado para transcrição." });

  const job = { status: "processing", source, startedAt: Date.now() };
  lyricsJobs.set(songId, job);
  if (req.body?.force === true) await updateSong(songId, { lyrics: [], lyricsModel: "", lyricsSource: "" });

  void (async () => {
    let finalSource = source;
    try {
      let raw = await run(lyricsPython, [transcribeLyricsScript, input]);
      let result = JSON.parse(raw.trim());

      if (finalSource === "vocals" && lyricsLooksBad(result)) {
        const originalPath = join(audioDir, songId + ".mp3");
        if (existsSync(originalPath)) {
          raw = await run(lyricsPython, [transcribeLyricsScript, originalPath]);
          result = JSON.parse(raw.trim());
          finalSource = "original";
        }
      }

      const lyrics = Array.isArray(result.lines) ? result.lines : [];
      if (!lyrics.length || lyricsLooksBad(result)) throw new Error("Transcrição com baixa confiança.");

      await updateSong(songId, { lyrics, lyricsModel: result.model || "", lyricsSource: finalSource });
      lyricsJobs.set(songId, { status: "ready", lyrics, model: result.model || "", source: finalSource });
    } catch (error) {
      lyricsJobs.set(songId, {
        status: "error",
        error: "Não consegui transcrever esta música com qualidade suficiente.",
        detail: String(error?.message || error).slice(-1200)
      });
    }
  })();

  res.status(202).json(job);
});

app.get("/api/stems/:songId", async (req, res) => {
  const songId = req.params.songId;
  const catalog = await readCatalog();
  const song = catalog.find((item) => item.id === songId);
  if (!song) return res.status(404).json({ error: "Música não encontrada." });
  const ready = song.stems || collectStems(songId);
  if (ready) {
    if (!song.stems) await updateSong(songId, { stems: ready });
    return res.json({ status: "ready", stems: ready });
  }
  const job = stemJobs.get(songId);
  return res.json(job || { status: "idle" });
});

app.post("/api/stems/:songId", async (req, res) => {
  const songId = req.params.songId;
  const catalog = await readCatalog();
  const song = catalog.find((item) => item.id === songId);
  if (!song) return res.status(404).json({ error: "Música não encontrada." });

  const ready = song.stems || collectStems(songId);
  if (ready) {
    if (!song.stems) await updateSong(songId, { stems: ready });
    return res.json({ status: "ready", stems: ready });
  }

  const current = stemJobs.get(songId);
  if (current?.status === "processing") return res.status(202).json(current);

  const input = join(audioDir, songId + ".mp3");
  if (!existsSync(input)) return res.status(400).json({ error: "Áudio original não encontrado." });

  const outputDir = join(stemsDir, songId);
  mkdirSync(outputDir, { recursive: true });
  const job = { status: "processing", progress: 0, startedAt: Date.now() };
  stemJobs.set(songId, job);

  const child = spawn(separatorBin, [
    "-m", "htdemucs_6s.yaml",
    "--output_format", "MP3",
    "--output_bitrate", "192k",
    "--output_dir", outputDir,
    "--model_file_dir", modelsDir,
    input
  ], { env: process.env });

  let log = "";
  const append = (chunk) => {
    log = (log + chunk.toString()).slice(-12000);
    const match = log.match(/(\d{1,3})%\|/g);
    if (match?.length) job.progress = Math.min(99, Number(match[match.length - 1].replace(/\D/g, "")) || 0);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("close", async (code) => {
    if (code === 0) {
      const stems = collectStems(songId);
      if (stems) {
        stemJobs.set(songId, { status: "ready", progress: 100, stems });
        await updateSong(songId, { stems });
        return;
      }
    }
    stemJobs.set(songId, { status: "error", progress: 0, error: "Falha ao separar instrumentos.", detail: log.slice(-1000) });
  });

  res.status(202).json(job);
});

app.use((error, _req, res, _next) => {
  console.error("LouveLab API error", error);
  if (res.headersSent) return;
  res.status(500).json({ error: "Ocorreu um erro interno. Tente novamente." });
});

const port = Number(process.env.PORT || 5174);
const server = app.listen(port, "127.0.0.1", () => console.log("LouveLab API em http://127.0.0.1:" + port));

async function shutdown(signal) {
  console.log(`Encerrando LouveLab (${signal})...`);
  server.close(async () => {
    await closeDatabase().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
