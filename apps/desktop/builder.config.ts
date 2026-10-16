import { createRequire } from "node:module";
import { join } from "node:path";
import type { Configuration } from "electron-builder";
import { checkPeers } from "./peer-deps.ts";

/**
 * Packaging the Mac app (roadmap module 08): TOT.app for Apple silicon, as a .dmg and a .zip in release/.
 *
 * - No asar: the server runs from real files (dist/ as its working directory, codex and Claude Code spawned
 *   from node_modules), at the cost of a bigger app.
 * - Signed ad hoc unless a Developer ID is given through CSC_LINK or CSC_NAME, which also turns on the
 *   hardened runtime. `npm run app:release` (release.sh) gives one and notarizes with an App Store
 *   Connect API key (APPLE_API_KEY…), so the downloaded .dmg opens with no Gatekeeper warning. Codex's and
 *   Claude Code's own binaries keep their vendors' signatures.
 * - Updates come from the GitHub releases of dhruvalgolakiya/tot (`publish`): the build writes app-update.yml
 *   into the app, for electron-updater (updates.ts), and latest-mac.yml plus the zip's .blockmap into release/.
 *   The build never uploads anything itself (`--publish never`); `npm run app:publish` (publish.sh)
 *   makes the release. macOS updates from the .zip; the .dmg is for first installs, left out of latest-mac.yml
 *   because release.sh staples it after the build, which changes its checksum.
 * - The packaged node_modules are checked before signing: every required peer of a dependency must be there,
 *   in a version it accepts (peer-deps.ts), or the build fails.
 */

const developerId = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
/** The Electron installed for this app: npm hoists it to the repository root, where electron-builder doesn't look. */
const electronVersion: string = createRequire(import.meta.url)("electron/package.json").version;

const config: Configuration = {
  appId: "com.golakiya.tot",
  productName: "TOT",
  electronVersion,
  directories: { output: "release", buildResources: "resources" },
  // Production dependencies come along from node_modules by themselves. The web app is built into the repository
  // root's dist/ (npm run build), which the server serves from its working directory: the app's folder.
  files: ["package.json", "dist-app/**/*", { from: "../../dist", to: "dist", filter: ["**/*"] }],
  asar: false,
  npmRebuild: false,
  publish: { provider: "github", owner: "dhruvalgolakiya", repo: "tot" },
  afterPack: async ({ appOutDir, packager }) => {
    const appDir = join(appOutDir, `${packager.appInfo.productFilename}.app`, "Contents", "Resources", "app");
    const problems = checkPeers(appDir);
    if (problems.length) throw new Error(`The app's node_modules aren't right:\n- ${problems.join("\n- ")}`);
  },
  mac: {
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ],
    category: "public.app-category.productivity",
    icon: "resources/icon.png",
    // "-" signs ad hoc; undefined lets electron-builder find the Developer ID.
    identity: developerId ? undefined : "-",
    hardenedRuntime: developerId,
    notarize: developerId && Boolean(process.env.APPLE_API_KEY),
    signIgnore: ["/node_modules/@openai/codex-darwin-arm64/", "/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/"],
  },
  // A signed .dmg passes Gatekeeper on its own; release.sh then notarizes and staples it.
  dmg: { sign: developerId, writeUpdateInfo: false },
};

export default config;
