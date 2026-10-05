import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

/**
 * PATH for the Mac app (roadmap module 08). An app opened from Finder gets launchd's minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), so TOT would miss Homebrew, nvm, and the `node` and `npm` that Executor and
 * MCP plugins need. At launch the app asks the login shell for the user's PATH, adds Homebrew's folders, and
 * appends a folder of shims (`node`, `npm`, `npx`) that run on the Node built into TOT.app, so the user's own
 * Node, when there is one, still comes first.
 */

const START = "__TOT_PATH_START__";
const END = "__TOT_PATH_END__";
const SHELL_TIMEOUT_MS = 4000;

/** Homebrew on Apple silicon, then Intel Macs (and many installers). */
export const EXTRA_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/** The PATH printed between the markers, or null. Shell start-up files may print anything around it. */
export function parseShellPath(output: string): string | null {
  const start = output.indexOf(START);
  if (start < 0) return null;
  const end = output.indexOf(END, start + START.length);
  if (end < 0) return null;
  const value = output.slice(start + START.length, end).trim();
  return value || null;
}

/**
 * The PATH TOT runs with: the login shell's (or, when that failed, Homebrew's folders and then the current
 * PATH), anything else the current PATH has, Homebrew's folders if still missing, and the shims last.
 */
export function mergePath(options: { shellPath: string | null; currentPath: string | undefined; shimDir: string }): string {
  const split = (value: string | null | undefined) => (value ?? "").split(":").filter(Boolean);
  const current = split(options.currentPath);
  const first = options.shellPath ? split(options.shellPath) : [...EXTRA_DIRS, ...current];
  const dirs = new Set([...first, ...current, ...EXTRA_DIRS]);
  dirs.delete(options.shimDir);
  return [...dirs, options.shimDir].join(":");
}

/** The user's PATH from their login shell, or null after a few seconds or on any error. */
export function readLoginShellPath(): Promise<string | null> {
  const shell = process.env.SHELL || userInfo().shell || "/bin/zsh";
  // Interactive and login, like a Terminal window: that's where nvm, fnm and Homebrew set PATH up.
  const script = `printf '%s' '${START}'; printf '%s' "$PATH"; printf '%s' '${END}'`;
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", script],
      // oh-my-zsh would otherwise ask about updating, and wait for an answer that never comes.
      { encoding: "utf8", timeout: SHELL_TIMEOUT_MS, env: { ...process.env, DISABLE_AUTO_UPDATE: "true" } },
      (_err, stdout) => resolve(parseShellPath(stdout ?? "")),
    );
  });
}

/** A word for /bin/sh: single quotes, with any single quote inside closed, escaped and reopened. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The three shims, keyed by name. `execPath` is TOT.app's executable; `npmBin` the bundled npm's bin/ folder. */
export function shimScripts(execPath: string, npmBin: string): Record<"node" | "npm" | "npx", string> {
  const run = (...args: string[]) =>
    `#!/bin/sh\n# Written by TOT at every launch: Node from TOT.app, for programs that need it when this Mac has none.\nELECTRON_RUN_AS_NODE=1 exec ${[execPath, ...args].map(shellQuote).join(" ")} "$@"\n`;
  return {
    node: run(),
    npm: run(join(npmBin, "npm-cli.js")),
    npx: run(join(npmBin, "npx-cli.js")),
  };
}

/** Writes the shims into `dir`, replacing the last launch's (TOT.app may have moved since). */
export function writeShims(dir: string, execPath: string, npmBin: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(shimScripts(execPath, npmBin))) {
    const file = join(dir, name);
    writeFileSync(file, text);
    chmodSync(file, 0o755);
  }
}
