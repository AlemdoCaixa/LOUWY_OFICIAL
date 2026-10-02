import { createConnection } from "node:net";

export function youtubeProxyError() {
  return Object.assign(new Error("A conexão de importação do YouTube está indisponível. Confira se o Mac do proxy está ligado e conectado à internet e tente novamente."), {
    status: 503,
    code: "YOUTUBE_PROXY_UNAVAILABLE",
  });
}

// Fail before invoking yt-dlp when the configured tunnel is down. Do not
// silently switch to the server's IP: YouTube may block that separate route.
export async function checkYoutubeProxy(value, timeoutMs = 3000) {
  if (!value) return;
  let proxy;
  try { proxy = new URL(value); } catch { throw youtubeProxyError(); }
  const defaults = { "http:": 80, "https:": 443, "socks:": 1080, "socks4:": 1080, "socks4a:": 1080, "socks5:": 1080, "socks5h:": 1080 };
  if (!proxy.hostname || !defaults[proxy.protocol]) throw youtubeProxyError();
  const host = proxy.hostname.replace(/^\[|\]$/g, "");
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host, port: Number(proxy.port || defaults[proxy.protocol]) });
    const timer = setTimeout(() => { socket.destroy(); reject(youtubeProxyError()); }, timeoutMs);
    const finish = (error) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(youtubeProxyError());
      else resolve();
    };
    socket.once("connect", () => finish());
    socket.once("error", finish);
  });
}
