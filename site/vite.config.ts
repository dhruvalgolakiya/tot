import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The public landing page: a static site with no API and no sign-in, built from TOT's own
// design tokens and mascots. `npm run site` to work on it, `npm run site:build` for site/dist.
export default defineConfig({
  root: here("."),
  publicDir: here("../public"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@shared": here("../shared") },
  },
  server: { port: 5190, strictPort: true },
  preview: { port: 5190, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
