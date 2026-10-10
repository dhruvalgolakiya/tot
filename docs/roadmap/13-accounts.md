# 13 · Provider accounts: several Claude and ChatGPT sign-ins, like T3 Code

**Lane:** worktree `tot-accounts`, branch `feat/provider-accounts`, from `main` after the Lead project page (5d144db). **Depends on:** 02 (tiers, failover), 05 (forks resume per session). Read [README.md](README.md) first.

## Goal

The user runs several subscriptions in T3 Code: "Cladue 20x" (the default `~/.claude` login), "Claude Mix" (a Claude Code folder whose `settings.json` points at the local CCS proxy), and Codex. TOT should use the same sign-ins, and the MCP servers connected to them, without the user setting anything up twice.

Decided with the user (2026-10-10): accounts are config folders, modelled on T3 Code's `providerInstances`; two built-in accounts keep every existing chat and setting working; import from T3 Code.

## Model

- `ProviderAccount { id, driver: "claude" | "chatgpt", name, configDir, binaryPath, useAccountTools, enabled, builtIn }` (`shared/types.ts`, "Provider accounts"). Stored as one JSON row in `settings` (key `accounts`) by `server/accounts/accounts.ts`.
- The built-ins have ids `claude` and `chatgpt` and use the default folders. Every provider id stored before (conversations, messages, `limits.json`, model ids `claude:<model>`) is one of them, so nothing migrates. `ProviderId` stays the driver.
- Model ids are `<account>:<model>` (`claude-mix:claude-opus-5-5`); `parseModelId` returns `{ provider, account, model }`. A `Route` carries `account`; a conversation keeps `provider_account` (its session lives in that account's folder, so only that account resumes it); a reply keeps `account`.
- Usage limits are kept per account. When one hits its limit, another signed-in account of the same provider takes the turn (same model when it has it) before Auto moves to the other provider. Auto runs each provider on `settings.models.accounts[provider]` ("Accounts for Auto and tasks"), with another account of the same provider standing in when that one is limited or signed out.

## How each account runs

- **Claude** (`server/agent/providers/claude.ts`, `makeClaudeProvider`): `CLAUDE_CONFIG_DIR=<folder>`, plus the `env` block of `<folder>/settings.json` merged into the child's environment (the CCS proxy). `settingSources: []` stays: no `CLAUDE.md`, no settings hooks. With the account's tools on, the `mcpServers` of `<folder>/.claude.json` (the default folder: `~/.claude.json`) and of `settings.json` join TOT's (TOT's keep a clashing name; the account's becomes `account_<name>`), and its enabled plugins load through the SDK's `plugins` option from `plugins/installed_plugins.json`. The built-in account is unchanged: it strips `ANTHROPIC_*` and honours `TOT_CLAUDE_CONFIG_DIR` and API-key mode.
- **ChatGPT** (`chatgpt.ts`, `makeChatgptProvider`): one `codex app-server` per account, `CODEX_HOME=<folder>`, the same lockdown flags. With the account's tools on, its `config.toml` MCP servers stay on (pre-approved) instead of being switched off per thread. Sign-in runs against that account's app-server. Idle servers are reaped per account; a changed folder restarts it.
- Env values and MCP headers from these files go to the CLI process only: never logs, the database or the API. `GET /api/accounts` returns env key names and server names.

## API and UI

- `server/accounts/routes.ts`: `GET/POST /api/accounts`, `PATCH/DELETE /api/accounts/:id`, `POST /api/accounts/:id/login` (ChatGPT: a URL; Claude: the command `CLAUDE_CONFIG_DIR=… claude`), `POST /api/accounts/folders/pick`, `GET/POST /api/accounts/import/t3` (`server/accounts/t3.ts` reads `~/.t3/userdata/settings.json`, never writes it). Paired devices may read, not change.
- Settings → **Models & accounts**: one panel per provider listing its accounts (name, folder, Signed in / Proxy / Not signed in, MCP servers), each with a "…" menu (Rename, Sign in, Use this account's MCP servers, Turn off, Remove). **Add account** and **Import from T3 Code** above. "Accounts for Auto and tasks" in the tiers section.
- The header model menu groups models by account name.

## Milestones

- [x] M1 Accounts store, routing by account, per-account Claude env / Codex homes, MCP servers and plugins from the account, limits per account with same-provider fallback. `server/accounts.test.ts`.
- [x] M2 Settings → Models & accounts, grouped model menu, import from T3 Code, docs (install → Accounts).

## Not done

- Claude sign-in for an added folder happens in Terminal (TOT shows the command); there's no in-app Claude login.
- Model tiers are still per provider, not per account (the account's models are the same ids).
- Plugins load with their skills and hooks; TOT has no switch to load only their MCP servers.
