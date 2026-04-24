import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite dev serves on 127.0.0.1:5173 and proxies /api/* to the Studio Hono
// server on :4000. Production build goes straight to `dist/` and is copied
// into arkor's package dist/ by `scripts/copy-studio-assets.mjs`.
export default defineConfig({
  plugins: [react()],
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
