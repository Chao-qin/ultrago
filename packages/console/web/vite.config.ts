import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from 'node:fs';

// Vite config for the @bcp/console SPA. Base is "./" because the build is
// served at the site root by Nest's useStaticAssets (no subpath). Hash
// router is used at runtime, so we don't need a history fallback here.
// The build output is placed at `packages/console/dist-web` (one level up
// from this config file) so the Nest main.js can serve it with a stable
// relative path regardless of CWD.
export default defineConfig({
  base: "./",
  plugins: [react(), {
    name: 'magic-ui-license',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'third-party-notices.txt',
        source: readFileSync(path.resolve(__dirname, 'src/components/magicui/LICENSE'), 'utf8'),
      });
    },
  }],
  build: {
    outDir: path.resolve(__dirname, "../dist-web"),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      // Two entry documents. `studio.html` hosts the embedded Prisma Studio,
      // which the 数据库 page loads in an iframe — it needs its own document
      // because it takes over `location.hash` (see src/studio-main.tsx).
      input: {
        main: path.resolve(__dirname, "index.html"),
        studio: path.resolve(__dirname, "studio.html"),
      },
    },
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:8790",
    },
  },
});
