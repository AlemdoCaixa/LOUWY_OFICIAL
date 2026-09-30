import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      devOptions: { enabled: true },
      workbox: {
        // Attachment links must reach the authenticated API, including direct navigations.
        navigateFallbackDenylist: [
          /^\/(?:api|audio|stems|tenant-branding|member-avatars|pwa)(?:\/|$)/,
          /^\/manifest\.webmanifest$/
        ]
      },
      includeAssets: [
        "favicon.ico",
        "icons/favicon-16.png",
        "icons/favicon-32.png",
        "icons/favicon-48.png",
        "icons/apple-touch-icon.png",
        "icons/louwy-192.png",
        "icons/louwy-512.png",
        "icons/louwy-maskable-512.png",
        "icons/institutional-192.png",
        "icons/institutional-512.png",
        "icons/institutional-maskable-512.png",
        "icons/institutional-apple-touch.png",
        "branding/louwy-institucional-v2.svg"
      ],
      manifest: false
    })
  ],
  server: {
    host: "0.0.0.0",
    allowedHosts: ["louwy.com.br", ".louwy.com.br"],
    proxy: {
      "/api": "http://127.0.0.1:5174",
      "/audio": "http://127.0.0.1:5174",
      "/stems": "http://127.0.0.1:5174",
      "/tenant-branding": "http://127.0.0.1:5174",
      "/member-avatars": "http://127.0.0.1:5174",
      "/manifest.webmanifest": { target: "http://127.0.0.1:5174", changeOrigin: false },
      "/pwa": { target: "http://127.0.0.1:5174", changeOrigin: false }
    }
  }
});
