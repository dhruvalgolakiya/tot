import { build, type BuildOptions, type Plugin } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Builds the Mac app's code into dist-app/ (roadmap module 08): the Electron main process and preload (CommonJS:
 * a sandboxed preload can't be an ES module), and the TOT server as one ES module that Electron's own Node runs.
 * npm packages stay out of the bundles: they ship in node_modules, where the server finds codex and Claude Code.
 * Run: npx tsx apps/desktop/build.ts (npm run app:dev and app:build do).
 */

const ROOT = import.meta.dirname;
const OUT = join(ROOT, "dist-app");

/** Every npm package stays out of the server bundle; this repo's own (@tot/server, @tot/shared) go in. */
const externalPackages: Plugin = {
  name: "tot-external-packages",
  setup: (build) => build.onResolve({ filter: /^[^./]/ }, ({ path }) => (path.startsWith("@tot/") ? undefined : { path, external: true })),
};

const shared: BuildOptions = { bundle: true, platform: "node", target: "node24", logLevel: "warning", absWorkingDir: ROOT };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
await Promise.all([
  // electron-updater ships in node_modules, as electron-builder expects, rather than inside main.cjs.
  build({ ...shared, entryPoints: ["main.ts"], outfile: "dist-app/main.cjs", format: "cjs", external: ["electron", "electron-updater"] }),
  build({ ...shared, entryPoints: ["preload.ts"], outfile: "dist-app/preload.cjs", format: "cjs", external: ["electron"] }),
  build({ ...shared, entryPoints: ["server-entry.ts"], outfile: "dist-app/server.mjs", format: "esm", plugins: [externalPackages] }),
]);
for (const file of ["trayTemplate.png", "trayTemplate@2x.png"]) copyFileSync(join(ROOT, "resources", file), join(OUT, file));
console.log("Built dist-app/ (main.cjs, preload.cjs, server.mjs)");
