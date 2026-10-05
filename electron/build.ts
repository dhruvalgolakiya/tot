import { build, type BuildOptions } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Builds the Mac app's code into dist-app/ (roadmap module 08): the Electron main process and preload (CommonJS:
 * a sandboxed preload can't be an ES module), and the TOT server as one ES module that Electron's own Node runs.
 * npm packages stay out of the bundles: they ship in node_modules, where the server finds codex and Claude Code.
 * Run: npx tsx electron/build.ts (npm run app:dev and app:build do).
 */

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "dist-app");

const shared: BuildOptions = { bundle: true, platform: "node", target: "node24", logLevel: "warning", absWorkingDir: ROOT };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
await Promise.all([
  build({ ...shared, entryPoints: ["electron/main.ts"], outfile: "dist-app/main.cjs", format: "cjs", external: ["electron"] }),
  build({ ...shared, entryPoints: ["electron/preload.ts"], outfile: "dist-app/preload.cjs", format: "cjs", external: ["electron"] }),
  build({ ...shared, entryPoints: ["electron/server-entry.ts"], outfile: "dist-app/server.mjs", format: "esm", packages: "external" }),
]);
for (const file of ["trayTemplate.png", "trayTemplate@2x.png"]) copyFileSync(join(ROOT, "electron", "resources", file), join(OUT, file));
console.log("Built dist-app/ (main.cjs, preload.cjs, server.mjs)");
