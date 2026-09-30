import {
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  ROOT_DOMAIN,
  churchPublicUrl,
  isLocalDevelopmentRequest,
  requestedChurchSlug,
  resolveChurch,
  sameChurchHost,
  validateChurchSlug,
} from "./church-context.mjs";

const COOKIE_NAME = "louvelab_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const PASSWORD_MIN_LENGTH = 6;

export function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) digits = digits.slice(2);
  return digits;
}

const isValidPhone = (phone) => phone.length === 10 || phone.length === 11;
const base64url = (value) => Buffer.from(value).toString("base64url");
const sign = (value, secret) => createHmac("sha256", secret).update(value).digest("base64url");
function readSecret(secretPath) {
  if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(48).toString("hex"), { mode: 0o600 });
  return readFileSync(secretPath, "utf8").trim();
}

function parseCookies(header) {
  const output = Object.create(null);
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) {
      try { output[key] = decodeURIComponent(value); }
      catch { /* Ignore malformed cookies. */ }
    }
  }
  return output;
}

function hashPassword(password, salt = randomBytes(16).toString("base64")) {
  return { salt, hash: scryptSync(password, salt, 64).toString("base64") };
}

function verifyPassword(password, member) {
  if (!member?.passwordHash || !member?.passwordSalt) return false;
  try {
    const actual = Buffer.from(member.passwordHash, "base64");
    const candidate = scryptSync(password, member.passwordSalt, actual.length);
    return actual.length === candidate.length && timingSafeEqual(actual, candidate);
  } catch {
    return false;
  }
}

const wrap = (handler) => async (req, res, next) => {
  try { await handler(req, res, next); }
  catch (error) { next(error); }
};

function passwordError(password, confirmation) {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) return "A senha deve ter pelo menos 6 caracteres.";
  if (password.length > 1024) return "A senha deve ter no máximo 1024 caracteres.";
  if (confirmation !== undefined && password !== confirmation) return "As senhas não coincidem.";
  return "";
}

function defaultProfile() {
  return { folders: [], library: [], playlists: [] };
}

function newChurchWorkspace({ organizationName, master }) {
  return {
    branding: {
      productName: "Louwy",
      organizationName,
      logoUrl: "/icons/louwy-192.png",
      accentColor: "#d8ff55",
    },
    members: [master],
    teams: [],
    events: [],
    notifications: [],
    subscription: {
      planId: "free",
      status: "active",
      requestedPlanId: "",
      requestedAt: "",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      provider: "",
      providerCustomerId: "",
      providerSubscriptionId: "",
    },
    profiles: { [master.id]: defaultProfile() },
  };
}

export function createAuth({
  readWorkspace,
  saveWorkspace,
  secretPath,
  findChurchBySlug,
  getChurchById,
  getDefaultChurch,
  createChurch,
}) {
  const secret = readSecret(secretPath);
  const attempts = new Map();

  function safeMember(member, church = null) {
    if (!member) return null;
    return {
      id: member.id,
      name: member.name,
      email: member.email || "",
      phone: member.phone || "",
      avatarUrl: member.avatarUrl || "",
      role: member.role,
      permissions: Array.isArray(member.permissions) ? member.permissions : [],
      functions: Array.isArray(member.functions) ? member.functions : [],
      vocalRegister: member.vocalRegister,
      active: member.active !== false,
      hasPassword: Boolean(member.passwordHash),
      firstAccess: !member.passwordHash,
      churchId: church?.id || "",
      churchSlug: church?.slug || "",
      churchName: church?.name || "",
    };
  }

  function issueToken(member, church) {
    const payload = {
      sub: member.id,
      cid: church.id,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      ver: Number(member.authVersion || 1),
    };
    const body = base64url(JSON.stringify(payload));
    return body + "." + sign(body, secret);
  }

  function verifyToken(token) {
    if (!token || !token.includes(".")) return null;
    const [body, signature] = token.split(".");
    const expected = sign(body, secret);
    const a = Buffer.from(signature || "");
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      if (!payload.sub || !payload.cid || Number(payload.exp || 0) <= Math.floor(Date.now() / 1000)) return null;
      return payload;
    } catch {
      return null;
    }
  }

  const secureRequest = (req) => req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";

  function setSession(req, res, member, church) {
    const parts = [
      COOKIE_NAME + "=" + encodeURIComponent(issueToken(member, church)),
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=" + SESSION_TTL_SECONDS,
    ];
    const host = String(req.hostname || req.headers.host || "").split(":")[0].toLowerCase();
    if (host === ROOT_DOMAIN || host.endsWith(`.${ROOT_DOMAIN}`)) parts.push(`Domain=.${ROOT_DOMAIN}`);
    if (secureRequest(req)) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  }

  function clearSession(req, res) {
    const parts = [COOKIE_NAME + "=", "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
    const host = String(req.hostname || req.headers.host || "").split(":")[0].toLowerCase();
    if (host === ROOT_DOMAIN || host.endsWith(`.${ROOT_DOMAIN}`)) parts.push(`Domain=.${ROOT_DOMAIN}`);
    if (secureRequest(req)) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  }

  async function requestChurch(req, allowDefault = false) {
    return resolveChurch(req, { findChurchBySlug, getDefaultChurch, allowDefault });
  }

  async function authenticate(req) {
    const cookies = parseCookies(req.headers.cookie);
    const payload = verifyToken(cookies[COOKIE_NAME]);
    if (!payload) return null;
    const church = await getChurchById(payload.cid);
    if (!church || !sameChurchHost(req, church)) return null;
    const requested = requestedChurchSlug(req);
    if (requested && requested !== church.slug) return null;
    const workspace = await readWorkspace(church.id);
    const member = workspace.members.find((item) => item.id === payload.sub && item.active !== false);
    if (!member || Number(member.authVersion || 1) !== Number(payload.ver || 1)) return null;
    return { workspace, member, church };
  }

  const requireAuth = wrap(async (req, res, next) => {
    const authenticated = await authenticate(req);
    if (!authenticated) return res.status(401).json({ error: "Sessão expirada ou igreja incorreta. Entre novamente." });
    req.auth = {
      memberId: authenticated.member.id,
      churchId: authenticated.church.id,
      church: authenticated.church,
      member: safeMember(authenticated.member, authenticated.church),
    };
    next();
  });

  function findByPhone(workspace, value) {
    const phone = normalizePhone(value);
    return {
      phone,
      member: workspace.members.find((item) => item.active !== false && normalizePhone(item.phoneNormalized || item.phone) === phone),
    };
  }

  const attemptKey = (req, churchId, phone) => `${req.ip || req.socket?.remoteAddress || "local"}:${churchId}:${phone}`;
  const blocked = (req, churchId, phone) => {
    const record = attempts.get(attemptKey(req, churchId, phone));
    return Boolean(record && record.blockedUntil > Date.now());
  };
  function recordFailure(req, churchId, phone) {
    const key = attemptKey(req, churchId, phone);
    const current = attempts.get(key) || { count: 0, blockedUntil: 0 };
    current.count += 1;
    if (current.count >= 7) {
      current.blockedUntil = Date.now() + 5 * 60 * 1000;
      current.count = 0;
    }
    attempts.set(key, current);
  }

  async function resolvedWorkspace(req, allowDefault = false) {
    const context = await requestChurch(req, allowDefault);
    if (!context.church) {
      const error = context.explicit ? "Esta igreja não está cadastrada no Louwy." : "Informe a igreja para continuar.";
      return { ...context, workspace: null, error };
    }
    return { ...context, workspace: await readWorkspace(context.church.id), error: "" };
  }

  function registerRoutes(app) {
    app.get("/api/church-context", wrap(async (req, res) => {
      const context = await requestChurch(req, isLocalDevelopmentRequest(req));
      res.json({
        resolved: Boolean(context.church),
        requestedSlug: context.requestedSlug,
        explicit: context.explicit,
        rootDomain: ROOT_DOMAIN,
        church: context.church,
        registrationAllowed: true,
      });
    }));

    app.get("/api/auth/bootstrap-status", wrap(async (req, res) => {
      const context = await resolvedWorkspace(req, isLocalDevelopmentRequest(req));
      if (!context.church) return res.json({ churchFound: false, requestedSlug: context.requestedSlug, needsMasterSetup: false });
      const master = context.workspace.members.find((item) => item.role === "master" && item.active !== false);
      res.json({
        churchFound: true,
        church: context.church,
        needsMasterSetup: !master || !normalizePhone(master.phoneNormalized || master.phone),
      });
    }));
    app.post("/api/auth/register-church", wrap(async (req, res) => {
      const organizationName = String(req.body?.organizationName || "").trim().slice(0, 120);
      const masterName = String(req.body?.name || "").trim().slice(0, 80);
      const phone = normalizePhone(req.body?.phone);
      const slugValidation = validateChurchSlug(req.body?.churchSlug || organizationName);
      const credentialError = !isValidPhone(phone)
        ? "Informe um celular válido com DDD."
        : passwordError(req.body?.password, req.body?.confirmation);
      const error = !organizationName ? "Informe o nome da igreja."
        : !masterName ? "Informe o nome do responsável."
          : slugValidation.error || credentialError;
      if (error) return res.status(400).json({ error, slug: slugValidation.slug });

      const credentials = hashPassword(String(req.body.password));
      const master = {
        id: randomUUID(),
        name: masterName,
        email: String(req.body?.email || "").trim(),
        phone,
        phoneNormalized: phone,
        passwordSalt: credentials.salt,
        passwordHash: credentials.hash,
        authVersion: 1,
        role: "master",
        permissions: ["branding"],
        functions: ["Gestor"],
        active: true,
      };
      const workspace = newChurchWorkspace({ organizationName, master });
      let church;
      try {
        church = await createChurch({
          slug: slugValidation.slug,
          name: organizationName,
          workspace,
          catalog: [],
        });
      } catch (issue) {
        if (issue?.code === "CHURCH_SLUG_TAKEN") return res.status(409).json({ error: issue.message, slug: slugValidation.slug });
        throw issue;
      }
      setSession(req, res, master, church);
      res.status(201).json({
        church,
        member: safeMember(master, church),
        redirectUrl: churchPublicUrl(church.slug, req),
      });
    }));

    app.post("/api/auth/bootstrap-master", wrap(async (req, res) => {
      const context = await resolvedWorkspace(req, isLocalDevelopmentRequest(req));
      if (!context.church) return res.status(404).json({ error: context.error });
      const master = context.workspace.members.find((item) => item.role === "master" && item.active !== false);
      if (!master) return res.status(404).json({ error: "Conta master não encontrada." });
      if (normalizePhone(master.phoneNormalized || master.phone)) return res.status(409).json({ error: "A conta master já foi configurada." });
      const phone = normalizePhone(req.body?.phone);
      const error = !isValidPhone(phone) ? "Informe um celular válido com DDD." : passwordError(req.body?.password, req.body?.confirmation);
      if (error) return res.status(400).json({ error });
      const credentials = hashPassword(String(req.body.password));
      master.name = String(req.body?.name || "Conta Master").trim() || "Conta Master";
      master.phone = phone;
      master.phoneNormalized = phone;
      master.passwordSalt = credentials.salt;
      master.passwordHash = credentials.hash;
      master.authVersion = Number(master.authVersion || 0) + 1;
      await saveWorkspace(context.church.id, context.workspace);
      setSession(req, res, master, context.church);
      res.status(201).json({ member: safeMember(master, context.church), church: context.church });
    }));

    app.post("/api/auth/identify", wrap(async (req, res) => {
      const context = await resolvedWorkspace(req, isLocalDevelopmentRequest(req));
      if (!context.church) return res.status(404).json({ error: context.error });
      const { phone, member } = findByPhone(context.workspace, req.body?.phone);
      if (!isValidPhone(phone)) return res.status(400).json({ error: "Informe um celular válido com DDD." });
      if (!member) return res.status(404).json({ error: "Este celular não está cadastrado nesta igreja." });
      res.json({
        exists: true,
        firstAccess: !member.passwordHash,
        church: context.church,
        member: { id: member.id, name: member.name },
      });
    }));
    app.post("/api/auth/first-access", wrap(async (req, res) => {
      const context = await resolvedWorkspace(req, isLocalDevelopmentRequest(req));
      if (!context.church) return res.status(404).json({ error: context.error });
      const { phone, member } = findByPhone(context.workspace, req.body?.phone);
      if (!member) return res.status(404).json({ error: "Este celular não está cadastrado nesta igreja." });
      if (member.passwordHash) return res.status(409).json({ error: "Esta conta já possui senha. Faça o login normal." });
      const error = passwordError(req.body?.password, req.body?.confirmation);
      if (error) return res.status(400).json({ error });
      const credentials = hashPassword(String(req.body.password));
      member.phone = phone;
      member.phoneNormalized = phone;
      member.passwordSalt = credentials.salt;
      member.passwordHash = credentials.hash;
      member.authVersion = Number(member.authVersion || 0) + 1;
      await saveWorkspace(context.church.id, context.workspace);
      setSession(req, res, member, context.church);
      res.json({ member: safeMember(member, context.church), church: context.church });
    }));

    app.post("/api/auth/login", wrap(async (req, res) => {
      const context = await resolvedWorkspace(req, isLocalDevelopmentRequest(req));
      if (!context.church) return res.status(404).json({ error: context.error });
      const { phone, member } = findByPhone(context.workspace, req.body?.phone);
      if (!isValidPhone(phone)) return res.status(400).json({ error: "Informe um celular válido com DDD." });
      if (blocked(req, context.church.id, phone)) return res.status(429).json({ error: "Muitas tentativas. Aguarde alguns minutos." });
      if (!member || !member.passwordHash || !verifyPassword(String(req.body?.password || ""), member)) {
        recordFailure(req, context.church.id, phone);
        return res.status(401).json({ error: "Celular ou senha incorretos." });
      }
      attempts.delete(attemptKey(req, context.church.id, phone));
      setSession(req, res, member, context.church);
      res.json({ member: safeMember(member, context.church), church: context.church });
    }));

    app.get("/api/auth/me", requireAuth, (req, res) => {
      res.json({ member: req.auth.member, church: req.auth.church });
    });

    app.post("/api/auth/logout", (req, res) => {
      clearSession(req, res);
      res.json({ ok: true });
    });

    app.post("/api/auth/change-password", requireAuth, wrap(async (req, res) => {
      const workspace = await readWorkspace(req.auth.churchId);
      const member = workspace.members.find((item) => item.id === req.auth.memberId);
      if (!member || !verifyPassword(String(req.body?.currentPassword || ""), member)) {
        return res.status(401).json({ error: "Senha atual incorreta." });
      }
      const error = passwordError(req.body?.newPassword, req.body?.confirmation);
      if (error) return res.status(400).json({ error });
      const credentials = hashPassword(String(req.body.newPassword));
      member.passwordSalt = credentials.salt;
      member.passwordHash = credentials.hash;
      member.authVersion = Number(member.authVersion || 0) + 1;
      await saveWorkspace(req.auth.churchId, workspace);
      setSession(req, res, member, req.auth.church);
      res.json({ ok: true });
    }));

    app.post("/api/auth/reset-member/:id", requireAuth, wrap(async (req, res) => {
      const workspace = await readWorkspace(req.auth.churchId);
      const actor = workspace.members.find((item) => item.id === req.auth.memberId);
      if (actor?.role !== "master") return res.status(403).json({ error: "Somente a conta master pode resetar senhas." });
      const member = workspace.members.find((item) => item.id === req.params.id);
      if (!member || member.role === "master") return res.status(404).json({ error: "Membro não encontrado." });
      delete member.passwordSalt;
      delete member.passwordHash;
      member.authVersion = Number(member.authVersion || 0) + 1;
      await saveWorkspace(req.auth.churchId, workspace);
      res.json({ member: safeMember(member, req.auth.church) });
    }));
  }

  return {
    registerRoutes,
    requireAuth,
    safeMember,
    normalizePhone,
    requestChurch,
  };
}
