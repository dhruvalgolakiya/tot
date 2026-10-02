import type { GateResult, RepoProfileInput } from "../../shared/types.ts";
import { parseJson } from "../db.ts";
import { sections, sh } from "./shell.ts";

/**
 * The scope gates: did the work stay inside what was agreed? Compares the
 * branch (including uncommitted and untracked files) with where it left the
 * base, and checks it against the plan's files, the repo's protected paths,
 * its dependency rules and its size limits — and scans it for tests that were
 * skipped, commented out or deleted, since "the tests pass" means nothing then.
 */

/** What a task set out to change: the plan's text and the paths it cites. */
export interface Plan {
  text: string;
  files: string[];
}

const EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|rb|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|md|mdx|yml|yaml|toml|sql|css|scss|html|vue|svelte|sh|lock|txt|gradle|xml|proto|graphql|tf|ex|exs|erb|ini|cfg|env";
const PATH_TOKEN = new RegExp(
  `(?:^|[\\s(\`'"\\[])((?:\\.{0,2}/)?(?:[\\w@.-]+/)+[\\w@.-]*|[\\w@.-]+\\.(?:${EXTENSIONS}))(?::\\d+(?:[-–]\\d+)?)?(?=[\\s)\`'",;:\\]]|$)`,
  "gim",
);

/** Paths a plan cites ("src/cart.ts:42", `server/trust/`, package.json), without line numbers or a leading ./ */
export function citedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PATH_TOKEN)) {
    const path = match[1].replace(/^\.\//, "").replace(/[.,]+$/, "");
    if (!path || /^(?:https?:|www\.)/i.test(path) || path.startsWith("//") || path === "/" || /^\.+\/?$/.test(path)) continue;
    found.add(path);
  }
  return [...found];
}

export const planFrom = (text: string): Plan => ({ text, files: citedPaths(text) });

/**
 * Glob matching for protected paths: ** spans folders, * and ? stay inside one, a pattern
 * without a slash matches the file name at any depth, and a trailing slash means "everything under".
 */
export function globMatcher(glob: string): (path: string) => boolean {
  let pattern = glob.trim().replace(/^\.?\//, "");
  if (pattern.endsWith("/")) pattern += "**";
  const anyDepth = !pattern.includes("/");
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      const slash = pattern[i + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const regex = new RegExp(`^${anyDepth ? "(?:.*/)?" : ""}${source}$`);
  return (path) => regex.test(path);
}

/** A plan entry covers a file when it names it, a folder above it, or matches it as a glob. */
function inPlan(file: string, plan: Plan): boolean {
  return plan.files.some((entry) => {
    const clean = entry.replace(/\/+$/, "");
    return file === clean || file.startsWith(`${clean}/`) || (/[*?]/.test(entry) && globMatcher(entry)(file));
  });
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb|exs)$|(^|\/)test_[^/]+\.py$|_spec\.rb$|Tests?\.(java|kt|cs|swift)$/;

/** cart.test.ts → cart.ts's stem, so tests for a planned file count as planned. */
const stem = (file: string) =>
  (file.split("/").pop() ?? file)
    .replace(/\.(test|spec)(?=\.)/, "")
    .replace(/^test_/, "")
    .replace(/_(test|spec)(?=\.)/, "")
    .replace(/\.[^.]+$/, "");

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "go.sum",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "gradle.lockfile",
  "deno.lock",
]);
const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|Pipfile|setup\.py|setup\.cfg|go\.mod|Cargo\.toml|Gemfile|[^/]+\.gemspec|composer\.json|pom\.xml|build\.gradle(\.kts)?|deno\.jsonc?)$/;
const isLockfile = (file: string) => LOCKFILES.has(file.split("/").pop() ?? "");

const SKIPS: [RegExp, string][] = [
  [/\b(?:it|test|describe|context|suite|specify)\.(?:skip|todo)\s*\(/, "skips a test"],
  [/\b(?:xit|xtest|xdescribe|xcontext|xspecify)\s*\(/, "skips a test"],
  [/\b(?:it|test|describe|context|suite)\.only\s*\(/, "runs only some tests (.only)"],
  [/@pytest\.mark\.(?:skip|skipif|xfail)\b|@unittest\.(?:skip|expectedFailure)\b|\bpytest\.skip\(|\.skipTest\(/, "skips a test"],
  [/\bt\.Skip(?:f|Now)?\(/, "skips a test"],
  [/#\[ignore\]/, "skips a test"],
  [/@(?:Disabled|Ignore)\b/, "skips a test"],
  [/^\s*(?:\/\/|#|\/?\*)\s*(?:it|test|describe)(?:\.\w+)?\s*\(|^\s*#\s*def test_|^\s*\/\/\s*func Test/, "comments out a test"],
];
const RUBY_SKIP = /^\s*(?:skip|pending)\b/;
const TEST_DECLARATION = /^\s*(?:it|test|specify)\s*\(|^\s*(?:async\s+)?def test_|^\s*func Test\w*\(|^\s*#\[test\]|^\s*@Test\b/;

interface Change {
  status: string;
  path: string;
  /** The old path of a rename. */
  from?: string;
}

interface Diff {
  changes: Change[];
  /** Lines added and removed per file; null for binary files. */
  numstat: Map<string, { added: number; removed: number } | null>;
  added: Map<string, string[]>;
  removed: Map<string, string[]>;
  baseFiles: Map<string, string>;
  headFiles: Map<string, string>;
}

/** The new path for "src/{old => new}/a.ts"-style numstat renames. */
const renamedPath = (path: string) => path.replace(/\{[^{}]*? => ([^{}]*)\}/, "$1").replace(/^.* => /, "").replace(/\/\//g, "/");

async function readDiff(agentId: string, cwd: string, baseSha: string): Promise<Diff> {
  const base = sh(baseSha);
  const found = await sections(
    agentId,
    `echo "@@@ status"; git diff --name-status -M ${base}
echo "@@@ numstat"; git diff --numstat -M ${base}
echo "@@@ untracked"; git ls-files --others --exclude-standard | head -500 | while IFS= read -r f; do printf '%s\\t%s\\n' "$(wc -l < "$f" 2>/dev/null | tr -d ' ')" "$f"; done
echo "@@@ patch"; git diff -U0 --no-color --no-ext-diff ${base} | head -c 3000000; echo
echo "@@@ new-tests"; git ls-files --others --exclude-standard | grep -E '${TEST_FILE.source}' | head -50 | while IFS= read -r f; do printf 'diff --git a/%s b/%s\n+++ b/%s\n@@\n' "$f" "$f" "$f"; head -c 100000 "$f" | sed 's/^/+/'; echo; done
for f in $({ git diff --name-only ${base} -- '*package.json'; git ls-files --others --exclude-standard -- '*package.json'; } | head -20); do echo "@@@ base:$f"; git show ${base}:"$f" 2>/dev/null; echo; echo "@@@ head:$f"; cat "$f" 2>/dev/null; echo; done`,
    cwd,
  );

  const changes: Change[] = [];
  for (const line of (found.status ?? "").split("\n").filter(Boolean)) {
    const [status, first, second] = line.split("\t");
    if (status.startsWith("R") || status.startsWith("C")) changes.push({ status: status[0], path: second, from: first });
    else changes.push({ status: status[0], path: first });
  }
  const numstat = new Map<string, { added: number; removed: number } | null>();
  for (const line of (found.numstat ?? "").split("\n").filter(Boolean)) {
    const [added, removed, ...rest] = line.split("\t");
    numstat.set(renamedPath(rest.join("\t")), added === "-" ? null : { added: Number(added), removed: Number(removed) });
  }
  for (const line of (found.untracked ?? "").split("\n").filter(Boolean)) {
    const [count, ...rest] = line.split("\t");
    const path = rest.join("\t");
    changes.push({ status: "?", path });
    numstat.set(path, { added: Number(count) || 0, removed: 0 });
  }

  const added = new Map<string, string[]>();
  const removed = new Map<string, string[]>();
  // Header lines (---/+++) only come before a file's first hunk; inside hunks they're content.
  let file = "";
  let oldFile = "";
  let header = false;
  for (const line of `${found.patch ?? ""}\n${found["new-tests"] ?? ""}`.split("\n")) {
    if (line.startsWith("diff --git ")) header = true;
    else if (header && line.startsWith("--- ")) oldFile = line.replace(/^--- (?:a\/)?/, "");
    else if (header && line.startsWith("+++ ")) file = line === "+++ /dev/null" ? oldFile : line.replace(/^\+\+\+ (?:b\/)?/, "");
    else if (line.startsWith("@@")) header = false;
    else if (header) continue;
    else if (line.startsWith("+")) added.set(file, [...(added.get(file) ?? []), line.slice(1)]);
    else if (line.startsWith("-")) removed.set(file, [...(removed.get(file) ?? []), line.slice(1)]);
  }

  const baseFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  for (const [name, content] of Object.entries(found)) {
    if (name.startsWith("base:")) baseFiles.set(name.slice(5), content);
    if (name.startsWith("head:")) headFiles.set(name.slice(5), content);
  }
  return { changes, numstat, added, removed, baseFiles, headFiles };
}

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** Dependencies a package.json gained or changed ("+ left-pad ^1.3.0", "react ^18 → ^19"); removals don't need an OK. */
function packageChanges(before: string | undefined, after: string | undefined): string[] {
  const deps = (json: string | undefined) => {
    const pkg = parseJson<Record<string, Record<string, string>>>(json, {});
    return Object.assign({}, ...DEP_FIELDS.map((field) => pkg[field] ?? {})) as Record<string, string>;
  };
  const was = deps(before);
  const now = deps(after);
  return Object.entries(now).flatMap(([name, range]) =>
    !(name in was) ? [`+ ${name} ${range}`] : was[name] !== range ? [`${name} ${was[name]} → ${range}`] : [],
  );
}

const plural = (count: number, word: string) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

export interface ScopeCheck {
  agentId: string;
  cwd: string;
  /** Where the branch left the base (see repoState). */
  baseSha: string;
  profile: RepoProfileInput;
  plan?: Plan;
  /** Read-only work (investigating, reviewing a PR): any change at all fails. */
  readOnly?: boolean;
}

/**
 * Scope, deps and size results, plus a "test" result (needs approval) when tests were skipped,
 * commented out or deleted — `runGates` folds that into the test command's own result.
 */
export async function checkScope({ agentId, cwd, baseSha, profile, plan, readOnly }: ScopeCheck): Promise<GateResult[]> {
  const diff = await readDiff(agentId, cwd, baseSha);
  const paths = [...new Set(diff.changes.flatMap((change) => (change.from ? [change.from, change.path] : [change.path])))];
  const results: GateResult[] = [];

  // Scope: the plan's files, protected paths, or no changes at all for read-only work.
  const protectedPaths = new Set<string>();
  const protectedHits = profile.protectedPaths.flatMap((glob) => {
    const matches = globMatcher(glob);
    return paths.filter((path) => matches(path) && !protectedPaths.has(path) && protectedPaths.add(path)).map((path) => `${path} (protected: ${glob})`);
  });
  const planFiles = plan?.files ?? [];
  const outside = plan && planFiles.length
    ? diff.changes
        .filter((change) => !inPlan(change.path, plan) && !protectedPaths.has(change.path))
        .filter((change) => !(TEST_FILE.test(change.path) && planFiles.some((entry) => stem(entry) === stem(change.path))))
        .map((change) => `${change.path} (outside the plan)`)
    : [];
  if (readOnly) {
    results.push(
      paths.length
        ? { gate: "scope", status: "fail", note: `This work shouldn't change files, but ${plural(paths.length, "file")} changed.`, details: paths.slice(0, 50) }
        : { gate: "scope", status: "pass", note: "No files changed." },
    );
  } else if (protectedHits.length || outside.length) {
    const reasons = [protectedHits.length && `touches ${plural(protectedHits.length, "protected path")}`, outside.length && `changes ${plural(outside.length, "file")} the plan doesn't name`].filter(Boolean);
    results.push({ gate: "scope", status: "needs-approval", note: `It ${reasons.join(" and ")}.`, details: [...protectedHits, ...outside].slice(0, 50) });
  } else {
    results.push({
      gate: "scope",
      status: "pass",
      note: !paths.length ? "No files changed." : plan && planFiles.length ? "Every changed file is in the plan." : "No protected paths touched.",
    });
  }

  // Dependencies: manifests that gained packages, and lockfile changes.
  const depChanges: string[] = [];
  for (const change of diff.changes) {
    const name = change.path.split("/").pop() ?? "";
    if (name === "package.json") {
      depChanges.push(...packageChanges(diff.baseFiles.get(change.path), diff.headFiles.get(change.path)).map((line) => `${change.path}: ${line}`));
    } else if (MANIFEST.test(change.path)) {
      const lines = (diff.added.get(change.path) ?? []).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
      if (lines.length || change.status === "A" || change.status === "?") depChanges.push(...(lines.length ? lines.slice(0, 10).map((line) => `${change.path}: + ${line}`) : [`${change.path} (new)`]));
    }
  }
  const lockfiles = diff.changes.filter((change) => isLockfile(change.path)).map((change) => `${change.path} changed`);
  if (!depChanges.length && !lockfiles.length) {
    results.push({ gate: "deps", status: "pass", note: "No dependency changes." });
  } else {
    const details = [...depChanges, ...lockfiles].slice(0, 50);
    results.push(
      profile.limits.allowNewDependencies
        ? { gate: "deps", status: "pass", note: "Dependencies changed; the repo profile allows that.", details }
        : {
            gate: "deps",
            status: "needs-approval",
            note: depChanges.length ? `New or changed dependencies (${plural(depChanges.length, "change")}).` : "A lockfile changed.",
            details,
          },
    );
  }

  // Size: changed lines (lockfiles and binary files don't count) and changed files.
  let lines = 0;
  for (const [path, counts] of diff.numstat) if (counts && !isLockfile(path)) lines += counts.added + counts.removed;
  const files = diff.changes.filter((change) => !isLockfile(change.path)).length;
  const { maxChangedLines, maxChangedFiles } = profile.limits;
  const over = [lines > maxChangedLines && `${plural(lines, "changed line")} (limit ${maxChangedLines.toLocaleString("en-US")})`, files > maxChangedFiles && `${plural(files, "changed file")} (limit ${maxChangedFiles})`].filter(
    (item): item is string => Boolean(item),
  );
  results.push(
    over.length
      ? { gate: "size", status: "needs-approval", note: `Bigger than the repo's limits: ${over.join(" and ")}.` }
      : { gate: "size", status: "pass", note: `${plural(lines, "changed line")} in ${plural(files, "file")}.` },
  );

  // Tests that stopped counting: skipped, focused, commented out, or deleted.
  const findings: string[] = [];
  for (const [file, lines] of diff.added) {
    for (const line of lines) {
      const hit = SKIPS.find(([pattern]) => pattern.test(line)) ?? (file.endsWith("_spec.rb") && RUBY_SKIP.test(line) ? [RUBY_SKIP, "skips a test"] : null);
      if (hit) findings.push(`${file}: ${hit[1]} — ${line.trim().slice(0, 120)}`);
    }
  }
  for (const file of new Set([...diff.added.keys(), ...diff.removed.keys()])) {
    const count = (lines: string[] | undefined) => (lines ?? []).filter((line) => TEST_DECLARATION.test(line)).length;
    const lost = count(diff.removed.get(file)) - count(diff.added.get(file));
    const deleted = diff.changes.some((change) => change.path === file && change.status === "D");
    if (lost > 0 && !deleted) findings.push(`${file}: removes ${plural(lost, "test")}`);
  }
  for (const change of diff.changes) if (change.status === "D" && TEST_FILE.test(change.path)) findings.push(`${change.path}: test file deleted`);
  if (findings.length) {
    results.push({ gate: "test", status: "needs-approval", note: "Tests were skipped, commented out or removed.", details: findings.slice(0, 50) });
  }
  return results;
}
