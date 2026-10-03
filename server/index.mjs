import express from "express";
import multer from "multer";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { copyFileSync, existsSync, readFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createAuth, normalizePhone } from "./auth.mjs";
import { checkYoutubeProxy, youtubeProxyError } from "./youtube-proxy.mjs";
import { createMp3Upload, hashMp3, prepareMp3 } from "./mp3-upload.mjs";
import {
  closeDatabase,
  createChurch,
  ensureDefaultChurch,
  ensureState,
  findChurchBySlug,
  getChurchById,
  getDefaultChurch,
  initializeDatabase,
  listChurches,
  readChurchState,
  stateHealth,
  writeChurchState,
} from "./state-db.mjs";
import { isLocalDevelopmentRequest, resolveChurch } from "./church-context.mjs";
import { billingSummary, normalizePlanId, normalizeSubscription, PLAN_DEFINITIONS, publicPlans } from "./plans.mjs";
import {
  approvedAuthorizedPayment,
  buildLouwyReference,
  mercadoPagoRequest,
  mercadoPagoSubscriptionStatus,
  parseLouwyReference,
  validBillingEmail,
  verifyMercadoPagoSignature,
} from "./mercadopago.mjs";

const base = dirname(fileURLToPath(import.meta.url));
const python = process.env.PYTHON_BIN || join(base, ".venv", "bin", "python3.13");
const stemPython = process.env.STEM_PYTHON_BIN || join(base, ".stems-venv", "bin", "python3");
const separatorBin = process.env.SEPARATOR_BIN || join(base, ".stems-venv", "bin", "audio-separator");
const lyricsPython = process.env.LYRICS_PYTHON_BIN || join(base, ".lyrics-venv", "bin", "python3");
const youtubeJsRuntime = process.env.YTDLP_JS_RUNTIME || "node:" + process.execPath;
const youtubeCookiesFile = String(process.env.YTDLP_COOKIES_FILE || "").trim();
const youtubeProxy = String(process.env.YTDLP_PROXY || "").trim();
const youtubeRemoteComponents = String(process.env.YTDLP_REMOTE_COMPONENTS || "ejs:github").trim();
const youtubeExtractorArgs = String(process.env.YTDLP_EXTRACTOR_ARGS || "").trim();
const youtubePotProviderUrl = String(process.env.YTDLP_POT_PROVIDER_URL || "").trim();
const detectKeyScript = join(base, "detect_key.py");
const transcribeLyricsScript = join(base, "transcribe_lyrics.py");
const dataDir = join(base, "data");
const youtubeCacheDir = process.env.YTDLP_CACHE_DIR || join(dataDir, "yt-dlp-cache");
const audioDir = join(dataDir, "audio");
const mp3UploadDir = join(dataDir, "mp3-uploads");
const uploadMp3 = createMp3Upload(mp3UploadDir);
const youtubeImportEnabled = process.env.ENABLE_YOUTUBE_IMPORT === "true";
const stemsDir = join(dataDir, "stems");
const eventFilesDir = join(dataDir, "event-files");
const brandingDir = join(dataDir, "branding");
const avatarsDir = join(dataDir, "avatars");
const modelsDir = join(base, "models");
const catalogPath = join(dataDir, "catalog.json");
const workspacePath = join(dataDir, "workspace.json");
const authSecretPath = join(dataDir, "auth-secret.txt");

const mercadoPagoAccessToken = String(process.env.MERCADO_PAGO_PLATFORM_ACCESS_TOKEN || "").trim();
const mercadoPagoWebhookSecret = String(process.env.MERCADO_PAGO_SAAS_WEBHOOK_SECRET || "").trim();
const mercadoPagoWebhookUrl = String(
  process.env.MERCADO_PAGO_WEBHOOK_URL || "https://louwy.com.br/api/mercadopago/webhook",
).trim();


mkdirSync(audioDir, { recursive: true });
mkdirSync(stemsDir, { recursive: true });
mkdirSync(eventFilesDir, { recursive: true });
mkdirSync(brandingDir, { recursive: true });
mkdirSync(avatarsDir, { recursive: true });
mkdirSync(modelsDir, { recursive: true });
mkdirSync(youtubeCacheDir, { recursive: true });

const fallbackCatalog = existsSync(catalogPath)
  ? JSON.parse(readFileSync(catalogPath, "utf8"))
  : [];
const fallbackWorkspace = existsSync(workspacePath)
  ? JSON.parse(readFileSync(workspacePath, "utf8"))
  : {
      branding: {
        productName: "Louwy",
        organizationName: "Ministério Primícias",
        logoUrl: "/branding/primicias-logo.png",
        accentColor: "#d8ff55"
      },
      members: [{ id: "master", name: "Conta Master", role: "master", functions: ["Gestor"], active: true }],
      teams: [],
      events: [],
      notifications: [],
      subscription: { planId: "free", status: "active", requestedPlanId: "", requestedAt: "", startedAt: "", updatedAt: "", provider: "", providerCustomerId: "", providerSubscriptionId: "" },
      profiles: { master: { folders: [], library: [], playlists: [] } }
    };

await initializeDatabase();
await ensureState("catalog", fallbackCatalog);
await ensureState("workspace", fallbackWorkspace);
const defaultChurch = await ensureDefaultChurch({
  slug: process.env.DEFAULT_CHURCH_SLUG || "primicias",
  name: fallbackWorkspace?.branding?.organizationName || "Ministério Primícias",
  workspace: fallbackWorkspace,
  catalog: fallbackCatalog,
});
const churchContext = new AsyncLocalStorage();

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
app.use(express.json({ limit: "1mb" }));

function currentChurchId(explicitChurchId = "") {
  const churchId = String(explicitChurchId || churchContext.getStore()?.churchId || defaultChurch?.id || "");
  if (!churchId) throw new Error("Church context is not available.");
  return churchId;
}

function churchDirectory(root, explicitChurchId = "") {
  const directory = join(root, currentChurchId(explicitChurchId));
  mkdirSync(directory, { recursive: true });
  return directory;
}

function scopedFile(root, filename, explicitChurchId = "") {
  return join(churchDirectory(root, explicitChurchId), basename(String(filename || "")));
}

function scopedFileWithLegacyFallback(root, filename, explicitChurchId = "") {
  const scoped = scopedFile(root, filename, explicitChurchId);
  if (existsSync(scoped)) return scoped;
  if (currentChurchId(explicitChurchId) === defaultChurch?.id) return join(root, basename(String(filename || "")));
  return scoped;
}

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
    const directory = join(churchDirectory(eventFilesDir, req.auth?.churchId), eventId);
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

const BRAND_LOGO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const brandingStorage = multer.diskStorage({
  destination(req, _file, callback) { callback(null, churchDirectory(brandingDir, req.auth?.churchId)); },
  filename(_req, file, callback) {
    const extension = extname(file.originalname || "").toLowerCase();
    callback(null, "logo-" + randomUUID() + (BRAND_LOGO_EXTENSIONS.has(extension) ? extension : ".png"));
  }
});
const uploadBrandLogo = multer({
  storage: brandingStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    const extension = extname(file.originalname || "").toLowerCase();
    if (!BRAND_LOGO_EXTENSIONS.has(extension)) return callback(new Error("Envie uma logo PNG, JPG ou WebP."));
    callback(null, true);
  }
}).single("logo");

const AVATAR_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const avatarStorage = multer.diskStorage({
  destination(req, _file, callback) { callback(null, churchDirectory(avatarsDir, req.auth?.churchId)); },
  filename(req, file, callback) {
    const extension = extname(file.originalname || "").toLowerCase();
    const memberId = String(req.auth?.memberId || "user").replace(/[^a-zA-Z0-9_-]/g, "");
    callback(null, memberId + "-" + randomUUID() + (AVATAR_EXTENSIONS.has(extension) ? extension : ".png"));
  }
});
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, callback) {
    const extension = extname(file.originalname || "").toLowerCase();
    if (!AVATAR_EXTENSIONS.has(extension)) return callback(new Error("Envie uma foto PNG, JPG ou WebP."));
    callback(null, true);
  }
}).single("avatar");

function publicBranding(workspace, church = null) {
  const rawLogoUrl = String(workspace.branding.logoUrl || "");
  const logoUrl = church?.slug && rawLogoUrl.startsWith("/tenant-branding/")
    ? rawLogoUrl + (rawLogoUrl.includes("?") ? "&" : "?") + "church=" + encodeURIComponent(church.slug)
    : rawLogoUrl;
  return {
    productName: "Louwy",
    organizationName: workspace.branding.organizationName,
    logoUrl,
    accentColor: workspace.branding.accentColor
  };
}

const PWA_ICON_FILES = {
  institutional: {
    "icon-192.png": "institutional-192.png",
    "icon-512.png": "institutional-512.png",
    "maskable-512.png": "institutional-maskable-512.png",
    "apple-touch-icon.png": "institutional-apple-touch.png"
  },
  church: {
    "icon-192.png": "louwy-192.png",
    "icon-512.png": "louwy-512.png",
    "maskable-512.png": "louwy-maskable-512.png",
    "apple-touch-icon.png": "apple-touch-icon.png"
  }
};

function pwaShortName(value) {
  const name = String(value || "Louwy").trim() || "Louwy";
  if (name.length <= 24) return name;
  return name.split(/\s+/).slice(0, 2).join(" ").slice(0, 24) || "Louwy";
}

function pwaManifest(workspace = null, church = null) {
  const institutional = !church;
  const name = institutional ? "Louwy" : String(workspace?.branding?.organizationName || church.name || "Louwy");
  return {
    id: "/",
    name,
    short_name: pwaShortName(name),
    description: institutional
      ? "Plataforma para ministérios de louvor"
      : `Ambiente de louvor de ${name} no Louwy`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    lang: "pt-BR",
    background_color: institutional ? "#0d155d" : "#0b0d10",
    theme_color: institutional ? "#0d155d" : String(workspace?.branding?.accentColor || "#0b0d10"),
    icons: [
      { src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
}

function removeUploadedFiles(files = []) {
  for (const file of files) {
    if (file?.path && existsSync(file.path)) rmSync(file.path, { force: true });
  }
}

function removePreviousUpload(directory, filename) {
  if (!filename) return;
  try { rmSync(join(directory, basename(String(filename))), { force: true }); }
  catch (error) { console.warn("Não foi possível limpar o arquivo anterior:", error.message); }
}

let writeQueue = Promise.resolve();
app.use(async (req, res, next) => {
  if (!new Set(["POST", "PUT", "PATCH", "DELETE"]).has(req.method)) return next();
  // Media endpoints use the catalog mutation queue and their own job guards.
  // Waiting for a subprocess must not hold up account or workspace changes.
  if (req.method === "POST" && /^\/api\/(?:import|upload-song|(?:detect-key|lyrics|stems)\/[^/]+)\/?$/i.test(req.path)) return next();
  let release;
  const previous = writeQueue;
  writeQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  if (res.destroyed) {
    release();
    return;
  }
  let released = false;
  const unlock = () => {
    if (released) return;
    released = true;
    release();
  };
  res.once("finish", unlock);
  // A disconnected client does not cancel an in-flight database write. Keep
  // its lock until the handler ends its response, even if the socket is gone.
  const end = res.end;
  res.end = function (...args) {
    try { return end.apply(this, args); }
    finally { unlock(); }
  };
  next();
});

const readCatalog = (explicitChurchId = "") => readChurchState(currentChurchId(explicitChurchId), "catalog");
const saveCatalog = (rows, explicitChurchId = "") => writeChurchState(currentChurchId(explicitChurchId), "catalog", rows);
const catalogWriteQueues = new Map();
function mutateCatalog(mutate, explicitChurchId = "") {
  const churchId = currentChurchId(explicitChurchId);
  const previous = catalogWriteQueues.get(churchId) || Promise.resolve();
  const operation = previous.then(async () => {
    const catalog = await readCatalog(churchId);
    const result = await mutate(catalog);
    await saveCatalog(catalog, churchId);
    return result;
  });
  catalogWriteQueues.set(churchId, operation.catch(() => {}));
  return operation;
}
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
  const branding = workspace.branding && typeof workspace.branding === "object" ? workspace.branding : {};
  workspace.branding = {
    productName: "Louwy",
    organizationName: String(branding.organizationName || "Ministério Primícias").trim() || "Minha organização",
    logoUrl: String(branding.logoUrl || "/branding/primicias-logo.png"),
    logoStoredName: branding.logoStoredName ? String(branding.logoStoredName) : undefined,
    accentColor: /^#[0-9a-f]{6}$/i.test(String(branding.accentColor || "")) ? String(branding.accentColor) : "#d8ff55"
  };
  workspace.subscription = normalizeSubscription(workspace.subscription);
  workspace.members = Array.isArray(workspace.members) ? workspace.members : [];
  workspace.notifications = Array.isArray(workspace.notifications)
    ? workspace.notifications
        .filter((item) => item && item.id && item.memberId && item.title)
        .map((item) => ({
          id: String(item.id),
          memberId: String(item.memberId),
          type: String(item.type || "event-update"),
          title: String(item.title || "Atualização").slice(0, 120),
          message: String(item.message || "").slice(0, 500),
          eventId: item.eventId ? String(item.eventId) : "",
          songId: item.songId ? String(item.songId) : "",
          actorId: item.actorId ? String(item.actorId) : "",
          createdAt: String(item.createdAt || new Date().toISOString()),
          readAt: item.readAt ? String(item.readAt) : ""
        }))
        .slice(0, 3000)
    : [];
  workspace.profiles = workspace.profiles && typeof workspace.profiles === "object" ? workspace.profiles : {};

  const legacyGroups = Array.isArray(workspace.eventGroups) ? workspace.eventGroups : [];
  workspace.teams = Array.isArray(workspace.teams) ? workspace.teams : legacyGroups.map((group) => ({
    id: group.id, name: group.name, description: group.description || "", color: workspace.branding.accentColor || "#d8ff55", emoji: "🎵",
    memberIds: Array.isArray(group.memberIds) ? group.memberIds : [],
    vocalConfig: { highParts: 3, lowParts: 3 }, archived: false, createdAt: group.createdAt || new Date().toISOString()
  }));
  workspace.teams = workspace.teams.map((team) => ({
    ...team,
    memberIds: Array.isArray(team.memberIds) ? team.memberIds.map(String) : [],
    leaderId: String(team.leaderId || (Array.isArray(team.leaderIds) ? team.leaderIds[0] : "") || ""),
    vocalConfig: { highParts: clampParts(team.vocalConfig?.highParts), lowParts: clampParts(team.vocalConfig?.lowParts) },
    archived: Boolean(team.archived)
  }));

  workspace.events = Array.isArray(workspace.events) ? workspace.events : [];
  workspace.events = workspace.events.map((event) => {
    const rawParticipants = Array.isArray(event.participants) ? event.participants : (Array.isArray(event.assignments) ? event.assignments : []);
    const participants = rawParticipants.map((participant) => ({
      memberId: String(participant.memberId || ""),
      function: String(participant.function || "Equipe"),
      status: ["pending", "confirmed", "unavailable"].includes(participant.status) ? participant.status : "pending",
      absenceReason: participant.status === "unavailable" ? String(participant.absenceReason || "").trim() : "",
      respondedAt: participant.respondedAt ? String(participant.respondedAt) : ""
    })).filter((participant) => participant.memberId);
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
    member.permissions = Array.isArray(member.permissions) ? member.permissions.map(String) : [];
    if (!workspace.profiles[member.id]) workspace.profiles[member.id] = defaultProfile();
  }
  delete workspace.eventGroups;
  return workspace;
}

const readWorkspace = async (explicitChurchId = "") => normalizeWorkspace(
  await readChurchState(currentChurchId(explicitChurchId), "workspace"),
);
const saveWorkspace = async (churchOrWorkspace, maybeWorkspace) => {
  const explicitChurchId = maybeWorkspace === undefined ? "" : churchOrWorkspace;
  const workspace = maybeWorkspace === undefined ? churchOrWorkspace : maybeWorkspace;
  return writeChurchState(
    currentChurchId(explicitChurchId),
    "workspace",
    normalizeWorkspace(workspace),
  );
};

async function updateChurchSubscription(churchId, patch) {
  if (!churchId) throw new Error("A assinatura não possui uma igreja vinculada.");
  const workspace = normalizeWorkspace(await readChurchState(churchId, "workspace"));
  workspace.subscription = {
    ...normalizeSubscription(workspace.subscription),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeChurchState(churchId, "workspace", workspace);
  return workspace.subscription;
}

async function cancelMercadoPagoSubscription(subscriptionId) {
  if (!subscriptionId) return null;
  return mercadoPagoRequest(mercadoPagoAccessToken, `/preapproval/${encodeURIComponent(subscriptionId)}`, {
    method: "PUT",
    body: { status: "cancelled" },
  });
}

async function findChurchSubscriptionByProviderId(subscriptionId) {
  if (!subscriptionId) return null;
  for (const church of await listChurches()) {
    const workspace = normalizeWorkspace(await readChurchState(church.id, "workspace"));
    const subscription = normalizeSubscription(workspace.subscription);
    if (subscription.providerSubscriptionId === subscriptionId
      || subscription.requestedProviderSubscriptionId === subscriptionId) {
      return { church, workspace, subscription };
    }
  }
  return null;
}

async function applyMercadoPagoPreapproval(remote) {
  const reference = parseLouwyReference(remote?.external_reference);
  const located = reference.churchId ? null : await findChurchSubscriptionByProviderId(String(remote?.id || ""));
  const churchId = reference.churchId || located?.church?.id || "";
  const planId = normalizePlanId(reference.planId || located?.subscription?.requestedPlanId || located?.subscription?.planId);
  if (!churchId) throw new Error("Assinatura do Mercado Pago sem igreja correspondente.");
  const workspace = located?.workspace || normalizeWorkspace(await readChurchState(churchId, "workspace"));
  const current = normalizeSubscription(workspace.subscription);
  const providerId = String(remote?.id || "");
  const status = mercadoPagoSubscriptionStatus(remote?.status);
  const payerEmail = validBillingEmail(remote?.payer_email) || current.payerEmail;

  if (status === "active") {
    const previousId = current.providerSubscriptionId;
    workspace.subscription = {
      ...current, planId, status: "active", requestedPlanId: "", requestedAt: "",
      provider: "mercado_pago", payerEmail,
      providerCustomerId: String(remote?.payer_id || current.providerCustomerId || ""),
      providerSubscriptionId: providerId, requestedProviderSubscriptionId: "",
      startedAt: current.startedAt || String(remote?.date_created || new Date().toISOString()),
      nextPaymentAt: String(remote?.next_payment_date || ""), cancelledAt: "",
      updatedAt: new Date().toISOString(),
    };
    await writeChurchState(churchId, "workspace", workspace);
    if (previousId && previousId !== providerId) {
      await cancelMercadoPagoSubscription(previousId).catch((error) =>
        console.error("Não foi possível cancelar a assinatura anterior do Mercado Pago", error.message));
    }
    return workspace.subscription;
  }

  if (status === "pending") {
    workspace.subscription = {
      ...current,
      status: current.planId === "free" ? "pending" : current.status,
      requestedPlanId: planId, requestedAt: current.requestedAt || new Date().toISOString(),
      requestedProviderSubscriptionId: providerId, provider: "mercado_pago", payerEmail,
      updatedAt: new Date().toISOString(),
    };
  } else if (status === "past_due" && current.providerSubscriptionId === providerId) {
    workspace.subscription = { ...current, status: "past_due", updatedAt: new Date().toISOString() };
  } else if (status === "cancelled") {
    if (current.providerSubscriptionId === providerId) {
      workspace.subscription = {
        ...current, planId: "free", status: "cancelled", requestedPlanId: "", requestedAt: "",
        requestedProviderSubscriptionId: "", nextPaymentAt: "", cancelledAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } else if (current.requestedProviderSubscriptionId === providerId) {
      workspace.subscription = {
        ...current, requestedPlanId: "", requestedAt: "", requestedProviderSubscriptionId: "",
        status: current.planId === "free" ? "active" : current.status, updatedAt: new Date().toISOString(),
      };
    }
  }
  await writeChurchState(churchId, "workspace", workspace);
  return workspace.subscription;
}

async function applyMercadoPagoAuthorizedPayment(payment) {
  const providerId = String(payment?.preapproval_id || "");
  const located = await findChurchSubscriptionByProviderId(providerId);
  if (!located) return null;
  const approved = approvedAuthorizedPayment(payment?.status);
  if (approved) {
    const remote = await mercadoPagoRequest(mercadoPagoAccessToken, `/preapproval/${encodeURIComponent(providerId)}`);
    await applyMercadoPagoPreapproval(remote);
  }
  return updateChurchSubscription(located.church.id, {
    status: approved ? "active" : "past_due",
    lastPaymentAt: approved ? String(payment?.date_created || new Date().toISOString()) : located.subscription.lastPaymentAt,
  });
}

async function handleMercadoPagoWebhook(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const dataId = String(req.query?.["data.id"] || body?.data?.id || "");
  const type = String(req.query?.type || body?.type || "");
  if (!dataId) return res.status(400).send("Missing data.id");
  const valid = verifyMercadoPagoSignature({
    secret: mercadoPagoWebhookSecret,
    signature: req.get("x-signature"),
    requestId: req.get("x-request-id"),
    dataId,
  });
  if (!valid) return res.status(401).send("Invalid signature");
  if (dataId === "123456") return res.status(200).send("OK");
  try {
    if (type === "subscription_preapproval") {
      const remote = await mercadoPagoRequest(mercadoPagoAccessToken, `/preapproval/${encodeURIComponent(dataId)}`);
      await applyMercadoPagoPreapproval(remote);
    } else if (type === "subscription_authorized_payment") {
      const payment = await mercadoPagoRequest(mercadoPagoAccessToken, `/authorized_payments/${encodeURIComponent(dataId)}`);
      await applyMercadoPagoAuthorizedPayment(payment);
    }
    return res.status(200).send("OK");
  } catch (error) {
    console.error("Mercado Pago webhook failed", { type, dataId, error: error.message });
    return res.status(500).send("Webhook processing failed");
  }
}

let mediaRunning = false;
const mediaQueue = [];
const MAX_QUEUED_MEDIA = 20;
const MEDIA_TIMEOUT_MS = 30 * 60 * 1000;

function scheduleMedia(task, signal) {
  if (mediaQueue.length >= MAX_QUEUED_MEDIA) {
    const error = new Error("Há muitas músicas em processamento. Tente novamente em alguns minutos.");
    error.status = 503;
    throw error;
  }
  return new Promise((resolve, reject) => {
    const entry = { task, resolve, reject, signal, abort: null };
    entry.abort = () => {
      const index = mediaQueue.indexOf(entry);
      if (index >= 0) mediaQueue.splice(index, 1);
      reject(new Error("Processamento cancelado."));
    };
    if (signal?.aborted) return entry.abort();
    signal?.addEventListener("abort", entry.abort, { once: true });
    mediaQueue.push(entry);
    startNextMedia();
  });
}

function startNextMedia() {
  if (mediaRunning) return;
  const entry = mediaQueue.shift();
  if (!entry) return;
  mediaRunning = true;
  entry.signal?.removeEventListener("abort", entry.abort);
  Promise.resolve().then(entry.task).then(entry.resolve, entry.reject).finally(() => {
    mediaRunning = false;
    startNextMedia();
  });
}

function executeProcess(command, args, { signal, onOutput, timeoutMs = MEDIA_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Processamento cancelado."));
    const child = spawn(command, args, { env: process.env, signal });
    let out = "";
    let err = "";
    let failure;
    const timer = setTimeout(() => {
      failure = new Error("O processamento excedeu o tempo limite. Tente uma música mais curta.");
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (data) => {
      out += data.toString();
      onOutput?.(data);
      if (out.length > 32 * 1024 * 1024) {
        failure = new Error("O processamento retornou dados demais.");
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (data) => {
      err = (err + data.toString()).slice(-64 * 1024);
      onOutput?.(data);
    });
    child.once("error", (error) => { failure = error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      return code === 0 ? resolve(out) : reject(new Error(err || "Processo terminou com código " + code));
    });
  });
}

const run = (command, args, onStart) => scheduleMedia(() => {
  onStart?.();
  return executeProcess(command, args);
});

const keyJobs = new Map();
const importOperations = new Map();
const importJobs = new Map();
const activeImportJobs = new Map();
const MAX_ACTIVE_IMPORTS = 20;
const MAX_FINISHED_IMPORT_JOBS = 200;
const IMPORT_JOB_RETENTION_MS = 30 * 60 * 1000;

function detectKey(audioPath, onStart) {
  const current = keyJobs.get(audioPath);
  if (current) {
    if (onStart) {
      if (current.started) onStart();
      else current.listeners.add(onStart);
    }
    return current.operation;
  }
  const controller = new AbortController();
  const job = { operation: null, controller, started: false, listeners: new Set(onStart ? [onStart] : []) };
  const operation = scheduleMedia(async () => {
    job.started = true;
    for (const listener of job.listeners) listener();
    job.listeners.clear();
    const raw = await executeProcess(stemPython, [detectKeyScript, audioPath], { signal: controller.signal });
    return JSON.parse(raw);
  }, controller.signal);
  job.operation = operation;
  keyJobs.set(audioPath, job);
  void operation.finally(() => {
    if (keyJobs.get(audioPath) === job) keyJobs.delete(audioPath);
  }).catch(() => {});
  return operation;
}

const stemJobs = new Map();
const lyricsJobs = new Map();
const stemControllers = new Map();
const lyricsControllers = new Map();
const mediaJobKey = (songId, explicitChurchId = "") => `${currentChurchId(explicitChurchId)}:${songId}`;
const STEM_NAMES = ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Other"];

function collectStems(songId, explicitChurchId = "") {
  const churchId = currentChurchId(explicitChurchId);
  const scopedDir = join(churchDirectory(stemsDir, churchId), songId);
  const legacyDir = join(stemsDir, songId);
  const dir = existsSync(scopedDir) ? scopedDir : churchId === defaultChurch?.id ? legacyDir : scopedDir;
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".mp3"));
  const stems = {};
  for (const stem of STEM_NAMES) {
    const file = files.find((name) => name.includes("_(" + stem + ")_"));
    if (file) stems[stem.toLowerCase()] = "/stems/" + songId + "/" + encodeURIComponent(file);
  }
  return Object.keys(stems).length >= 6 ? stems : null;
}

async function updateSong(songId, patch, explicitChurchId = "") {
  return mutateCatalog((catalog) => {
    const index = catalog.findIndex((item) => item.id === songId);
    if (index < 0) return null;
    catalog[index] = Object.assign({}, catalog[index], patch);
    return catalog[index];
  }, explicitChurchId);
}

const isMaster = (workspace, actorId) => workspace.members.some((member) => member.id === actorId && member.role === "master" && member.active !== false);
const isTeamLeader = (workspace, teamId, actorId) => workspace.teams.some((team) =>
  team.id === teamId && !team.archived && team.leaderId === actorId
);
const canManageTeam = (workspace, teamId, actorId) => isMaster(workspace, actorId) || isTeamLeader(workspace, teamId, actorId);
const canManageEvent = (workspace, event, actorId) => isMaster(workspace, actorId) || Boolean(event?.teamId && isTeamLeader(workspace, event.teamId, actorId));
const canCustomizeOrganization = (workspace, actorId) => workspace.members.some((member) =>
  member.id === actorId && member.active !== false && (member.role === "master" || (member.permissions || []).includes("branding"))
);
const findEvent = (workspace, eventId) => workspace.events.find((event) => event.id === eventId);

function memberName(workspace, memberId) {
  return workspace.members.find((member) => member.id === memberId)?.name || "Alguém";
}

function formatEventMoment(event) {
  const date = String(event.date || "").trim();
  const time = String(event.time || "").trim();
  const location = String(event.location || "").trim();
  const parts = [];
  if (date) parts.push(date.split("-").reverse().join("/"));
  if (time) parts.push(time);
  if (location) parts.push(location);
  return parts.join(" · ");
}

function addNotifications(workspace, { memberIds, type, title, message, eventId = "", songId = "", actorId = "", excludeIds = [] }) {
  const active = new Set(workspace.members.filter((member) => member.active !== false).map((member) => member.id));
  const excluded = new Set(excludeIds.filter(Boolean));
  const recipients = [...new Set((memberIds || []).map(String))]
    .filter((memberId) => active.has(memberId) && !excluded.has(memberId));
  if (!recipients.length) return [];
  const createdAt = new Date().toISOString();
  const rows = recipients.map((memberId) => ({
    id: randomUUID(),
    memberId,
    type: String(type || "event-update"),
    title: String(title || "Atualização").trim().slice(0, 120),
    message: String(message || "").trim().slice(0, 500),
    eventId: eventId ? String(eventId) : "",
    songId: songId ? String(songId) : "",
    actorId: actorId ? String(actorId) : "",
    createdAt,
    readAt: ""
  }));
  workspace.notifications.unshift(...rows);
  workspace.notifications = workspace.notifications.slice(0, 3000);
  return rows;
}

function lyricsLooksBad(result) {
  const text = String(result?.text || "").toLowerCase();
  const words = text.replace(/[^a-zà-ÿ0-9\s]/gi, " ").split(/\s+/).filter(Boolean);
  if (words.length < 4) return true;
  const uniqueRatio = new Set(words).size / Math.max(1, words.length);
  const promptLeak = words.filter((word) => word === "transcribe" || word === "worship").length;
  return uniqueRatio < 0.18 || promptLeak > 3;
}

const auth = createAuth({
  readWorkspace,
  saveWorkspace,
  secretPath: authSecretPath,
  findChurchBySlug,
  getChurchById,
  getDefaultChurch,
  createChurch,
});
auth.registerRoutes(app);

function runChurchContext(req, _res, next) {
  churchContext.run({ churchId: req.auth.churchId, church: req.auth.church }, next);
}

app.get("/api/health", async (_req, res) => res.json({ ok: true, database: await stateHealth() }));
app.post("/api/mercadopago/webhook", handleMercadoPagoWebhook);

app.get("/api/plans", (_req, res) => res.json({ plans: publicPlans() }));


app.get("/manifest.webmanifest", async (req, res) => {
  const context = await resolveChurch(req, { findChurchBySlug, getDefaultChurch, allowDefault: isLocalDevelopmentRequest(req) });
  const workspace = context.church ? await readWorkspace(context.church.id) : null;
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Vary", "Host");
  res.type("application/manifest+json").send(JSON.stringify(pwaManifest(workspace, context.church)));
});

app.get("/pwa/:icon", async (req, res) => {
  const icon = String(req.params.icon || "");
  const context = await resolveChurch(req, { findChurchBySlug, getDefaultChurch, allowDefault: isLocalDevelopmentRequest(req) });
  const mode = context.church ? "church" : "institutional";
  const filename = PWA_ICON_FILES[mode][icon];
  if (!filename) return res.status(404).end();
  const filePath = join(base, "..", "dist", "icons", filename);
  if (!existsSync(filePath)) return res.status(404).end();
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("Vary", "Host");
  res.type("png").sendFile(filePath);
});

app.get("/tenant-branding/:filename", async (req, res) => {
  const context = await resolveChurch(req, { findChurchBySlug, getDefaultChurch, allowDefault: isLocalDevelopmentRequest(req) });
  if (!context.church) return res.status(404).end();
  const filePath = scopedFileWithLegacyFallback(brandingDir, req.params.filename, context.church.id);
  if (!existsSync(filePath)) return res.status(404).end();
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.sendFile(filePath);
});

app.get("/api/branding", async (req, res) => {
  const context = await resolveChurch(req, { findChurchBySlug, getDefaultChurch, allowDefault: isLocalDevelopmentRequest(req) });
  if (!context.church) {
    return res.json({ productName: "Louwy", organizationName: "Louwy", logoUrl: "/icons/louwy-192.png", accentColor: "#d8b247", institutional: true });
  }
  const workspace = await readWorkspace(context.church.id);
  res.json({ ...publicBranding(workspace, context.church), church: context.church });
});

app.get("/member-avatars/:filename", auth.requireAuth, runChurchContext, async (req, res) => {
  const workspace = await readWorkspace();
  const filename = basename(String(req.params.filename || ""));
  const allowed = workspace.members.some((member) => {
    const stored = basename(String(member.avatarStoredName || ""));
    const fromUrl = basename(String(member.avatarUrl || ""));
    return filename && (stored === filename || fromUrl === filename);
  });
  if (!allowed) return res.status(404).end();
  const filePath = scopedFileWithLegacyFallback(avatarsDir, filename);
  if (!existsSync(filePath)) return res.status(404).end();
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.sendFile(filePath);
});

app.get("/audio/:filename", auth.requireAuth, runChurchContext, async (req, res) => {
  const filename = basename(String(req.params.filename || ""));
  const catalog = await readCatalog();
  if (!catalog.some((song) => basename(String(song.audioUrl || "")) === filename)) return res.status(404).end();
  const filePath = scopedFileWithLegacyFallback(audioDir, filename);
  if (!existsSync(filePath)) return res.status(404).end();
  res.setHeader("Cache-Control", "private, max-age=604800");
  res.sendFile(filePath);
});

app.get("/stems/:songId/:filename", auth.requireAuth, runChurchContext, async (req, res) => {
  const filename = basename(String(req.params.filename || ""));
  const songId = String(req.params.songId || "");
  const catalog = await readCatalog();
  const song = catalog.find((item) => item.id === songId);
  const allowed = song && Object.values(song.stems || {}).some((url) => basename(String(url || "")) === filename);
  if (!allowed) return res.status(404).end();
  const scopedRoot = join(churchDirectory(stemsDir), songId);
  const scopedPath = join(scopedRoot, filename);
  const legacyPath = join(stemsDir, songId, filename);
  const filePath = existsSync(scopedPath) ? scopedPath : currentChurchId() === defaultChurch?.id ? legacyPath : scopedPath;
  if (!existsSync(filePath)) return res.status(404).end();
  res.setHeader("Cache-Control", "private, max-age=2592000");
  res.sendFile(filePath);
});

app.use("/api", auth.requireAuth, runChurchContext);

app.get("/api/billing", async (req, res) => {
  const workspace = await readWorkspace();
  res.json({ ...billingSummary(workspace), plans: publicPlans() });
});

app.post("/api/billing/request-plan", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode alterar o plano." });
  const planId = normalizePlanId(req.body?.planId);
  const current = billingSummary(workspace);
  if (planId !== "free") return res.status(400).json({ error: "Use o checkout seguro para ativar um plano pago." });
  if (current.members > 5) {
    return res.status(409).json({
      error: "Para voltar ao plano grátis, reduza a igreja para no máximo 5 membros ativos.",
      billing: current,
    });
  }
  const providerIds = [
    current.subscription.requestedProviderSubscriptionId,
    current.subscription.providerSubscriptionId,
  ].filter(Boolean);
  try {
    for (const providerId of [...new Set(providerIds)]) await cancelMercadoPagoSubscription(providerId);
  } catch (error) {
    console.error("Falha ao cancelar assinatura no Mercado Pago", error.message);
    return res.status(502).json({ error: "Não foi possível cancelar a cobrança no Mercado Pago. Tente novamente." });
  }
  workspace.subscription = {
    ...normalizeSubscription(workspace.subscription),
    planId: "free", status: "active", requestedPlanId: "", requestedAt: "",
    provider: "", providerCustomerId: "", providerSubscriptionId: "",
    requestedProviderSubscriptionId: "", nextPaymentAt: "",
    cancelledAt: providerIds.length ? new Date().toISOString() : "",
    updatedAt: new Date().toISOString(),
  };
  await saveWorkspace(workspace);
  return res.json({ ...billingSummary(workspace), message: "Plano grátis ativado." });
});

app.post("/api/billing/checkout", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode contratar um plano." });
  if (!mercadoPagoAccessToken) return res.status(503).json({ error: "O Mercado Pago ainda não foi configurado." });
  const planId = normalizePlanId(req.body?.planId);
  if (planId === "free") return res.status(400).json({ error: "O plano grátis não precisa de checkout." });
  const plan = PLAN_DEFINITIONS[planId];
  const current = billingSummary(workspace);
  if (current.subscription.planId === planId && current.subscription.status === "active") {
    return res.status(409).json({ error: "Este plano já está ativo." });
  }
  const master = workspace.members.find((member) => member.id === actorId);
  const payerEmail = validBillingEmail(req.body?.payerEmail || master?.email || current.subscription.payerEmail);
  if (!payerEmail) return res.status(400).json({ error: "Informe um e-mail válido para a cobrança mensal." });

  if (current.subscription.requestedPlanId === planId && current.subscription.requestedProviderSubscriptionId) {
    try {
      const pending = await mercadoPagoRequest(
        mercadoPagoAccessToken,
        `/preapproval/${encodeURIComponent(current.subscription.requestedProviderSubscriptionId)}`,
      );
      if (pending.status === "pending" && pending.init_point) {
        return res.json({ url: pending.init_point, subscriptionId: pending.id, reused: true });
      }
    } catch (error) {
      console.warn("Checkout pendente do Mercado Pago não pôde ser reutilizado", error.message);
    }
  }

  const origin = `${req.protocol}://${req.get("host")}`;
  try {
    const remote = await mercadoPagoRequest(mercadoPagoAccessToken, "/preapproval", {
      method: "POST",
      body: {
        reason: `Louwy - ${plan.name}`,
        external_reference: buildLouwyReference(req.auth.churchId, planId),
        payer_email: payerEmail,
        back_url: `${origin}/?billing=return`,
        notification_url: mercadoPagoWebhookUrl,
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: plan.priceCents / 100,
          currency_id: "BRL",
        },
        status: "pending",
      },
    });
    if (!remote?.id || !remote?.init_point) throw new Error("O Mercado Pago não retornou o link de assinatura.");
    if (master && master.email !== payerEmail) master.email = payerEmail;
    workspace.subscription = {
      ...normalizeSubscription(workspace.subscription),
      status: current.subscription.planId === "free" ? "pending" : current.subscription.status,
      requestedPlanId: planId,
      requestedAt: new Date().toISOString(),
      provider: "mercado_pago",
      payerEmail,
      requestedProviderSubscriptionId: String(remote.id),
      updatedAt: new Date().toISOString(),
    };
    await saveWorkspace(workspace);
    return res.status(201).json({ url: remote.init_point, subscriptionId: remote.id });
  } catch (error) {
    console.error("Falha ao abrir assinatura no Mercado Pago", { planId, error: error.message });
    return res.status(error.status && error.status < 500 ? 400 : 502).json({
      error: `Não foi possível abrir o Mercado Pago: ${error.message}`,
    });
  }
});

app.post("/api/billing/cancel", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode cancelar a assinatura." });
  const current = billingSummary(workspace);
  const providerIds = [
    current.subscription.requestedProviderSubscriptionId,
    current.subscription.providerSubscriptionId,
  ].filter(Boolean);
  if (!providerIds.length) return res.status(409).json({ error: "Esta igreja não possui uma assinatura paga ativa ou pendente." });
  try {
    for (const providerId of [...new Set(providerIds)]) await cancelMercadoPagoSubscription(providerId);
  } catch (error) {
    console.error("Falha ao cancelar assinatura no Mercado Pago", error.message);
    return res.status(502).json({ error: "Não foi possível cancelar a assinatura no Mercado Pago." });
  }
  workspace.subscription = {
    ...normalizeSubscription(workspace.subscription),
    planId: "free", status: "cancelled", requestedPlanId: "", requestedAt: "",
    providerSubscriptionId: "", requestedProviderSubscriptionId: "", nextPaymentAt: "",
    cancelledAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await saveWorkspace(workspace);
  return res.json({ ...billingSummary(workspace), message: "Assinatura cancelada. A igreja voltou ao plano grátis." });
});

app.post("/api/billing/sync", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode sincronizar a assinatura." });
  const subscription = normalizeSubscription(workspace.subscription);
  const providerId = subscription.requestedProviderSubscriptionId || subscription.providerSubscriptionId;
  if (!providerId) return res.json({ ...billingSummary(workspace), synced: false });
  try {
    const remote = await mercadoPagoRequest(mercadoPagoAccessToken, `/preapproval/${encodeURIComponent(providerId)}`);
    await applyMercadoPagoPreapproval(remote);
    const updated = await readWorkspace();
    return res.json({ ...billingSummary(updated), synced: true });
  } catch (error) {
    console.error("Falha ao sincronizar assinatura do Mercado Pago", error.message);
    return res.status(502).json({ error: "Não foi possível consultar o estado da assinatura no Mercado Pago." });
  }
});

app.get("/api/notifications", async (req, res) => {
  const workspace = await readWorkspace();
  const rows = workspace.notifications
    .filter((item) => item.memberId === req.auth.memberId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 100);
  res.json({
    notifications: rows,
    unreadCount: rows.filter((item) => !item.readAt).length
  });
});

app.patch("/api/notifications/:id/read", async (req, res) => {
  const workspace = await readWorkspace();
  const notification = workspace.notifications.find((item) => item.id === req.params.id && item.memberId === req.auth.memberId);
  if (!notification) return res.status(404).json({ error: "Notificação não encontrada." });
  if (!notification.readAt) notification.readAt = new Date().toISOString();
  await saveWorkspace(workspace);
  res.json(notification);
});

app.post("/api/notifications/read-all", async (req, res) => {
  const workspace = await readWorkspace();
  const readAt = new Date().toISOString();
  let updated = 0;
  for (const notification of workspace.notifications) {
    if (notification.memberId === req.auth.memberId && !notification.readAt) {
      notification.readAt = readAt;
      updated += 1;
    }
  }
  if (updated) await saveWorkspace(workspace);
  res.json({ ok: true, updated });
});

app.post("/api/branding", async (req, res) => {
  const initialWorkspace = await readWorkspace();
  if (!canCustomizeOrganization(initialWorkspace, req.auth.memberId)) {
    return res.status(403).json({ error: "Sua conta não tem permissão para alterar a identidade visual." });
  }

  uploadBrandLogo(req, res, async (uploadError) => {
    if (uploadError) {
      if (req.file?.path && existsSync(req.file.path)) rmSync(req.file.path, { force: true });
      const tooLarge = uploadError instanceof multer.MulterError && uploadError.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? "A logo pode ter no máximo 5 MB." : uploadError.message
      });
    }

    try {
      const workspace = await readWorkspace();
      if (!canCustomizeOrganization(workspace, req.auth.memberId)) {
        if (req.file?.path && existsSync(req.file.path)) rmSync(req.file.path, { force: true });
        return res.status(403).json({ error: "Sua conta não tem permissão para alterar a identidade visual." });
      }

      const organizationName = String(req.body?.organizationName || "").trim().slice(0, 80);
      const accentColor = String(req.body?.accentColor || "").trim();
      if (organizationName) workspace.branding.organizationName = organizationName;
      if (/^#[0-9a-f]{6}$/i.test(accentColor)) workspace.branding.accentColor = accentColor;

      const previous = workspace.branding.logoStoredName;
      if (req.file) {
        workspace.branding.logoStoredName = req.file.filename;
        workspace.branding.logoUrl = "/tenant-branding/" + encodeURIComponent(req.file.filename);
      }

      await saveWorkspace(workspace);
      if (req.file && previous !== req.file.filename) removePreviousUpload(churchDirectory(brandingDir), previous);
      res.json(publicBranding(workspace, req.auth.church));
    } catch (error) {
      if (req.file?.path && existsSync(req.file.path)) rmSync(req.file.path, { force: true });
      console.error("Falha ao atualizar identidade visual", error);
      res.status(500).json({ error: "Não foi possível salvar a identidade visual." });
    }
  });
});

app.post("/api/account", async (req, res) => {
  uploadAvatar(req, res, async (uploadError) => {
    if (uploadError) {
      if (req.file?.path && existsSync(req.file.path)) rmSync(req.file.path, { force: true });
      const tooLarge = uploadError instanceof multer.MulterError && uploadError.code === "LIMIT_FILE_SIZE";
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? "A foto pode ter no máximo 5 MB." : uploadError.message
      });
    }

    try {
      const workspace = await readWorkspace();
      const member = workspace.members.find((item) => item.id === req.auth.memberId && item.active !== false);
      if (!member) {
        if (req.file?.path && existsSync(req.file.path)) rmSync(req.file.path, { force: true });
        return res.status(404).json({ error: "Conta não encontrada." });
      }

      const name = String(req.body?.name || "").trim().slice(0, 80);
      if (name.length < 2) {
        if (req.file?.path && existsSync(req.file.path)) rmSync(req.file.path, { force: true });
        return res.status(400).json({ error: "Informe um nome válido." });
      }
      member.name = name;

      const removeAvatar = String(req.body?.removeAvatar || "") === "true";
      const previous = member.avatarStoredName;
      if (removeAvatar) {
        delete member.avatarStoredName;
        delete member.avatarUrl;
      }
      if (req.file) {
        member.avatarStoredName = req.file.filename;
        member.avatarUrl = "/member-avatars/" + encodeURIComponent(req.file.filename);
      }

      await saveWorkspace(workspace);
      if ((removeAvatar || req.file) && previous !== member.avatarStoredName) removePreviousUpload(churchDirectory(avatarsDir), previous);
      res.json({ member: auth.safeMember(member, req.auth.church) });
    } catch (error) {
      if (req.file?.path && existsSync(req.file.path)) rmSync(req.file.path, { force: true });
      console.error("Falha ao atualizar conta", error);
      res.status(500).json({ error: "Não foi possível atualizar sua conta." });
    }
  });
});

app.get("/api/workspace", async (req, res) => {
  const workspace = await readWorkspace();
  const memberId = req.auth.memberId;
  const { notifications: _privateNotifications, ...sharedWorkspace } = workspace;
  res.json({
    ...sharedWorkspace,
    church: req.auth.church,
    billing: billingSummary(workspace),
    events: workspace.events
      .filter((event) => canAccessEvent(workspace, event, memberId))
      .map((event) => visibleEvent(workspace, event, memberId)),
    agenda: workspace.events
      .filter((event) => !event.archived && !canAccessEvent(workspace, event, memberId))
      .map((event) => publicAgendaEvent(workspace, event)),
    members: workspace.members.map((member) => auth.safeMember(member, req.auth.church)),
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
  const incoming = req.body?.profile;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return res.status(400).json({ error: "Os dados da biblioteca são inválidos." });
  }
  const validRows = (rows, valid) => rows === undefined || (Array.isArray(rows) && rows.every((row) => row && typeof row === "object" && !Array.isArray(row) && valid(row)));
  if (!validRows(incoming.folders, (row) => typeof row.id === "string" && typeof row.name === "string")
    || !validRows(incoming.library, (row) => typeof row.songId === "string" && Number.isFinite(row.preferredShift))
    || !validRows(incoming.playlists, (row) => typeof row.id === "string" && typeof row.name === "string"
      && Array.isArray(row.songIds) && row.songIds.every((id) => typeof id === "string"))) {
    return res.status(400).json({ error: "Os dados da biblioteca são inválidos." });
  }
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
  return canManageEvent(workspace, event, actorId) || event.participants.some((item) => item.memberId === actorId);
}

function visibleEvent(workspace, event, actorId) {
  if (canManageEvent(workspace, event, actorId)) return event;
  return {
    ...event,
    participants: event.participants.map((participant) => ({
      ...participant,
      absenceReason: participant.memberId === actorId ? participant.absenceReason : ""
    }))
  };
}

function publicAgendaEvent(workspace, event) {
  const team = workspace.teams.find((item) => item.id === event.teamId);
  return {
    id: event.id,
    title: event.title,
    date: event.date,
    time: event.time,
    location: event.location || "",
    teamId: event.teamId || "",
    teamName: team?.name || "Sem equipe",
    color: event.color || team?.color || workspace.branding.accentColor,
    emoji: event.emoji || team?.emoji || "✦",
  };
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
  const memberIds = validMemberIds(workspace, req.body?.memberIds);
  const requestedLeaderId = String(req.body?.leaderId || "");
  const leaderId = workspace.members.some((member) => member.id === requestedLeaderId && member.active !== false)
    ? requestedLeaderId
    : "";
  if (leaderId && !memberIds.includes(leaderId)) memberIds.push(leaderId);
  const team = {
    id: randomUUID(),
    name,
    description: String(req.body?.description || "").trim(),
    color: String(req.body?.color || workspace.branding.accentColor || "#d8ff55"),
    emoji: String(req.body?.emoji || "🎵").slice(0, 8),
    memberIds,
    leaderId,
    vocalConfig: {
      highParts: clampParts(req.body?.vocalConfig?.highParts),
      lowParts: clampParts(req.body?.vocalConfig?.lowParts)
    },
    archived: false,
    createdAt: new Date().toISOString()
  };
  workspace.teams.push(team);
  addNotifications(workspace, {
    memberIds: team.memberIds,
    type: "team",
    title: `Você entrou na equipe ${team.name}`,
    message: `${memberName(workspace, actorId)} adicionou você a esta equipe.`,
    actorId,
    excludeIds: [actorId]
  });
  await saveWorkspace(workspace);
  res.status(201).json(team);
});

app.patch("/api/teams/:id", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const team = workspace.teams.find((item) => item.id === req.params.id);
  if (!team) return res.status(404).json({ error: "Equipe não encontrada." });
  if (!canManageTeam(workspace, team.id, actorId)) return res.status(403).json({ error: "Somente o master ou o líder desta equipe pode editá-la." });
  if (typeof req.body?.name === "string" && !req.body.name.trim()) return res.status(400).json({ error: "Informe o nome da equipe." });
  const previousName = team.name;
  const previousMemberIds = new Set(team.memberIds);
  for (const field of ["name", "description", "color", "emoji"]) {
    if (typeof req.body?.[field] === "string") team[field] = req.body[field].trim();
  }
  if (Array.isArray(req.body?.memberIds)) team.memberIds = validMemberIds(workspace, req.body.memberIds);
  if (typeof req.body?.leaderId === "string") {
    if (!isMaster(workspace, actorId) && req.body.leaderId !== team.leaderId) {
      return res.status(403).json({ error: "Somente o master pode trocar o líder da equipe." });
    }
    const leaderId = String(req.body.leaderId || "");
    if (leaderId && !workspace.members.some((member) => member.id === leaderId && member.active !== false)) {
      return res.status(400).json({ error: "Líder inválido." });
    }
    team.leaderId = leaderId;
    if (leaderId && !team.memberIds.includes(leaderId)) team.memberIds.push(leaderId);
  }
  if (req.body?.vocalConfig) {
    team.vocalConfig = {
      highParts: clampParts(req.body.vocalConfig.highParts, team.vocalConfig?.highParts ?? 3),
      lowParts: clampParts(req.body.vocalConfig.lowParts, team.vocalConfig?.lowParts ?? 3)
    };
  }
  if (typeof req.body?.archived === "boolean") {
    if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente o master pode arquivar uma equipe." });
    team.archived = req.body.archived;
  }
  const nextMemberIds = new Set(team.memberIds);
  const addedMemberIds = team.memberIds.filter((memberId) => !previousMemberIds.has(memberId));
  const removedMemberIds = [...previousMemberIds].filter((memberId) => !nextMemberIds.has(memberId));
  addNotifications(workspace, {
    memberIds: addedMemberIds,
    type: "team",
    title: `Você entrou na equipe ${team.name}`,
    message: `${memberName(workspace, actorId)} adicionou você à equipe.`,
    actorId,
    excludeIds: [actorId]
  });
  addNotifications(workspace, {
    memberIds: removedMemberIds,
    type: "team",
    title: `Você saiu da equipe ${previousName}`,
    message: `${memberName(workspace, actorId)} atualizou a formação da equipe.`,
    actorId,
    excludeIds: [actorId]
  });
  if (team.name !== previousName) {
    addNotifications(workspace, {
      memberIds: team.memberIds,
      type: "team",
      title: "Equipe renomeada",
      message: `${previousName} agora se chama ${team.name}.`,
      actorId,
      excludeIds: [actorId, ...addedMemberIds]
    });
  }
  await saveWorkspace(workspace);
  res.json(team);
});

app.delete("/api/teams/:id", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode excluir equipes." });
  const removedTeam = workspace.teams.find((team) => team.id === req.params.id);
  if (!removedTeam) return res.status(404).json({ error: "Equipe não encontrada." });
  workspace.teams = workspace.teams.filter((team) => team.id !== req.params.id);
  for (const event of workspace.events) if (event.teamId === req.params.id) event.teamId = "";
  addNotifications(workspace, {
    memberIds: removedTeam.memberIds,
    type: "team",
    title: `Equipe ${removedTeam.name} encerrada`,
    message: `${memberName(workspace, actorId)} removeu esta equipe. Os eventos existentes foram preservados.`,
    actorId,
    excludeIds: [actorId]
  });
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
  const billing = billingSummary(workspace);
  if (!billing.canAddMembers) {
    return res.status(402).json({
      error: `O plano ${billing.plan.name} permite até ${billing.memberLimit} membros ativos. Escolha um plano maior para cadastrar outra pessoa.`,
      code: "PLAN_MEMBER_LIMIT",
      billing,
    });
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
  res.status(201).json(auth.safeMember(member, req.auth.church));
});

app.patch("/api/members/:id", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode editar músicos." });
  const member = workspace.members.find((item) => item.id === req.params.id);
  if (!member) return res.status(404).json({ error: "Músico não encontrado." });
  if (member.role === "master" && req.body?.active === false) {
    return res.status(400).json({ error: "A conta master não pode ser desativada." });
  }
  if (typeof req.body?.name === "string" && !req.body.name.trim()) {
    return res.status(400).json({ error: "Informe o nome do músico." });
  }
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
  if (req.body?.active === true && member.active === false) {
    const billing = billingSummary(workspace);
    if (!billing.canAddMembers) return res.status(402).json({
      error: `O plano ${billing.plan.name} permite até ${billing.memberLimit} membros ativos. Escolha um plano maior para reativar esta conta.`,
      code: "PLAN_MEMBER_LIMIT",
      billing,
    });
  }
  if (typeof req.body?.active === "boolean") member.active = req.body.active;
  if (member.active !== false && workspace.members.some((item) =>
    item.id !== member.id && item.active !== false && normalizePhone(item.phoneNormalized || item.phone) === member.phoneNormalized
  )) return res.status(409).json({ error: "Este celular já está vinculado a outra conta." });
  await saveWorkspace(workspace);
  res.json(auth.safeMember(member, req.auth.church));
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
  for (const team of workspace.teams) {
    team.memberIds = team.memberIds.filter((id) => id !== req.params.id);
    if (team.leaderId === req.params.id) team.leaderId = "";
  }
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
  const title = String(req.body?.title || "").trim();
  if (!title) return res.status(400).json({ error: "Informe o nome do evento." });
  const teamId = String(req.body?.teamId || "");
  const team = workspace.teams.find((item) => item.id === teamId && !item.archived);
  if (!isMaster(workspace, actorId) && (!team || !isTeamLeader(workspace, team.id, actorId))) {
    return res.status(403).json({ error: "Somente o master ou o líder da equipe pode criar este evento." });
  }
  const participants = (Array.isArray(req.body?.participants) ? req.body.participants : [])
    .filter((item, index, rows) => item && workspace.members.some((member) => member.id === item.memberId && member.active !== false)
      && rows.findIndex((entry) => entry?.memberId === item.memberId) === index)
    .map((item) => ({
      memberId: String(item.memberId),
      function: String(item.function || "Equipe"),
      status: "pending",
      absenceReason: "",
      respondedAt: ""
    }));
  const event = {
    id: randomUUID(),
    title,
    date: String(req.body?.date || ""),
    time: String(req.body?.time || ""),
    location: String(req.body?.location || "").trim(),
    description: String(req.body?.description || "").trim(),
    color: String(req.body?.color || team?.color || workspace.branding.accentColor || "#d8ff55"),
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
  for (const participant of event.participants) {
    addNotifications(workspace, {
      memberIds: [participant.memberId],
      type: "event-invitation",
      title: `Você foi escalado: ${event.title}`,
      message: `${participant.function}${formatEventMoment(event) ? ` · ${formatEventMoment(event)}` : ""}`,
      eventId: event.id,
      actorId,
      excludeIds: [actorId]
    });
  }
  await saveWorkspace(workspace);
  res.status(201).json(event);
});

app.patch("/api/events/:id", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const event = findEvent(workspace, req.params.id);
  if (!event) return res.status(404).json({ error: "Evento não encontrado." });
  if (!canManageEvent(workspace, event, actorId)) return res.status(403).json({ error: "Somente o master ou o líder da equipe pode editar este evento." });
  if (!isMaster(workspace, actorId) && typeof req.body?.teamId === "string" && req.body.teamId !== event.teamId) {
    return res.status(403).json({ error: "Somente o master pode transferir um evento para outra equipe." });
  }
  if (typeof req.body?.title === "string" && !req.body.title.trim()) return res.status(400).json({ error: "Informe o nome do evento." });
  const previousTitle = event.title;
  const previousMoment = formatEventMoment(event);
  const previousParticipants = new Map(event.participants.map((item) => [item.memberId, { ...item }]));
  let addedMemberIds = [];
  let removedMemberIds = [];
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
    const previous = new Map(event.participants.map((item) => [item.memberId, item]));
    const seen = new Set();
    const validParticipants = req.body.participants
      .filter((item) => item && workspace.members.some((member) => member.id === item.memberId && member.active !== false))
      .filter((item) => {
        const memberId = String(item.memberId);
        if (seen.has(memberId)) return false;
        seen.add(memberId);
        return true;
      });
    const nextMemberIds = new Set(validParticipants.map((item) => String(item.memberId)));
    addedMemberIds = validParticipants
      .map((item) => String(item.memberId))
      .filter((memberId) => !previousParticipants.has(memberId));
    removedMemberIds = event.participants
      .map((item) => item.memberId)
      .filter((memberId) => !nextMemberIds.has(memberId));

    event.participants = validParticipants.map((item) => {
      const memberId = String(item.memberId);
      const existing = previous.get(memberId);
      return {
        memberId,
        function: String(item.function || "Equipe"),
        status: existing?.status || "pending",
        absenceReason: existing?.status === "unavailable" ? String(existing.absenceReason || "") : "",
        respondedAt: existing?.respondedAt || ""
      };
    });

    if (removedMemberIds.length) {
      const removed = new Set(removedMemberIds);
      for (const song of event.songs) {
        song.taggedMemberIds = (song.taggedMemberIds || []).filter((memberId) => !removed.has(memberId));
        song.vocalAssignments = (song.vocalAssignments || []).filter((assignment) => !removed.has(assignment.memberId));
      }
    }
  }
  if (typeof req.body?.archived === "boolean") event.archived = req.body.archived;
  for (const memberId of addedMemberIds) {
    const participant = event.participants.find((item) => item.memberId === memberId);
    addNotifications(workspace, {
      memberIds: [memberId],
      type: "event-invitation",
      title: `Você foi escalado: ${event.title}`,
      message: `${participant?.function || "Equipe"}${formatEventMoment(event) ? ` · ${formatEventMoment(event)}` : ""}`,
      eventId: event.id,
      actorId,
      excludeIds: [actorId]
    });
  }
  addNotifications(workspace, {
    memberIds: removedMemberIds,
    type: "event-removed",
    title: `Você foi removido: ${previousTitle}`,
    message: `${memberName(workspace, actorId)} atualizou a escala deste evento.`,
    actorId,
    excludeIds: [actorId]
  });
  const remainingMemberIds = event.participants
    .map((participant) => participant.memberId)
    .filter((memberId) => !addedMemberIds.includes(memberId));
  const roleChanged = remainingMemberIds.some((memberId) => {
    const before = previousParticipants.get(memberId);
    const after = event.participants.find((participant) => participant.memberId === memberId);
    return before && after && before.function !== after.function;
  });
  const detailsChanged = previousTitle !== event.title || previousMoment !== formatEventMoment(event) || roleChanged || Array.isArray(req.body?.modules);
  if (detailsChanged) {
    addNotifications(workspace, {
      memberIds: remainingMemberIds,
      type: "event-update",
      title: `Evento atualizado: ${event.title}`,
      message: `${formatEventMoment(event) || "A escala ou os detalhes do evento foram alterados."}${roleChanged ? " · Confira sua função." : ""}`,
      eventId: event.id,
      actorId,
      excludeIds: [actorId]
    });
  }
  await saveWorkspace(workspace);
  res.json(event);
});

app.post("/api/events/:id/duplicate", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const source = findEvent(workspace, req.params.id);
  if (!source) return res.status(404).json({ error: "Evento não encontrado." });
  if (!canManageEvent(workspace, source, actorId)) return res.status(403).json({ error: "Somente o master ou o líder da equipe pode duplicar este evento." });

  const options = {
    participants: req.body?.copyParticipants !== false,
    repertoire: req.body?.copyRepertoire !== false,
    description: req.body?.copyDescription !== false,
    materials: req.body?.copyMaterials === true,
    messages: req.body?.copyMessages === true,
    confirmations: req.body?.copyConfirmations === true
  };
  const copy = JSON.parse(JSON.stringify(source));
  copy.id = randomUUID();
  copy.title = String(req.body?.title || source.title + " · cópia").trim();
  copy.date = String(req.body?.date || "");
  copy.time = String(req.body?.time ?? source.time ?? "");
  copy.description = options.description ? source.description : "";
  copy.createdBy = actorId;
  copy.createdAt = new Date().toISOString();
  copy.archived = false;
  copy.participants = options.participants
    ? source.participants.map((item) => ({
        ...item,
        status: options.confirmations ? item.status : "pending",
        absenceReason: options.confirmations && item.status === "unavailable" ? String(item.absenceReason || "") : "",
        respondedAt: options.confirmations ? String(item.respondedAt || "") : ""
      }))
    : [];
  copy.songs = options.repertoire
    ? source.songs.map((song) => ({ ...song, id: randomUUID(), comments: [], vocalAssignments: [] }))
    : [];
  copy.messages = options.messages
    ? source.messages.map((message) => ({ ...message, id: randomUUID() }))
    : [];
  copy.attachments = [];

  if (options.materials && source.attachments.length) {
    const sourceDirectory = join(churchDirectory(eventFilesDir), source.id);
    const targetDirectory = join(churchDirectory(eventFilesDir), copy.id);
    mkdirSync(targetDirectory, { recursive: true });
    for (const attachment of source.attachments) {
      if (!attachment.storedName) continue;
      const sourcePath = join(sourceDirectory, attachment.storedName);
      if (!existsSync(sourcePath)) continue;
      const extension = extname(attachment.storedName || attachment.originalName || "").toLowerCase();
      const storedName = randomUUID() + (EVENT_FILE_EXTENSIONS.has(extension) ? extension : "");
      copyFileSync(sourcePath, join(targetDirectory, storedName));
      copy.attachments.push({
        ...attachment,
        id: randomUUID(),
        storedName,
        authorId: actorId,
        createdAt: new Date().toISOString()
      });
    }
  }

  workspace.events.push(copy);
  for (const participant of copy.participants) {
    addNotifications(workspace, {
      memberIds: [participant.memberId],
      type: "event-invitation",
      title: `Você foi escalado: ${copy.title}`,
      message: `${participant.function}${formatEventMoment(copy) ? ` · ${formatEventMoment(copy)}` : ""}`,
      eventId: copy.id,
      actorId,
      excludeIds: [actorId]
    });
  }
  await saveWorkspace(workspace);
  res.status(201).json(copy);
});

app.delete("/api/events/:id", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const removed = findEvent(workspace, req.params.id);
  if (!removed) return res.status(404).json({ error: "Evento não encontrado." });
  if (!canManageEvent(workspace, removed, actorId)) return res.status(403).json({ error: "Somente o master ou o líder da equipe pode excluir este evento." });
  workspace.events = workspace.events.filter((event) => event.id !== req.params.id);
  addNotifications(workspace, {
    memberIds: removed.participants.map((participant) => participant.memberId),
    type: "event-removed",
    title: `Evento cancelado: ${removed.title}`,
    message: `${memberName(workspace, actorId)} excluiu este evento.${formatEventMoment(removed) ? ` · ${formatEventMoment(removed)}` : ""}`,
    actorId,
    excludeIds: [actorId]
  });
  await saveWorkspace(workspace);
  const directory = join(churchDirectory(eventFilesDir), removed.id);
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
  const status = ["pending", "confirmed", "unavailable"].includes(req.body?.status) ? req.body.status : "pending";
  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  if (status === "unavailable" && reason.length < 3) {
    return res.status(400).json({ error: "Informe uma justificativa para não comparecer." });
  }
  participant.status = status;
  participant.absenceReason = status === "unavailable" ? reason : "";
  participant.respondedAt = status === "pending" ? "" : new Date().toISOString();
  await saveWorkspace(workspace);
  res.json(visibleEvent(workspace, event, actorId));
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
  const scopedPath = join(churchDirectory(eventFilesDir), event.id, storedName);
  const legacyPath = join(eventFilesDir, event.id, storedName);
  const filePath = existsSync(scopedPath) ? scopedPath : currentChurchId() === defaultChurch?.id ? legacyPath : scopedPath;
  if (!existsSync(filePath)) return res.status(404).json({ error: "O arquivo não está mais disponível." });
  const displayName = attachment.originalName || attachment.title || storedName;
  if (req.query.download === "1") return res.download(filePath, displayName);
  // The multipart MIME type is supplied by the uploader and must not control
  // executable content served on the authenticated application origin.
  res.type(storedName);
  res.setHeader("Content-Security-Policy", "sandbox");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(displayName)}`);
  res.sendFile(filePath);
});

app.delete("/api/events/:eventId/attachments/:attachmentId", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const event = findEvent(workspace, req.params.eventId);
  if (!event) return res.status(404).json({ error: "Evento não encontrado." });
  if (!canAccessEvent(workspace, event, actorId)) return res.status(403).json({ error: "Você não participa deste evento." });
  const attachment = event.attachments.find((item) => item.id === req.params.attachmentId);
  if (!attachment) return res.status(404).json({ error: "Arquivo não encontrado." });
  if (!canManageEvent(workspace, event, actorId) && attachment.authorId !== actorId) return res.status(403).json({ error: "Você não pode remover este arquivo." });
  event.attachments = event.attachments.filter((item) => item.id !== req.params.attachmentId);
  await saveWorkspace(workspace);
  if (attachment.storedName) {
    const scopedPath = join(churchDirectory(eventFilesDir), event.id, basename(attachment.storedName));
    const legacyPath = join(eventFilesDir, event.id, basename(attachment.storedName));
    const filePath = existsSync(scopedPath) ? scopedPath : currentChurchId() === defaultChurch?.id ? legacyPath : scopedPath;
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
  const managesEvent = canManageEvent(workspace, event, actorId);
  if (!managesEvent && (!participant || !isVocalMember(actor))) {
    return res.status(403).json({ error: "Somente vocais participantes, o líder da equipe ou a conta master podem enviar músicas." });
  }
  const songId = String(req.body?.songId || "");
  const catalog = await readCatalog();
  if (!catalog.some((song) => song.id === songId)) return res.status(404).json({ error: "Música não encontrada no catálogo." });
  let ministerId = managesEvent ? String(req.body?.ministerId || actorId) : actorId;
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
  if (!canAccessEvent(workspace, event, actorId)) return res.status(403).json({ error: "Você não participa deste evento." });
  const item = event.songs.find((song) => song.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: "Música não encontrada no evento." });
  if (!canManageEvent(workspace, event, actorId) && item.ministerId !== actorId) return res.status(403).json({ error: "Somente o ministrante, o líder da equipe ou o master pode editar esta música." });
  for (const field of ["key", "description", "message"]) if (typeof req.body?.[field] === "string") item[field] = req.body[field].trim();
  if (canManageEvent(workspace, event, actorId) && typeof req.body?.ministerId === "string") item.ministerId = req.body.ministerId;
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
  const assignments = (song.vocalAssignments || []).filter((item) => item.memberId !== memberId);
  if (req.body?.register === "high" || req.body?.register === "low") {
    const limit = req.body.register === "high" ? event.vocalConfig.highParts : event.vocalConfig.lowParts;
    const part = Number(req.body?.part);
    if (!Number.isInteger(part) || part < 1 || part > limit) return res.status(400).json({ error: "Divisão vocal inválida." });
    assignments.push({ memberId, register: req.body.register, part, updatedAt: new Date().toISOString() });
  } else if (req.body?.register !== "" && req.body?.register !== null) {
    return res.status(400).json({ error: "Divisão vocal inválida." });
  }
  song.vocalAssignments = assignments;
  await saveWorkspace(workspace);
  res.json(song);
});

app.post("/api/events/:eventId/songs/reorder", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  const event = findEvent(workspace, req.params.eventId);
  if (!event) return res.status(404).json({ error: "Evento não encontrado." });
  if (!canManageEvent(workspace, event, actorId)) return res.status(403).json({ error: "Somente o master ou o líder da equipe pode reorganizar o repertório." });
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
  if (!canAccessEvent(workspace, event, actorId)) return res.status(403).json({ error: "Você não participa deste evento." });
  const item = event.songs.find((song) => song.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: "Música não encontrada no evento." });
  if (!canManageEvent(workspace, event, actorId) && item.ministerId !== actorId) return res.status(403).json({ error: "Você não pode remover esta música." });
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
  const allowed = ["originalKey", "title", "artist"];
  const patch = {};
  for (const key of allowed) {
    if (typeof req.body?.[key] === "string") patch[key] = req.body[key].trim();
  }
  if (typeof req.body?.originalKey === "string") {
    patch.keySource = "manual";
    patch.keyConfidence = 100;
  }
  const song = await updateSong(req.params.id, patch);
  if (!song) return res.status(404).json({ error: "Música não encontrada." });
  res.json(song);
});

app.delete("/api/catalog/:id", async (req, res) => {
  const workspace = await readWorkspace();
  const actorId = req.auth.memberId;
  if (!isMaster(workspace, actorId)) return res.status(403).json({ error: "Somente a conta master pode excluir músicas definitivamente." });

  const song = await mutateCatalog((catalog) => {
    const index = catalog.findIndex((item) => item.id === req.params.id);
    return index < 0 ? null : catalog.splice(index, 1)[0];
  });
  if (!song) return res.status(404).json({ error: "Música não encontrada." });

  const jobKey = mediaJobKey(req.params.id);
  lyricsControllers.get(jobKey)?.abort();
  stemControllers.get(jobKey)?.abort();
  lyricsControllers.delete(jobKey);
  stemControllers.delete(jobKey);
  lyricsJobs.delete(jobKey);
  stemJobs.delete(jobKey);
  const audioPath = scopedFileWithLegacyFallback(audioDir, req.params.id + ".mp3");
  keyJobs.get(audioPath)?.controller.abort();
  keyJobs.delete(audioPath);
  const scopedStemsDir = join(churchDirectory(stemsDir), req.params.id);
  const legacyStemsDir = join(stemsDir, req.params.id);
  const songStemsDir = existsSync(scopedStemsDir) ? scopedStemsDir : currentChurchId() === defaultChurch?.id ? legacyStemsDir : scopedStemsDir;
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
  const workspace = await readWorkspace();
  if (!isMaster(workspace, req.auth.memberId)) return res.status(403).json({ error: "Somente a conta master pode editar dados globais da música." });
  const songId = req.params.songId;
  if (!(await readCatalog()).some((song) => song.id === songId)) return res.status(404).json({ error: "Música não encontrada." });
  const input = scopedFileWithLegacyFallback(audioDir, songId + ".mp3");
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
    if (!(await readCatalog()).some((song) => song.id === songId)) return res.status(404).json({ error: "Música não encontrada." });
    res.status(error.status === 503 ? 503 : 500).json({ error: error.status === 503 ? error.message : "Não consegui detectar o tom.", detail: String(error?.message || error).slice(0, 500) });
  }
});

function youtubeDlpArgs(extraArgs = []) {
  const args = ["-m", "yt_dlp", "--js-runtimes", youtubeJsRuntime, "--cache-dir", youtubeCacheDir];
  if (youtubeRemoteComponents) args.push("--remote-components", youtubeRemoteComponents);
  if (youtubeCookiesFile && existsSync(youtubeCookiesFile)) args.push("--cookies", youtubeCookiesFile);
  if (youtubeProxy) args.push("--proxy", youtubeProxy);
  if (youtubeExtractorArgs) args.push("--extractor-args", youtubeExtractorArgs);
  if (youtubePotProviderUrl) args.push("--extractor-args", "youtubepot-bgutilhttp:base_url=" + youtubePotProviderUrl);
  args.push("--no-playlist", ...extraArgs);
  return args;
}

function normalizeYoutubeUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "").trim()); }
  catch { return null; }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port) return null;
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split("/").filter(Boolean);
  let videoId;
  if (["youtu.be", "www.youtu.be"].includes(host) && parts.length === 1) {
    videoId = parts[0];
  } else if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
    if (parsed.pathname.replace(/\/$/, "") === "/watch") videoId = parsed.searchParams.get("v");
    else if (parts.length === 2 && ["shorts", "live", "embed"].includes(parts[0])) videoId = parts[1];
  }
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId || "")) return null;
  return { videoId, url: "https://www.youtube.com/watch?v=" + videoId };
}

function catalogVideo(catalog, videoId) {
  return catalog.find((song) => song.id === videoId || normalizeYoutubeUrl(song.youtubeUrl)?.videoId === videoId);
}

function importFailure(error) {
  const detail = String(error?.message || error);
  if (error?.code === "INVALID_MP3") return { status: 422, code: "INVALID_MP3", error: detail };
  if (error?.code === "YOUTUBE_PROXY_UNAVAILABLE" || (youtubeProxy && /Connection refused|ECONNREFUSED|Unable to connect to proxy|ProxyError/i.test(detail))) {
    return { status: 503, code: "YOUTUBE_PROXY_UNAVAILABLE", error: youtubeProxyError().message };
  }
  if (error?.status === 503) return { status: 503, code: "MEDIA_BUSY", error: detail };
  if (/sign in to confirm.*not a bot|confirm you.re not a bot|HTTP Error 429|Too Many Requests|unable to download video data: HTTP Error 403/i.test(detail)) {
    return {
      status: 502, code: "YOUTUBE_BLOCKED",
      error: "O YouTube está bloqueando importações deste servidor. Tente novamente mais tarde."
    };
  }
  if (/tempo limite/.test(detail)) return { status: 504, code: "IMPORT_TIMEOUT", error: detail };
  return { status: 500, code: "IMPORT_FAILED", error: "Não consegui importar esse vídeo agora. Tente novamente mais tarde." };
}

function busyImportError() {
  return Object.assign(new Error("Há muitas músicas em processamento. Tente novamente em alguns minutos."), { status: 503 });
}

function pruneImportJobs() {
  const now = Date.now();
  const finished = [];
  for (const [id, job] of importJobs) {
    if (!job.finishedAt) continue;
    if (now - job.finishedAt >= IMPORT_JOB_RETENTION_MS) importJobs.delete(id);
    else finished.push(job);
  }
  finished.sort((a, b) => a.finishedAt - b.finishedAt);
  for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_IMPORT_JOBS))) importJobs.delete(job.jobId);
}

function publicImportJob(job) {
  return {
    jobId: job.jobId, status: job.status,
    ...(job.stage ? { stage: job.stage } : {}),
    ...(job.song ? { song: job.song, duplicate: Boolean(job.duplicate) } : {}),
    ...(job.error ? { error: job.error, code: job.code } : {})
  };
}

async function performImport({ videoId, url }, update, addedBy, churchId) {
  const existing = catalogVideo(await readCatalog(churchId), videoId);
  if (existing) return { song: existing, duplicate: true };
  update("queued", "checking");
  await checkYoutubeProxy(youtubeProxy);
  await checkYoutubeProxy(youtubePotProviderUrl);
  const raw = await run(python, youtubeDlpArgs(["--dump-single-json", url]), () => update("processing", "checking"));
  const meta = JSON.parse(raw);
  if (String(meta.id || "") !== videoId) throw new Error("Identificador de vídeo inválido.");
  const output = scopedFile(audioDir, videoId + ".mp3", churchId);
  if (!existsSync(output)) {
    update("queued", "downloading");
    await run(python, youtubeDlpArgs([
      "-f", "bestaudio/best",
      "-x", "--audio-format", "mp3", "--audio-quality", "192K",
      "-o", join(churchDirectory(audioDir, churchId), videoId + ".%(ext)s"), url
    ]), () => update("processing", "downloading"));
  }
  update("queued", "detecting-key");
  let keyData = null;
  try { keyData = await detectKey(output, () => update("processing", "detecting-key")); }
  catch (keyError) { console.warn("Falha ao detectar tom:", keyError?.message || keyError); }
  const song = {
    id: videoId, title: meta.title || "Sem título",
    artist: meta.artist || meta.uploader || meta.channel || "YouTube",
    originalKey: keyData?.key || "C", keyMode: keyData?.mode || "major",
    keyConfidence: Number(keyData?.confidence || 0), keySource: "detected",
    duration: Number(meta.duration || 0), cover: meta.thumbnail || "",
    youtubeUrl: url, audioUrl: "/audio/" + videoId + ".mp3", source: "youtube", addedBy,
    stems: collectStems(videoId, churchId) || undefined, uses: 0
  };
  return mutateCatalog((catalog) => {
    const duplicate = catalogVideo(catalog, videoId);
    if (duplicate) return { song: duplicate, duplicate: true };
    catalog.unshift(song);
    return { song, duplicate: false };
  }, churchId);
}

function importOperation(video, addedBy, churchId) {
  const operationKey = `${churchId}:${video.videoId}`;
  const current = importOperations.get(operationKey);
  if (current) return current;
  if (importOperations.size >= MAX_ACTIVE_IMPORTS || mediaQueue.length >= MAX_QUEUED_MEDIA) throw busyImportError();
  const operation = { status: "queued", stage: "checking", listeners: new Set(), promise: null };
  const update = (status, stage) => {
    operation.status = status;
    operation.stage = stage;
    for (const listener of operation.listeners) listener(status, stage);
  };
  operation.promise = Promise.resolve().then(() => churchContext.run({ churchId }, () => performImport(video, update, addedBy, churchId))).catch((error) => {
    console.error("Falha ao importar vídeo", video.videoId, error);
    throw error;
  }).finally(() => {
    if (importOperations.get(operationKey) === operation) importOperations.delete(operationKey);
  });
  importOperations.set(operationKey, operation);
  return operation;
}

app.post("/api/import", async (req, res) => {
  if (!youtubeImportEnabled) return res.status(410).json({ error: "O envio por link foi substituído pelo upload de MP3.", code: "YOUTUBE_IMPORT_DISABLED" });
  const video = normalizeYoutubeUrl(req.body?.url);
  if (!video) return res.status(400).json({ error: "Cole um link válido de um vídeo do YouTube." });
  pruneImportJobs();
  const existing = catalogVideo(await readCatalog(), video.videoId);
  if (existing) return res.status(409).json({ error: "Essa versão da música já existe na plataforma.", duplicate: true, song: existing });
  const asynchronous = req.body?.asynchronous === true;
  const churchId = req.auth.churchId;
  const operationKey = `${churchId}:${video.videoId}`;
  const ownerKey = `${churchId}:${req.auth.memberId}:${video.videoId}`;
  if (asynchronous) {
    const current = importJobs.get(activeImportJobs.get(ownerKey));
    if (current) return res.status(202).json({ jobId: current.jobId, status: "queued" });
    if (activeImportJobs.size >= MAX_ACTIVE_IMPORTS) return res.status(503).json({ error: busyImportError().message, code: "MEDIA_BUSY" });
  } else if (importOperations.has(operationKey)) {
    return res.status(409).json({ error: "Esta música já está sendo importada. Aguarde a conclusão.", processing: true });
  }
  try {
    const operation = importOperation(video, req.auth.memberId, churchId);
    if (!asynchronous) {
      const result = await operation.promise;
      if (result.duplicate) return res.status(409).json({ error: "Essa versão da música já existe na plataforma.", duplicate: true, song: result.song });
      return res.status(201).json(result.song);
    }
    const job = { jobId: randomUUID(), ownerId: req.auth.memberId, churchId, status: operation.status, stage: operation.stage, finishedAt: 0 };
    importJobs.set(job.jobId, job);
    activeImportJobs.set(ownerKey, job.jobId);
    const progress = (status, stage) => { job.status = status; job.stage = stage; };
    operation.listeners.add(progress);
    void operation.promise.then((result) => {
      job.status = "ready";
      job.song = result.song;
      job.duplicate = result.duplicate;
    }, (error) => {
      const failure = importFailure(error);
      job.status = "error";
      job.error = failure.error;
      job.code = failure.code;
    }).finally(() => {
      operation.listeners.delete(progress);
      job.finishedAt = Date.now();
      if (activeImportJobs.get(ownerKey) === job.jobId) activeImportJobs.delete(ownerKey);
      pruneImportJobs();
    });
    return res.status(202).json({ jobId: job.jobId, status: "queued" });
  } catch (error) {
    const failure = importFailure(error);
    return res.status(failure.status).json({ error: failure.error, code: failure.code });
  }
});

let receivingMp3 = 0;
const receivingMp3Owners = new Set();

app.post("/api/upload-song", (req, res) => {
  const churchId = req.auth.churchId;
  const ownerId = req.auth.memberId;
  const receiverKey = `${churchId}:${ownerId}`;
  if (receivingMp3 >= 4 || receivingMp3Owners.has(receiverKey) || activeImportJobs.size + receivingMp3 >= MAX_ACTIVE_IMPORTS || mediaQueue.length >= MAX_QUEUED_MEDIA) {
    return res.status(503).json({ error: busyImportError().message, code: "MEDIA_BUSY" });
  }
  receivingMp3 += 1;
  receivingMp3Owners.add(receiverKey);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    receivingMp3 -= 1;
    receivingMp3Owners.delete(receiverKey);
  };
  const cleanup = () => { if (req.mp3UploadPath) rmSync(req.mp3UploadPath, { force: true }); };
  req.once("aborted", () => { release(); cleanup(); });
  uploadMp3(req, res, async (uploadError) => {
    try {
      if (req.aborted) { cleanup(); return; }
      if (uploadError) {
        cleanup();
        const tooLarge = uploadError.code === "LIMIT_FILE_SIZE";
        return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? "O MP3 pode ter no máximo 20 MB." : uploadError.code === "INVALID_MP3" ? uploadError.message : "Envie um único arquivo MP3 e os dados da música." });
      }
      if (!req.file?.size) { cleanup(); return res.status(400).json({ error: "Selecione um arquivo MP3 com áudio." }); }
      const hash = await hashMp3(req.file.path);
      const songId = "mp3-" + hash;
      const existing = (await readCatalog(churchId)).find((song) => song.id === songId);
      if (existing) { cleanup(); return res.status(409).json({ error: "Esse MP3 já existe na biblioteca.", duplicate: true, song: existing }); }
      if (req.aborted) { cleanup(); return; }
      const operationKey = `${churchId}:${songId}`;
      const ownerKey = `${churchId}:${ownerId}:${songId}`;
      let operation = importOperations.get(operationKey);
      if (operation) cleanup();
      else {
        if (importOperations.size >= MAX_ACTIVE_IMPORTS || mediaQueue.length >= MAX_QUEUED_MEDIA) throw busyImportError();
        operation = { status: "queued", stage: "preparing", listeners: new Set(), promise: null };
        const update = (status, stage) => {
          operation.status = status; operation.stage = stage;
          for (const listener of operation.listeners) listener(status, stage);
        };
        const input = req.file.path;
        const title = String(req.body?.title || "").trim().slice(0, 160);
        const artist = String(req.body?.artist || "").trim().slice(0, 160);
        const filenameTitle = cleanOriginalName(req.file.originalname).replace(/\.mp3$/i, "").slice(0, 160);
        const output = scopedFile(audioDir, songId + ".mp3", churchId);
        operation.promise = Promise.resolve().then(async () => {
          let committed = false;
          try {
            const metadata = await scheduleMedia(() => {
              update("processing", "preparing");
              return prepareMp3(input, output, executeProcess);
            });
            update("queued", "detecting-key");
            let keyData = null;
            try { keyData = await detectKey(output, () => update("processing", "detecting-key")); }
            catch (error) { console.warn("Falha ao detectar tom do MP3:", error.message); }
            const tags = metadata.tags;
            const song = {
              id: songId, title: title || String(tags.title || tags.TITLE || filenameTitle || "Sem título").slice(0, 160),
              artist: artist || String(tags.artist || tags.ARTIST || "Artista não informado").slice(0, 160),
              source: "upload", audioHash: hash, audioUrl: "/audio/" + songId + ".mp3",
              originalKey: keyData?.key || "C", keyMode: keyData?.mode || "major",
              keyConfidence: Number(keyData?.confidence || 0), keySource: keyData ? "detected" : "manual",
              duration: metadata.duration, cover: "", addedBy: ownerId, uses: 0
            };
            const result = await mutateCatalog((catalog) => {
              const duplicate = catalog.find((entry) => entry.id === songId);
              if (duplicate) return { song: duplicate, duplicate: true };
              catalog.unshift(song); return { song, duplicate: false };
            }, churchId);
            committed = true;
            return result;
          } finally {
            rmSync(input, { force: true });
            if (!committed) rmSync(output, { force: true });
          }
        }).finally(() => {
          if (importOperations.get(operationKey) === operation) importOperations.delete(operationKey);
        });
        importOperations.set(operationKey, operation);
      }
      pruneImportJobs();
      const current = importJobs.get(activeImportJobs.get(ownerKey));
      if (current) return res.status(202).json(publicImportJob(current));
      const job = { jobId: randomUUID(), ownerId, churchId, status: operation.status, stage: operation.stage, finishedAt: 0 };
      importJobs.set(job.jobId, job);
      activeImportJobs.set(ownerKey, job.jobId);
      const progress = (status, stage) => { job.status = status; job.stage = stage; };
      operation.listeners.add(progress);
      void operation.promise.then((result) => {
        job.status = "ready"; job.song = result.song; job.duplicate = result.duplicate;
      }, (error) => {
        console.warn("Falha ao importar MP3:", error.message);
        const failure = importFailure(error);
        job.status = "error";
        job.error = failure.code === "IMPORT_FAILED" ? "Não foi possível preparar o MP3. Tente novamente." : failure.error;
        job.code = failure.code;
      }).finally(() => {
        operation.listeners.delete(progress);
        job.finishedAt = Date.now();
        if (activeImportJobs.get(ownerKey) === job.jobId) activeImportJobs.delete(ownerKey);
        pruneImportJobs();
      });
      return res.status(202).json({ jobId: job.jobId, status: job.status });
    } catch (error) {
      cleanup();
      const failure = error.status === 503 ? importFailure(error) : { status: 500, code: "UPLOAD_FAILED", error: "Não foi possível receber o MP3. Tente novamente." };
      return res.status(failure.status).json({ error: failure.error, code: failure.code });
    } finally { release(); }
  });
});

app.get("/api/import-jobs/:jobId", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  pruneImportJobs();
  const job = importJobs.get(req.params.jobId);
  if (!job || job.ownerId !== req.auth.memberId || job.churchId !== req.auth.churchId) return res.status(404).json({ error: "Esta importação expirou ou o servidor foi reiniciado. Confira o catálogo e tente novamente.", code: "IMPORT_JOB_NOT_FOUND" });
  return res.json(publicImportJob(job));
});

app.get("/api/lyrics/:songId", async (req, res) => {
  const songId = req.params.songId;
  const churchId = req.auth.churchId;
  const jobKey = mediaJobKey(songId, churchId);
  const song = (await readCatalog(churchId)).find((item) => item.id === songId);
  if (!song) return res.status(404).json({ error: "Música não encontrada." });
  const job = lyricsJobs.get(jobKey);
  if (job?.status === "processing" || job?.status === "error") return res.json(job);
  if (Array.isArray(song.lyrics) && song.lyrics.length) {
    return res.json({ status: "ready", lyrics: song.lyrics, model: song.lyricsModel || "", source: song.lyricsSource || "" });
  }
  return res.json(job || { status: "idle" });
});

app.post("/api/lyrics/:songId", async (req, res) => {
  const songId = req.params.songId;
  const churchId = req.auth.churchId;
  const jobKey = mediaJobKey(songId, churchId);
  const song = (await readCatalog(churchId)).find((item) => item.id === songId);
  if (!song) return res.status(404).json({ error: "Música não encontrada." });

  if (Array.isArray(song.lyrics) && song.lyrics.length && req.body?.force !== true) {
    return res.json({ status: "ready", lyrics: song.lyrics, model: song.lyricsModel || "" });
  }

  const current = lyricsJobs.get(jobKey);
  if (current?.status === "processing") return res.status(202).json(current);

  const stemFiles = collectStems(songId, churchId);
  let input = scopedFileWithLegacyFallback(audioDir, songId + ".mp3", churchId);
  let source = "original";

  if (stemFiles?.vocals) {
    const vocalName = decodeURIComponent(stemFiles.vocals.split("/").pop());
    const scopedVocalPath = join(churchDirectory(stemsDir, churchId), songId, vocalName);
    const legacyVocalPath = join(stemsDir, songId, vocalName);
    const vocalPath = existsSync(scopedVocalPath) ? scopedVocalPath : churchId === defaultChurch?.id ? legacyVocalPath : scopedVocalPath;
    if (existsSync(vocalPath)) {
      input = vocalPath;
      source = "vocals";
    }
  }

  if (!existsSync(input)) return res.status(400).json({ error: "Áudio não encontrado para transcrição." });

  const job = { status: "processing", source, queued: true, startedAt: Date.now() };
  const controller = new AbortController();
  let operation;
  try {
    operation = scheduleMedia(async () => {
    if (controller.signal.aborted || !(await readCatalog(churchId)).some((item) => item.id === songId)) return;
    job.queued = false;
    let finalSource = source;
    try {
      let raw = await executeProcess(lyricsPython, [transcribeLyricsScript, input], { signal: controller.signal });
      let result = JSON.parse(raw.trim());

      if (finalSource === "vocals" && lyricsLooksBad(result)) {
        const originalPath = scopedFileWithLegacyFallback(audioDir, songId + ".mp3", churchId);
        if (existsSync(originalPath)) {
          raw = await executeProcess(lyricsPython, [transcribeLyricsScript, originalPath], { signal: controller.signal });
          result = JSON.parse(raw.trim());
          finalSource = "original";
        }
      }

      const lyrics = Array.isArray(result.lines) ? result.lines : [];
      if (!lyrics.length || lyricsLooksBad(result)) throw new Error("Transcrição com baixa confiança.");

      if (controller.signal.aborted) return;
      const saved = await updateSong(songId, { lyrics, lyricsModel: result.model || "", lyricsSource: finalSource }, churchId);
      if (!saved || controller.signal.aborted) return;
      lyricsJobs.set(jobKey, { status: "ready", lyrics, model: result.model || "", source: finalSource });
    } catch (error) {
      if (controller.signal.aborted) return;
      lyricsJobs.set(jobKey, {
        status: "error",
        error: "Não consegui transcrever esta música com qualidade suficiente.",
        detail: String(error?.message || error).slice(-1200)
      });
    }
    }, controller.signal);
  } catch (error) {
    return res.status(error.status === 503 ? 503 : 500).json({ error: error.message });
  }
  lyricsJobs.set(jobKey, job);
  lyricsControllers.set(jobKey, controller);
  void operation.catch((error) => {
    if (!controller.signal.aborted) lyricsJobs.set(jobKey, { status: "error", error: "Não consegui transcrever esta música.", detail: String(error.message).slice(-1200) });
  }).finally(() => {
    if (lyricsControllers.get(jobKey) === controller) lyricsControllers.delete(jobKey);
  });

  res.status(202).json(job);
});

app.get("/api/stems/:songId", async (req, res) => {
  const songId = req.params.songId;
  const churchId = req.auth.churchId;
  const jobKey = mediaJobKey(songId, churchId);
  const catalog = await readCatalog(churchId);
  const song = catalog.find((item) => item.id === songId);
  if (!song) return res.status(404).json({ error: "Música não encontrada." });
  const job = stemJobs.get(jobKey);
  // Files can appear before the catalog update commits. Their URLs become
  // downloadable only after that update, so do not report ready prematurely.
  if (job?.status === "processing") return res.json(job);
  const ready = song.stems || collectStems(songId, churchId);
  if (ready) {
    if (!song.stems && !(await updateSong(songId, { stems: ready }, churchId))) return res.status(404).json({ error: "Música não encontrada." });
    return res.json({ status: "ready", stems: ready });
  }
  return res.json(job || { status: "idle" });
});

app.post("/api/stems/:songId", async (req, res) => {
  const songId = req.params.songId;
  const churchId = req.auth.churchId;
  const jobKey = mediaJobKey(songId, churchId);
  const catalog = await readCatalog(churchId);
  const song = catalog.find((item) => item.id === songId);
  if (!song) return res.status(404).json({ error: "Música não encontrada." });

  const ready = song.stems || collectStems(songId, churchId);
  if (ready) {
    if (!song.stems) await updateSong(songId, { stems: ready }, churchId);
    return res.json({ status: "ready", stems: ready });
  }

  const current = stemJobs.get(jobKey);
  if (current?.status === "processing") return res.status(202).json(current);

  const input = scopedFileWithLegacyFallback(audioDir, songId + ".mp3", churchId);
  if (!existsSync(input)) return res.status(400).json({ error: "Áudio original não encontrado." });

  const outputDir = join(churchDirectory(stemsDir, churchId), songId);
  mkdirSync(outputDir, { recursive: true });
  const job = { status: "processing", progress: 0, queued: true, startedAt: Date.now() };
  const controller = new AbortController();
  let log = "";
  const append = (chunk) => {
    log = (log + chunk.toString()).slice(-12000);
    const match = log.match(/(\d{1,3})%\|/g);
    if (match?.length) job.progress = Math.min(99, Number(match[match.length - 1].replace(/\D/g, "")) || 0);
  };
  let operation;
  try {
    operation = scheduleMedia(async () => {
      if (controller.signal.aborted || !(await readCatalog(churchId)).some((item) => item.id === songId)) return;
      job.queued = false;
      await executeProcess(separatorBin, [
        "-m", "htdemucs_6s.yaml",
        "--output_format", "MP3",
        "--output_bitrate", "192k",
        "--output_dir", outputDir,
        "--model_file_dir", modelsDir,
        input
      ], { signal: controller.signal, onOutput: append });
      if (controller.signal.aborted) return;
      const stems = collectStems(songId, churchId);
      if (!stems) throw new Error("A separação não gerou todas as pistas.");
      const saved = await updateSong(songId, { stems }, churchId);
      if (saved && !controller.signal.aborted) stemJobs.set(jobKey, { status: "ready", progress: 100, stems });
    }, controller.signal);
  } catch (error) {
    return res.status(error.status === 503 ? 503 : 500).json({ error: error.message });
  }
  stemJobs.set(jobKey, job);
  stemControllers.set(jobKey, controller);
  void operation.catch((error) => {
    if (controller.signal.aborted) return;
    log += String(error?.message || error);
    stemJobs.set(jobKey, { status: "error", progress: 0, error: "Falha ao separar instrumentos.", detail: log.slice(-1000) });
  }).finally(() => {
    if (stemControllers.get(jobKey) === controller) stemControllers.delete(jobKey);
  });

  res.status(202).json(job);
});

app.use((error, _req, res, _next) => {
  console.error("Louwy API error", error);
  if (res.headersSent) return;
  if (error?.type === "entity.parse.failed") return res.status(400).json({ error: "JSON inválido." });
  if (error?.type === "entity.too.large") return res.status(413).json({ error: "O conteúdo enviado é muito grande." });
  res.status(500).json({ error: "Ocorreu um erro interno. Tente novamente." });
});

const port = Number(process.env.PORT || 5174);
const server = app.listen(port, "127.0.0.1", (error) => {
  if (error) {
    console.error("Não foi possível iniciar a API:", error);
    void closeDatabase().catch(() => {}).finally(() => process.exit(1));
    return;
  }
  console.log("Louwy API em http://127.0.0.1:" + server.address().port);
});

async function shutdown(signal) {
  console.log(`Encerrando Louwy (${signal})...`);
  server.close(async () => {
    await closeDatabase().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
