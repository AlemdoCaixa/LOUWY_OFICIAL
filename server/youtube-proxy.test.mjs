import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { once } from "node:events";
import { checkYoutubeProxy } from "./youtube-proxy.mjs";

test("no configured proxy leaves the direct route available", async () => {
  await checkYoutubeProxy("");
});

test("live tunnel is accepted; closed tunnel returns an actionable error without credentials", async () => {
  const server = createServer((socket) => socket.end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `socks5h://private:secret@127.0.0.1:${server.address().port}`;
  try { await checkYoutubeProxy(url); }
  finally { await new Promise((resolve) => server.close(resolve)); }
  await assert.rejects(checkYoutubeProxy(url), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "YOUTUBE_PROXY_UNAVAILABLE");
    assert.match(error.message, /Mac.*ligado/);
    assert.doesNotMatch(error.message, /private|secret/);
    return true;
  });
});

test("invalid configuration fails without invoking a downloader", async () => {
  for (const value of ["invalid", "file:///tmp/private", "ftp://user:password@localhost"]) {
    await assert.rejects(checkYoutubeProxy(value), { code: "YOUTUBE_PROXY_UNAVAILABLE" });
  }
});
