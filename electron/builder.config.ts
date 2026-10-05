import type { Configuration } from "electron-builder";

/**
 * Packaging the Mac app (roadmap module 08): TOT.app for Apple silicon, as a .dmg and a .zip in release/.
 *
 * - No asar: the server runs from real files (dist/ as its working directory, codex and Claude Code spawned
 *   from node_modules), at the cost of a bigger app.
 * - Signed ad hoc unless a Developer ID is given through CSC_LINK or CSC_NAME, which also turns on the
 *   hardened runtime (notarizing comes later). Codex's and Claude Code's own binaries keep their vendors'
 *   signatures.
 * - Nothing is published: there are no releases or auto-update yet.
 */

const developerId = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

const config: Configuration = {
  appId: "com.golakiya.tot",
  productName: "TOT",
  directories: { output: "release", buildResources: "electron/resources" },
  // Production dependencies come along from node_modules by themselves.
  files: ["package.json", "dist/**/*", "dist-app/**/*"],
  asar: false,
  npmRebuild: false,
  publish: null,
  mac: {
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ],
    category: "public.app-category.productivity",
    icon: "electron/resources/icon.png",
    // "-" signs ad hoc; undefined lets electron-builder find the Developer ID.
    identity: developerId ? undefined : "-",
    hardenedRuntime: developerId,
    signIgnore: ["/node_modules/@openai/codex-darwin-arm64/", "/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/"],
  },
};

export default config;
