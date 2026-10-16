import { z } from "zod";
import type { Brain, CommandRun, RepoCommandName, RepoLimits, RepoProfile, RepoProfileInput } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import type { FolderGrant } from "../computer/types.ts";
import { appEvents } from "../app-events.ts";
import { agents } from "../data/agents.ts";
import { brains, cloneFolder } from "../data/brains.ts";
import { wiki } from "../data/wiki.ts";
import { db, parseJson, type Row } from "../db.ts";
import { projects } from "../projects/projects.ts";
import { jsonIn, trustModel } from "./model.ts";
import { exec, output, scrub, sections, tail } from "./shell.ts";

/**
 * Repo profiles: what "correct" means for one repo — the commands that check
 * work there, its conventions, the paths agents must ask about, its definition
 * of done and its limits. One per repo brain, drafted from the code (commands
 * come from the repo's own manifests, never from a model's guess), confirmed and
 * edited by the user, and rendered as a "Repo profile" page in the brain so
 * agents read it along with the rest of what they know about the repo.
 */

export const PROFILE_TITLE = "Repo profile";
const PROFILE_SUMMARY = "How work in this repo is checked: commands, conventions, protected paths, definition of done and limits.";

export const COMMAND_NAMES: RepoCommandName[] = ["install", "typecheck", "lint", "test", "testFile", "build", "e2e"];

export const DEFAULT_LIMITS: RepoLimits = { maxChangedLines: 1000, maxChangedFiles: 30, allowNewDependencies: false, commandTimeoutMinutes: 10 };

const MAX_COMMAND = 500;
const MAX_RULE = 300;
const MAX_RULES = 30;
const MAX_PATHS = 50;

// ---------------------------------------------------------------------------
// Where a repo lives on an agent's computer, and which agent's computer to use.

/** The repo's folder, relative to the computer's home: where Learn a repo cloned it, or a folder used in place. */
export function repoFolder(source: string): string {
  const text = source.trim().replace(/[/\\]+$/, "");
  if (text.startsWith("~/")) return text.slice(2);
  if (text.startsWith("/")) return text;
  return `repos/${cloneFolder(text)}`;
}

/** Where a brain's repo is, relative to the computer's home: its project's folder (module 06), or as repoFolder says. */
function brainFolder(brain: Brain & { source: string }): string {
  const project = projects.forBrain(brain.id);
  const folder = project && project.kind !== "none" ? projects.folder(project) : null;
  return folder ? folder.replace(/^~\//, "") : repoFolder(brain.source);
}

function repoBrain(brainId: string): Brain & { source: string } {
  const brain = brains.get(brainId);
  if (!brain) throw new HttpError(404, "Brain not found.");
  if (brain.kind !== "repo" || !brain.source) throw new HttpError(400, "Only a repo's brain has a profile. Learn a repo to make one.");
  return brain as Brain & { source: string };
}

/** The agent whose computer runs the repo's commands: the one asked for, else the first that may write the brain. */
function agentFor(brain: Brain, agentId?: string): string {
  if (agentId) {
    if (!agents.get(agentId)) throw new HttpError(404, "Agent not found.");
    return agentId;
  }
  return (brain.agents.find((a) => a.access === "write") ?? brain.agents[0])?.agentId ?? agents.first().id;
}

function missingFolder(agentId: string, folder: string): HttpError {
  const name = agents.get(agentId)?.name ?? "The agent";
  return new HttpError(400, `~/${folder.replace(/^\//, "")} isn't on ${name}'s computer. Learn the repo with ${name} first, or clone it there.`);
}

async function requireFolder(agentId: string, folder: string): Promise<void> {
  if ("missing" in (await sections(agentId, `echo "@@@ ok"`, folder))) throw missingFolder(agentId, folder);
}

// ---------------------------------------------------------------------------
// Validation

const text = (value: unknown, max: number, what: string): string => {
  if (typeof value !== "string") throw new HttpError(400, `${what} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `${what} is too long (at most ${max} characters).`);
  return trimmed;
};

function list(value: unknown, what: string, max: number, maxLength = MAX_RULE): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, `${what} must be a list.`);
  const items = [...new Set(value.map((item) => text(item, maxLength, `Each of ${what.toLowerCase()}`).replace(/\s+/g, " ")).filter(Boolean))];
  if (items.length > max) throw new HttpError(400, `Keep ${what.toLowerCase()} to ${max} or fewer.`);
  return items;
}

function int(value: unknown, fallback: number, min: number, max: number, what: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${what} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

export function cleanProfile(input: Partial<RepoProfileInput>): RepoProfileInput {
  const commands: RepoProfileInput["commands"] = {};
  const given = input.commands ?? {};
  if (typeof given !== "object" || Array.isArray(given)) throw new HttpError(400, "Commands must be an object.");
  for (const [name, value] of Object.entries(given)) {
    if (!COMMAND_NAMES.includes(name as RepoCommandName)) throw new HttpError(400, `Unknown command “${name}”.`);
    const command = text(value ?? "", MAX_COMMAND, `The ${name} command`);
    if (/[\r\n]/.test(command)) throw new HttpError(400, `Keep the ${name} command on one line (join steps with &&).`);
    if (name === "testFile" && command && !command.includes("{file}")) {
      throw new HttpError(400, "The one-file test command needs {file} where the test file's path goes.");
    }
    if (command) commands[name as RepoCommandName] = command;
  }
  const limits = (input.limits ?? {}) as Partial<RepoLimits>;
  if (limits.allowNewDependencies !== undefined && typeof limits.allowNewDependencies !== "boolean") {
    throw new HttpError(400, "allowNewDependencies must be true or false.");
  }
  return {
    commands,
    conventions: list(input.conventions, "Conventions", MAX_RULES),
    protectedPaths: list(input.protectedPaths, "Protected paths", MAX_PATHS, 200).map((glob) => glob.replace(/^\.\//, "")),
    definitionOfDone: list(input.definitionOfDone, "Definition of done", MAX_RULES),
    limits: {
      maxChangedLines: int(limits.maxChangedLines, DEFAULT_LIMITS.maxChangedLines, 1, 100_000, "Max changed lines"),
      maxChangedFiles: int(limits.maxChangedFiles, DEFAULT_LIMITS.maxChangedFiles, 1, 10_000, "Max changed files"),
      allowNewDependencies: limits.allowNewDependencies ?? DEFAULT_LIMITS.allowNewDependencies,
      commandTimeoutMinutes: int(limits.commandTimeoutMinutes, DEFAULT_LIMITS.commandTimeoutMinutes, 1, 120, "The command timeout"),
    },
  };
}

// ---------------------------------------------------------------------------
// Drafting from the code

/** What drafting reads from a repo: a few manifests and the list of tracked files. */
export interface RepoScan {
  manifests: Record<string, string>;
  files: string[];
}

const MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "requirements.txt",
  "requirements-dev.txt",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "Makefile",
];

async function scanRepo(agentId: string, folder: string, grant?: FolderGrant | null): Promise<RepoScan> {
  const found = await sections(
    agentId,
    `for f in ${MANIFESTS.join(" ")}; do [ -f "$f" ] && { echo "@@@ file:$f"; head -c 30000 "$f"; echo; }; done
echo "@@@ files"
git ls-files 2>/dev/null | head -20000 | grep . || find . -maxdepth 4 -type f -not -path '*/node_modules/*' -not -path './.git/*' | sed 's|^\\./||' | head -5000`,
    folder,
    grant,
  );
  if ("missing" in found) throw missingFolder(agentId, folder);
  const manifests: Record<string, string> = {};
  for (const [name, content] of Object.entries(found)) if (name.startsWith("file:")) manifests[name.slice(5)] = content;
  return { manifests, files: (found.files ?? "").split("\n").filter(Boolean) };
}

type Commands = RepoProfileInput["commands"];

const parseObject = (json: string | undefined): Record<string, unknown> | null => {
  const value = json ? parseJson<unknown>(json, null) : null;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
};

function nodeCommands(pkg: Record<string, unknown>, has: (path: string) => boolean): Commands {
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, string>;
  const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
  const pm = ["npm", "pnpm", "yarn", "bun"].includes(declared)
    ? declared
    : has("pnpm-lock.yaml")
      ? "pnpm"
      : has("yarn.lock")
        ? "yarn"
        : has("bun.lockb") || has("bun.lock")
          ? "bun"
          : "npm";
  const run = (script: string) => `${pm} run ${script}`;
  const bin = { npm: "npx", pnpm: "pnpm exec", yarn: "yarn", bun: "bunx" }[pm];
  const script = (...names: string[]) => names.find((name) => typeof scripts[name] === "string" && scripts[name].trim());

  const typecheck = script("typecheck", "type-check", "typecheck:all", "check-types", "types:check", "tsc");
  const lint = script("lint", "lint:check", "eslint");
  const test = scripts.test && !/no test specified/i.test(scripts.test) ? "test" : script("test:unit", "unit");
  const e2e = script("e2e", "test:e2e", "e2e:test", "playwright", "cypress:run");
  return {
    install:
      pm === "npm"
        ? has("package-lock.json") || has("npm-shrinkwrap.json")
          ? "npm ci"
          : "npm install"
        : pm === "yarn"
          ? `yarn install ${has(".yarnrc.yml") ? "--immutable" : "--frozen-lockfile"}`
          : `${pm} install --frozen-lockfile`,
    typecheck: typecheck ? run(typecheck) : deps.typescript && has("tsconfig.json") ? `${bin} tsc --noEmit` : undefined,
    lint: lint ? run(lint) : deps.eslint ? `${bin} eslint .` : deps["@biomejs/biome"] ? `${bin} biome check .` : undefined,
    test: test === "test" ? `${pm} test` : test ? run(test) : undefined,
    testFile: deps.vitest
      ? `${bin} vitest run {file}`
      : deps.jest
        ? `${bin} jest {file}`
        : deps.mocha
          ? `${bin} mocha {file}`
          : /\bnode --test\b/.test(scripts.test ?? "")
            ? "node --test {file}"
            : undefined,
    build: script("build") ? run("build") : undefined,
    e2e: e2e ? run(e2e) : deps["@playwright/test"] ? `${bin} playwright test` : undefined,
  };
}

function pythonCommands(manifests: Record<string, string>, has: (path: string) => boolean, files: string[]): Commands {
  const pyproject = manifests["pyproject.toml"] ?? "";
  const all = [pyproject, manifests["requirements.txt"], manifests["requirements-dev.txt"], manifests["setup.cfg"], manifests.Pipfile].join("\n");
  const pm = has("uv.lock") ? "uv" : has("poetry.lock") || /\[tool\.poetry\]/.test(pyproject) ? "poetry" : "Pipfile" in manifests ? "pipenv" : "pip";
  const prefix = { uv: "uv run ", poetry: "poetry run ", pipenv: "pipenv run ", pip: "" }[pm];
  const pytest = /\bpytest\b/.test(all) || has("pytest.ini") || files.some((file) => /(^|\/)conftest\.py$/.test(file));
  const unittest = files.some((file) => /(^|\/)(tests?\/.*|test_[^/]+|[^/]+_test)\.py$/.test(file));
  return {
    install:
      pm === "uv"
        ? "uv sync"
        : pm === "poetry"
          ? "poetry install"
          : pm === "pipenv"
            ? "pipenv install --dev"
            : has("requirements-dev.txt")
              ? "pip install -r requirements-dev.txt"
              : has("requirements.txt")
                ? "pip install -r requirements.txt"
                : "pip install -e .",
    typecheck: /\bmypy\b/.test(all) || has("mypy.ini") ? `${prefix}mypy .` : /\bpyright\b/.test(all) || has("pyrightconfig.json") ? `${prefix}pyright` : undefined,
    lint: /\bruff\b/.test(all) || has("ruff.toml") || has(".ruff.toml") ? `${prefix}ruff check .` : /\bflake8\b/.test(all) || has(".flake8") ? `${prefix}flake8` : undefined,
    test: pytest ? `${prefix}pytest` : unittest ? `${prefix}python -m unittest` : undefined,
    testFile: pytest ? `${prefix}pytest {file}` : undefined,
  };
}

function goCommands(has: (path: string) => boolean): Commands {
  return {
    install: "go mod download",
    lint: has(".golangci.yml") || has(".golangci.yaml") ? "golangci-lint run" : "go vet ./...",
    test: "go test ./...",
    testFile: 'go test "./$(dirname {file})"',
    build: "go build ./...",
  };
}

const RUST_COMMANDS: Commands = {
  typecheck: "cargo check --all-targets",
  lint: "cargo clippy --all-targets -- -D warnings",
  test: "cargo test",
  build: "cargo build",
};

function rubyCommands(gemfile: string, files: string[]): Commands {
  const rspec = /\brspec\b/.test(gemfile) || files.some((file) => file.startsWith("spec/"));
  const minitest = files.some((file) => file.startsWith("test/"));
  return {
    install: "bundle install",
    lint: /\brubocop\b/.test(gemfile) ? "bundle exec rubocop" : undefined,
    test: rspec ? "bundle exec rspec" : minitest ? "bundle exec rake test" : undefined,
    testFile: rspec ? "bundle exec rspec {file}" : minitest ? "bundle exec ruby -Itest {file}" : undefined,
  };
}

/** `make <target>` for the targets a Makefile has. */
function makeCommands(makefile: string): Commands {
  const targets = new Set([...makefile.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].map((match) => match[1]));
  const make = (...names: string[]) => {
    const target = names.find((name) => targets.has(name));
    return target ? `make ${target}` : undefined;
  };
  return {
    install: make("install", "deps", "setup"),
    typecheck: make("typecheck", "check-types"),
    lint: make("lint"),
    test: make("test", "tests", "check"),
    build: make("build"),
    e2e: make("e2e", "test-e2e"),
  };
}

const TOP_LEVEL_PROTECTED = ["terraform", "infra", "infrastructure", "k8s", "helm", "charts", "vendor"];
const CI_FILES = [".gitlab-ci.yml", "Jenkinsfile", "azure-pipelines.yml", ".travis.yml", "CODEOWNERS"];
const AGENT_RULES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", ".cursorrules"];

/** "a, b and c" */
const listed = (items: readonly string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? ""));

/** A profile read straight from the repo's files: manifests for the commands, the file tree for protected paths. */
export function detectProfile({ manifests, files }: RepoScan): RepoProfileInput {
  const tracked = new Set(files);
  const has = (path: string) => tracked.has(path);
  const hasDir = (dir: string) => files.some((file) => file.startsWith(`${dir}/`));

  const pkg = parseObject(manifests["package.json"]);
  const python = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"].some((name) => name in manifests);
  const ecosystems: Commands[] = [
    ...(pkg ? [nodeCommands(pkg, has)] : []),
    ...(python ? [pythonCommands(manifests, has, files)] : []),
    ...("go.mod" in manifests ? [goCommands(has)] : []),
    ...("Cargo.toml" in manifests ? [RUST_COMMANDS] : []),
    ...("Gemfile" in manifests ? [rubyCommands(manifests.Gemfile, files)] : []),
  ];
  const make = "Makefile" in manifests ? makeCommands(manifests.Makefile) : {};
  // In a repo with several stacks (or none TOT knows), the Makefile is usually what ties them together.
  const order = ecosystems.length === 1 ? [...ecosystems, make] : [make, ...ecosystems];
  const commands: Commands = {};
  for (const source of order) {
    for (const name of COMMAND_NAMES) if (!commands[name] && source[name]) commands[name] = source[name];
  }

  const protectedPaths: string[] = [];
  if (hasDir(".github")) protectedPaths.push(".github/**");
  for (const dir of [".circleci", ".buildkite"]) if (hasDir(dir)) protectedPaths.push(`${dir}/**`);
  for (const file of CI_FILES) if (has(file)) protectedPaths.push(file);
  const migrations = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    const at = parts.findIndex((part, i) => part === "migrations" || part === "migrate" || (part === "versions" && parts[i - 1] === "alembic"));
    if (at >= 0 && at < parts.length - 1) migrations.add(`${parts.slice(0, at + 1).join("/")}/**`);
  }
  protectedPaths.push(...[...migrations].sort((a, b) => a.length - b.length).slice(0, 6));
  for (const dir of TOP_LEVEL_PROTECTED) if (hasDir(dir)) protectedPaths.push(`${dir}/**`);
  if (files.some((file) => file.endsWith(".tf") && !protectedPaths.some((glob) => file.startsWith(glob.slice(0, -2))))) protectedPaths.push("**/*.tf");

  const checks = (["typecheck", "lint", "test", "build"] as const).filter((name) => commands[name]);
  return {
    commands,
    conventions: AGENT_RULES.filter(has).map((file) => `Follow the rules in ${file}`),
    protectedPaths,
    definitionOfDone: [
      "New or changed behaviour has tests",
      ...(checks.length ? [`${listed(checks).replace(/^\w/, (c) => c.toUpperCase())} pass`] : []),
      "Docs are updated when public behaviour or setup changes",
      "The diff has only what the task needs",
    ],
    limits: { ...DEFAULT_LIMITS },
  };
}

const NOTES = ["Run, test & deploy", "Conventions & gotchas"];
const NOTE_CHARS = 6000;

const Refinement = z.object({
  commands: z.record(z.string(), z.string()).optional(),
  conventions: z.array(z.string()).optional(),
  definitionOfDone: z.array(z.string()).optional(),
  protectedPaths: z.array(z.string()).optional(),
});

/**
 * Fills what manifests can't say — conventions, definition of done, commands detection missed — from the
 * notes Learn a repo wrote. Detected commands are kept as they are; without notes there's nothing to ask.
 */
async function refine(brain: Brain, draft: RepoProfileInput): Promise<RepoProfileInput> {
  const notes = NOTES.flatMap((title) => wiki.withTitle(brain.id, title).slice(0, 1)).filter((page) => page.content.trim());
  if (!notes.length || !(await trustModel.available()).length) return draft;
  const prompt = `Repo: ${brain.name} (${brain.source})

Commands detected from its manifests (keep these; they come from the actual files):
${JSON.stringify(draft.commands, null, 2)}
Protected paths detected: ${JSON.stringify(draft.protectedPaths)}

Notes written by the agent who studied the repo:
${notes.map((page) => `## ${page.title}\n${page.content.slice(0, NOTE_CHARS)}`).join("\n\n")}

Reply with only this JSON:
{
  "commands": {},          // only names missing above (${COMMAND_NAMES.join(", ")}; testFile uses {file} for one test file's path), and only when the notes give the exact command
  "conventions": [],       // up to 8 short rules an agent changing this code must follow, from the notes
  "definitionOfDone": [],  // up to 6 checks a finished change must meet in this repo
  "protectedPaths": []     // extra globs agents should not change without asking (generated code, migrations, CI, vendored code) that the notes name
}`;
  const answer = await trustModel.ask({
    prompt,
    system: "You turn notes about a code repository into a short, accurate repo profile. Use only facts in the notes or the detected commands; never invent commands, scripts or paths. Reply with JSON only.",
    heavy: false,
    timeoutMs: 120_000,
  });
  const parsed = Refinement.parse(jsonIn(answer.text));
  const commands = { ...draft.commands };
  for (const [name, command] of Object.entries(parsed.commands ?? {})) {
    const value = command.trim();
    const usable = value && value.length <= MAX_COMMAND && !/[\r\n]/.test(value) && (name !== "testFile" || value.includes("{file}"));
    if (COMMAND_NAMES.includes(name as RepoCommandName) && !commands[name as RepoCommandName] && usable) commands[name as RepoCommandName] = value;
  }
  const short = (items: string[] | undefined, max: number) => (items ?? []).map((item) => item.trim()).filter((item) => item && item.length <= MAX_RULE).slice(0, max);
  const conventions = short(parsed.conventions, 8);
  const done = short(parsed.definitionOfDone, 6);
  return {
    ...draft,
    commands,
    conventions: [...new Set([...draft.conventions, ...conventions])],
    definitionOfDone: done.length ? done : draft.definitionOfDone,
    protectedPaths: [...new Set([...draft.protectedPaths, ...short(parsed.protectedPaths, 10).map((glob) => glob.replace(/^\.?\//, ""))])],
  };
}

/** A profile to confirm (not saved), from the repo on the agent's computer and, when there are any, Learn a repo's notes. */
export async function draftProfile(brainId: string, agentId?: string): Promise<RepoProfile> {
  const brain = repoBrain(brainId);
  const scan = await scanRepo(agentFor(brain, agentId), brainFolder(brain));
  const detected = detectProfile(scan);
  const draft = await refine(brain, detected).catch((err: unknown) => {
    console.warn(`[tot] refining ${brain.name}'s profile from its notes failed:`, err instanceof Error ? err.message : err);
    return detected;
  });
  return { brainId, ...cleanProfile(draft), updatedAt: Date.now(), updatedBy: "agent" };
}

// ---------------------------------------------------------------------------
// Storage and the brain page

const COMMAND_LABELS: Record<RepoCommandName, string> = {
  install: "Install",
  typecheck: "Typecheck",
  lint: "Lint",
  test: "Test (all)",
  testFile: "Test one file",
  build: "Build",
  e2e: "End-to-end",
};

const bullets = (items: string[], empty: string) => (items.length ? items.map((item) => `- ${item}`).join("\n") : `_${empty}_`);

export function renderProfile(profile: RepoProfile, folder: string): string {
  const commands = COMMAND_NAMES.filter((name) => profile.commands[name]);
  const { limits } = profile;
  const when = new Date(profile.updatedAt).toISOString().slice(0, 10);
  return `What “correct” means in this repo. TOT runs these commands to check agents' work, and asks the user before changes outside these limits. This page is rewritten from the repo profile in the brain's settings; edit it there.

## Commands
${commands.length ? `Run in ~/${folder.replace(/^\//, "")}.${profile.commands.testFile ? " {file} stands for one test file's path." : ""}\n\n| Check | Command |\n|---|---|\n${commands.map((name) => `| ${COMMAND_LABELS[name]} | \`${profile.commands[name]!.replaceAll("|", "\\|")}\` |`).join("\n")}` : "_None yet._"}

## Conventions
${bullets(profile.conventions, "None yet.")}

## Protected paths
${profile.protectedPaths.length ? `Ask the user before changing:\n${profile.protectedPaths.map((glob) => `- \`${glob}\``).join("\n")}` : "_None._"}

## Definition of done
${bullets(profile.definitionOfDone, "None yet.")}

## Limits
- At most ${limits.maxChangedLines.toLocaleString("en-US")} changed lines and ${limits.maxChangedFiles} changed files per task (lockfiles don't count); more needs the user's OK
- New dependencies: ${limits.allowNewDependencies ? "allowed" : "ask the user first"}
- Each command stops after ${limits.commandTimeoutMinutes} minute${limits.commandTimeoutMinutes === 1 ? "" : "s"}

_${profile.updatedBy === "user" ? "Edited by the user" : "Drafted from the code"} on ${when}_`;
}

function toProfile(row: Row): RepoProfile {
  return {
    brainId: String(row.brain_id),
    ...cleanProfile(parseJson<Partial<RepoProfileInput>>(row.profile, {})),
    updatedAt: Number(row.updated_at),
    updatedBy: row.updated_by === "user" ? "user" : "agent",
  };
}

export const repoProfiles = {
  get(brainId: string): RepoProfile | null {
    repoBrain(brainId);
    const row = db.prepare(`SELECT * FROM repo_profiles WHERE brain_id = ?`).get(brainId) as Row | undefined;
    return row ? toProfile(row) : null;
  },

  /** Saves a profile and rewrites the brain's "Repo profile" page to match. */
  save(brainId: string, input: Partial<RepoProfileInput>, by: RepoProfile["updatedBy"]): RepoProfile {
    const brain = repoBrain(brainId);
    const clean = cleanProfile(input);
    const now = Date.now();
    db.prepare(
      `INSERT INTO repo_profiles (brain_id, profile, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(brain_id) DO UPDATE SET profile = excluded.profile, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(brainId, JSON.stringify(clean), by, now);
    const profile: RepoProfile = { brainId, ...clean, updatedAt: now, updatedBy: by };

    const page = { title: PROFILE_TITLE, summary: PROFILE_SUMMARY, content: renderProfile(profile, brainFolder(brain)) };
    const existing = wiki.withTitle(brainId, PROFILE_TITLE, null)[0];
    if (existing) wiki.update(existing.id, page, by);
    else wiki.create(brainId, page, by);
    appEvents.brainChanged(brainId, { structure: !existing });
    return profile;
  },
};

/** "Run now": one command in the repo's folder on the agent's computer, with the profile's timeout. */
export async function runProfileCommand(brainId: string, command: string, agentId?: string): Promise<CommandRun> {
  const brain = repoBrain(brainId);
  const line = text(command ?? "", MAX_COMMAND, "The command");
  if (!line) throw new HttpError(400, "Enter a command to run.");
  if (line.includes("{file}")) throw new HttpError(400, "That command runs on one test file ({file}); TOT fills that in during tasks.");
  const agent = agentFor(brain, agentId);
  const folder = brainFolder(brain);
  await requireFolder(agent, folder);
  const minutes = repoProfiles.get(brainId)?.limits.commandTimeoutMinutes ?? DEFAULT_LIMITS.commandTimeoutMinutes;
  const result = await exec(agent, line, { cwd: folder, timeoutMs: minutes * 60_000 });
  return { command: scrub(line), exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, outputTail: tail(output(result)) };
}

/** After Learn a repo writes its pages: draft the profile, unless the user has already shaped one. */
export async function draftAfterLearning(brainId: string, agentId: string): Promise<void> {
  if (repoProfiles.get(brainId)?.updatedBy === "user") return;
  repoProfiles.save(brainId, await draftProfile(brainId, agentId), "agent");
}

/** A profile read from a folder now (not saved): a task's worktree whose repo has no saved profile yet (module 09). */
export async function detectProfileIn(agentId: string, folder: string, grant?: FolderGrant | null): Promise<RepoProfileInput> {
  return cleanProfile(detectProfile(await scanRepo(agentId, folder, grant)));
}

/** The profile for a repo folder: its brain's saved one, or one read from the folder now (not saved). */
export async function profileForFolder(agentId: string, folder: string): Promise<{ brainId: string | null; profile: RepoProfileInput }> {
  const clean = folder.trim().replace(/^~\/?/, "").replace(/\/+$/, "");
  const brain =
    brains.list().find((b) => b.kind === "repo" && b.source && (repoFolder(b.source) === clean || brainFolder({ ...b, source: b.source }) === clean)) ?? null;
  const saved = brain ? repoProfiles.get(brain.id) : null;
  if (saved) return { brainId: brain!.id, profile: saved };
  return { brainId: brain?.id ?? null, profile: detectProfile(await scanRepo(agentId, clean)) };
}
