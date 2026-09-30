const STORAGE_KEY = "louwy-church-slug";
const DEFAULT_ROOT_DOMAIN = "louwy.com.br";
let installed = false;

function normalizeSlug(value: string) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);
}

export function rootDomain() {
  return String(import.meta.env.VITE_ROOT_DOMAIN || DEFAULT_ROOT_DOMAIN).toLowerCase();
}

export function isLocalDevelopmentHost(hostname = window.location.hostname) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost");
}

export function isInstitutionalHostname(hostname = window.location.hostname) {
  const host = hostname.toLowerCase();
  const root = rootDomain();
  return host === root || host === `www.${root}`;
}
export function churchSlugFromHostname(hostname = window.location.hostname) {
  const host = hostname.toLowerCase();
  const root = rootDomain();
  if (host.endsWith(`.${root}`)) {
    const prefix = host.slice(0, -(root.length + 1));
    if (prefix && !prefix.includes(".")) return normalizeSlug(prefix);
  }
  if (host.endsWith(".localhost")) {
    const prefix = host.slice(0, -".localhost".length);
    if (prefix && !prefix.includes(".")) return normalizeSlug(prefix);
  }
  return "";
}

export function currentChurchSlug() {
  const fromHost = churchSlugFromHostname();
  if (fromHost) return fromHost;
  if (isInstitutionalHostname()) return "";
  try { return normalizeSlug(localStorage.getItem(STORAGE_KEY) || ""); }
  catch { return ""; }
}

export function setCurrentChurchSlug(value: string) {
  const slug = normalizeSlug(value);
  try {
    if (slug) localStorage.setItem(STORAGE_KEY, slug);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* Storage may be unavailable. */ }
  return slug;
}
export function institutionalUrl(path = "") {
  const root = rootDomain();
  if (isLocalDevelopmentHost()) return `${window.location.protocol}//${window.location.host}${path}`;
  return `https://${root}${path}`;
}

export function churchUrl(value: string) {
  const slug = normalizeSlug(value);
  const root = rootDomain();
  const { protocol, hostname, port, origin } = window.location;
  if (isLocalDevelopmentHost(hostname)) {
    return `${protocol}//${slug}.localhost${port ? `:${port}` : ""}`;
  }
  const configured = String(import.meta.env.VITE_CHURCH_SUBDOMAINS || "").toLowerCase() === "true";
  const subdomainsEnabled = import.meta.env.PROD || configured;
  return subdomainsEnabled ? `https://${slug}.${root}` : origin;
}

export function installChurchFetch() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const sourceUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(sourceUrl, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) {
      return nativeFetch(input, init);
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers || undefined).forEach((value, key) => headers.set(key, value));
    const slug = currentChurchSlug();
    if (slug && !headers.has("X-Church-Slug")) headers.set("X-Church-Slug", slug);
    if (input instanceof Request) {
      return nativeFetch(new Request(input, { ...init, headers }));
    }
    return nativeFetch(input, { ...init, headers });
  };
}
