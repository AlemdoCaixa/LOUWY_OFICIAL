import { normalizeChurchSlug } from "./state-db.mjs";

export const ROOT_DOMAIN = String(process.env.ROOT_DOMAIN || "louwy.com.br")
  .toLowerCase()
  .replace(/^\.+|\.+$/g, "");

const RESERVED_SLUGS = new Set([
  "www", "api", "app", "admin", "mail", "smtp", "ftp", "cdn", "static",
  "assets", "status", "suporte", "support", "ajuda", "help", "conta",
  "login", "cadastro", "register", "dashboard", "loja", "blog",
]);

export function validateChurchSlug(value) {
  const slug = normalizeChurchSlug(value);
  if (slug.length < 3) return { slug, error: "O endereço deve ter pelo menos 3 caracteres." };
  if (slug.length > 48) return { slug, error: "O endereço deve ter no máximo 48 caracteres." };
  if (RESERVED_SLUGS.has(slug)) return { slug, error: "Este endereço é reservado pelo Louwy." };
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    return { slug, error: "Use somente letras, números e hífen." };
  }
  return { slug, error: "" };
}
export function hostWithoutPort(req) {
  return String(req.hostname || req.headers.host || "")
    .split(":")[0]
    .trim()
    .toLowerCase();
}

export function isLocalDevelopmentRequest(req) {
  const host = hostWithoutPort(req);
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost");
}

export function isRootDomainHost(req) {
  const host = hostWithoutPort(req);
  return host === ROOT_DOMAIN || host === `www.${ROOT_DOMAIN}`;
}

export function churchSlugFromHost(req) {
  const host = hostWithoutPort(req);
  if (!host) return "";
  if (host === ROOT_DOMAIN || host === `www.${ROOT_DOMAIN}`) return "";
  if (host.endsWith(`.${ROOT_DOMAIN}`)) {
    const prefix = host.slice(0, -(ROOT_DOMAIN.length + 1));
    if (prefix && !prefix.includes(".")) return normalizeChurchSlug(prefix);
  }
  if (host.endsWith(".localhost")) {
    const prefix = host.slice(0, -".localhost".length);
    if (prefix && !prefix.includes(".")) return normalizeChurchSlug(prefix);
  }
  return "";
}

export function requestedChurchSlug(req) {
  const hostSlug = churchSlugFromHost(req);
  if (hostSlug) return hostSlug;
  const header = req.get?.("x-church-slug") || req.headers?.["x-church-slug"];
  return normalizeChurchSlug(header || req.query?.church || req.body?.churchSlug || "");
}
export function churchPublicUrl(slug, req) {
  const normalized = normalizeChurchSlug(slug);
  const protocol = req?.secure || String(req?.headers?.["x-forwarded-proto"] || "").startsWith("https") ? "https" : "http";
  const host = hostWithoutPort(req);
  if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1") {
    const port = String(req?.headers?.host || "").includes(":") ? `:${String(req.headers.host).split(":").pop()}` : "";
    return `${protocol}://${normalized}.localhost${port}`;
  }
  return `https://${normalized}.${ROOT_DOMAIN}`;
}

export async function resolveChurch(req, { findChurchBySlug, getDefaultChurch, allowDefault = true }) {
  const requestedSlug = requestedChurchSlug(req);
  if (requestedSlug) {
    const church = await findChurchBySlug(requestedSlug);
    return { church, requestedSlug, explicit: true };
  }
  const church = allowDefault ? await getDefaultChurch() : null;
  return { church, requestedSlug: church?.slug || "", explicit: false };
}

export function sameChurchHost(req, church) {
  if (isLocalDevelopmentRequest(req)) {
    const requested = requestedChurchSlug(req);
    return !requested || requested === church?.slug;
  }
  const hostSlug = churchSlugFromHost(req);
  return Boolean(hostSlug && hostSlug === church?.slug);
}
