import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import semver from "semver";

/**
 * The Mac app ships node_modules as electron-builder lays them out, which can differ from the dev tree: it leaves
 * a peer dependency out unless something declares it, and may hoist another package's nested copy in its place.
 * (October 2026: npm's own undici 6 took the place of the undici 8 Slack's socket-mode needs, so its pings threw,
 * the Slack connection was rebuilt every few seconds, and once the server crashed.) `checkPeers` lists every
 * required peer of the app's dependencies that, resolved the way Node would from inside the app, is missing or the
 * wrong version. Packaging fails on any (builder.config.ts, afterPack).
 */

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;

/**
 * Required peers a dependency's own code never loads (only its .d.ts files name them), left out of the app on
 * purpose. Each is checked again at every build: once the dependency's JavaScript mentions it, it's a problem.
 */
const TYPES_ONLY: Record<string, string[]> = {
  // 14 MB that the agent SDK only uses for types: the SDK runs Claude Code, which talks to the API itself.
  "@anthropic-ai/claude-agent-sdk": ["@anthropic-ai/sdk"],
};

/** Whether any of a package's JavaScript files (outside its own node_modules) mentions `name`. */
function codeMentions(packageDir: string, name: string): boolean {
  const pending = [packageDir];
  while (pending.length) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") pending.push(join(dir, entry.name));
      } else if (/\.(c|m)?js$/.test(entry.name) && readFileSync(join(dir, entry.name), "utf8").includes(`"${name}`)) {
        return true;
      }
    }
  }
  return false;
}

/** The package.json Node finds for `name` from inside `fromDir`, looking up to `rootDir`; null when there's none. */
function resolvePackage(name: string, fromDir: string, rootDir: string): string | null {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return candidate;
    if (dir === rootDir || dirname(dir) === dir) return null;
    dir = dirname(dir);
  }
}

/** What's wrong with the app's peer dependencies (`appDir`: the folder with its package.json and node_modules). */
export function checkPeers(appDir: string): string[] {
  const dependencies = Object.keys(readJson(join(appDir, "package.json")).dependencies ?? {});
  const problems: string[] = [];
  for (const dependency of dependencies) {
    const own = join(appDir, "node_modules", dependency, "package.json");
    if (!existsSync(own)) {
      problems.push(`${dependency} isn't in the app`);
      continue;
    }
    const pkg = readJson(own);
    for (const [peer, range] of Object.entries<string>(pkg.peerDependencies ?? {})) {
      if (pkg.peerDependenciesMeta?.[peer]?.optional) continue;
      if (TYPES_ONLY[dependency]?.includes(peer) && !codeMentions(dirname(own), peer)) continue;
      const found = resolvePackage(peer, dirname(own), appDir);
      if (!found) {
        problems.push(`${dependency} needs ${peer}@${range}, which isn't in the app`);
        continue;
      }
      const { version } = readJson(found);
      if (!semver.satisfies(version, range, { includePrerelease: true })) problems.push(`${dependency} needs ${peer}@${range}, but the app has ${version}`);
    }
  }
  return problems;
}
