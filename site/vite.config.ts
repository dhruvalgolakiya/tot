import { defineConfig, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The docs are their own page (docs/index.html) with client-side routing, so every /docs/<page> URL serves that one
 * file. On Vercel, vercel.json's rewrites do this; here the same rule runs in `npm run site` and `vite preview`.
 */
function docsFallback(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    const [pathname, query] = (req.url ?? "").split("?");
    // /docs, /docs/ and /docs/<page>, but not files (anything with a dot in its last segment).
    if (pathname && /^\/docs(\/[^.]*)?$/.test(pathname)) req.url = `/docs/index.html${query ? `?${query}` : ""}`;
    next();
  };
  return {
    name: "tot-docs-fallback",
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
  };
}

// The public landing page and its docs: a static site with no API and no sign-in, built from TOT's own design
// tokens and mascots. `npm run site` to work on it, `npm run site:build` for site/dist.
export default defineConfig({
  root: here("."),
  publicDir: here("../public"),
  plugins: [docsFallback(), react(), tailwindcss()],
  resolve: {
    alias: { "@shared": here("../shared") },
  },
  server: { port: 5190, strictPort: true },
  preview: { port: 5190, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: { input: { main: here("index.html"), docs: here("docs/index.html") } },
  },
});
