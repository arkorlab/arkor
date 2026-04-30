import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Source of truth for this path is `packages/arkor/src/core/credentials.ts`
// (`studioTokenPath`). Cross-package imports complicate the Vite config build
// so we mirror the constant here; if it ever changes, update both sides.
const STUDIO_TOKEN_PATH = join(homedir(), ".arkor", "studio-token");

function htmlAttrEscape(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&"
      ? "&amp;"
      : ch === "<"
        ? "&lt;"
        : ch === ">"
          ? "&gt;"
          : ch === '"'
            ? "&quot;"
            : "&#39;",
  );
}

/**
 * Inject the per-launch Studio CSRF token into served `index.html` so the
 * SPA's `apiFetch` can attach it. `arkor dev` writes the token to
 * `~/.arkor/studio-token` on launch; we re-read on every request so that
 * starting `arkor dev` after Vite is picked up on the next reload.
 *
 * `apply: "serve"` constrains this to the dev server. If it ran during
 * `vite build` it would bake the current per-launch token into `dist/
 * index.html`, and since `document.querySelector` returns the first match,
 * the stale baked tag would shadow the runtime tag injected by
 * `buildStudioApp` and every `/api/*` call would 403.
 */
function arkorStudioToken(): Plugin {
  return {
    name: "arkor-studio-token",
    apply: "serve",
    enforce: "pre",
    async transformIndexHtml(html) {
      let token: string;
      try {
        token = (await readFile(STUDIO_TOKEN_PATH, "utf8")).trim();
      } catch {
        // `arkor dev` not running yet — leave the SPA token-less and let
        // the Studio server's 403 surface the wiring problem on first call.
        return html;
      }
      if (!token) return html;
      const meta = `<meta name="arkor-studio-token" content="${htmlAttrEscape(token)}">`;
      const idx = html.indexOf("</head>");
      if (idx === -1) return `${meta}${html}`;
      return `${html.slice(0, idx)}${meta}${html.slice(idx)}`;
    },
  };
}

// Vite dev serves on 127.0.0.1:5173 and proxies /api/* to the Studio Hono
// server on :4000. Production build goes straight to `dist/` and is copied
// into arkor's package dist/ by `scripts/copy-studio-assets.mjs`.
export default defineConfig({
  plugins: [react(), tailwindcss(), arkorStudioToken()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4000",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
