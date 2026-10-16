# Contributing to TOT

Thanks for helping. Bug reports, fixes and small focused improvements are the easiest to take in; for anything bigger, open an issue first so we can agree on the shape before you build it.

## Setup

You need Node ≥ 22.13 (24 recommended: `nvm use` reads `.nvmrc`) and, to try real turns, a Claude or ChatGPT login (see the [README](README.md#quick-start)).

```bash
npm install
npm run dev          # API on :8787, web app on :5173
```

The repository is an npm workspaces monorepo: `apps/server`, `apps/web`, `apps/desktop`, `apps/site` and `packages/shared`, with one lockfile at the root. The phone app, `apps/mobile`, has its own `package.json` and lockfile: run `npm install` inside it when you work on it. The [README](README.md#repository-layout) has the full layout.

Already running TOT on this computer? Your copy keeps its data in `~/.tot` and its ports. Give a development copy its own:

```bash
TOT_DATA_DIR=$(mktemp -d) TOT_PORT=8801 TOT_WEB_PORT=5181 TOT_EXECUTOR_PORT=4801 npm run dev
```

## Before you open a pull request

```bash
npm run typecheck    # every workspace, plus scripts/
npm test             # every suite; each prints ALL PASS
npm run build        # the web app
```

and, if you touched them, `npm run site:build` (the landing page) and `cd apps/mobile && npx tsc --noEmit` (the phone app).

- **Tests.** Every suite's first import is the server's `test-data-dir.ts`, which refuses to run against `~/.tot`. Use the fakes the existing suites use for the models, GitHub, Slack and mail (`apps/server/slack.test.ts`, `github.test.ts` and `personas.test.ts` show the patterns); tests never call real services. A new suite goes in its package's `test` script with its own `TOT_DATA_DIR=$(mktemp -d)`.
- **Shared types.** The API contract lives in `packages/shared/types.ts` (`@tot/shared/types`); the route docs there change with the routes.
- **Design.** UI follows [docs/DESIGN.md](docs/DESIGN.md): design tokens only, light and dark, few visible actions. Check a visible change in both themes and include screenshots in the pull request.
- **Secrets.** Never commit `.env`, tokens or keys, and never put them in logs, errors or tool output.
- **Style.** Match the code around your change: its naming, comment density and idioms. There's no formatter to run; `.editorconfig` covers the basics. Keep pull requests focused, with no unrelated refactors or dependency upgrades.

## Commits and pull requests

Write commit messages that say what changed and why, in plain words. Describe in the pull request what you changed, how you tested it, and anything a reviewer should look at closely.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
