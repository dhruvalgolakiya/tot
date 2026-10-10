TOT runs on your Mac. You can run it as the Mac app, or from its source code in a terminal. Either way, you log in to Claude and ChatGPT once, with the plans you already have.

> TOT is in private preview. The code isn't public yet, and the Mac app isn't signed or available to download. A download is coming. Until then, the steps below are for people who have access to the code.

## What you need

- **A Mac.** The Mac app is for Apple silicon (M1 or later).
- **A Claude plan, a ChatGPT plan, or both.** Claude Pro or Max, and ChatGPT Plus or Pro. You don't need API keys.
- **Node 22.13 or newer**, if you run TOT from source. Node 24 is recommended. The Mac app brings its own.
- **Optional: a boat.dev account**, if you want your agents to have cloud computers with a desktop. It's a paid service, billed by the second while a machine runs. Without it, agents work in a sandboxed folder on your Mac. See [Computers](/docs/computers).

## Log in to Claude and ChatGPT

TOT talks to Claude through Claude Code, and to ChatGPT through Codex. These are the official command-line apps from Anthropic and OpenAI. TOT uses their logins, so you log in once, in Terminal.

1. **Claude.** Run `claude`, then type `/login` and sign in with your Claude subscription. You're done when `claude` starts without asking you to log in.

   ```bash
   claude
   ```

2. **ChatGPT.** Run `codex login` and sign in with your ChatGPT account. Check it with `codex login status`. You can also do this later from TOT: **Settings → Models & accounts**, then **Sign in** in the ChatGPT account's **…** menu.

   ```bash
   codex login
   codex login status
   ```

You can log in to just one. TOT works with either, and uses both when you have both.

## Accounts

You can give TOT more than one Claude or ChatGPT sign-in, like T3 Code's provider instances. Each one is a folder:

- **A Claude account** is a Claude Code config folder. TOT runs Claude Code with `CLAUDE_CONFIG_DIR` set to it, so it uses that folder's login, and the `env` block of its `settings.json`.
- **A ChatGPT account** is a Codex home. TOT runs Codex with `CODEX_HOME` set to it.

The default folders (`~/.claude` and `~/.codex`) are the built-in **Claude** and **ChatGPT** accounts. Add more in **Settings → Models & accounts → Add account**: pick the provider, give it a name, and choose its folder.

**A proxy, like CCS.** Point a Claude account at a folder whose `settings.json` has an `env` block such as `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. TOT passes that block to Claude Code, so the account talks to the proxy. The account shows **Proxy**, and names the keys it found. TOT never shows or stores their values.

```json
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:…", "ANTHROPIC_AUTH_TOKEN": "…" } }
```

**MCP servers from the account.** With **Use this account's MCP servers** on (the default for added accounts), agents also get the servers set up in that folder, next to TOT's own tools:

- **Claude:** the `mcpServers` in its `.claude.json` (for the default folder, `~/.claude.json`) and its enabled plugins.
- **ChatGPT:** the `[mcp_servers]` in its `config.toml`.

When a name clashes, TOT's own server keeps the name. TOT still never loads the folder's `CLAUDE.md` or hooks.

**Import from T3 Code.** Open the **…** menu next to **Add account** and choose **Import from T3 Code**. TOT lists the Claude and Codex instances T3 Code keeps in their own folders, and adds the ones you pick. It only reads T3 Code's settings.

**Picking an account.** The model menu groups models by account. In Settings, **Accounts for Auto and tasks** picks which account TOT Auto and tasks use. When an account hits its usage limit, TOT moves the reply to another signed-in account of the same provider first. Only then does Auto switch to the other provider.

To sign in an added Claude account, choose **Sign in** in its **…** menu. TOT shows the command to run, for example `CLAUDE_CONFIG_DIR=~/.claude-work claude`, and then you type `/login`.

## Run TOT from source

If you have access to the code, open a terminal in its folder and run:

```bash
npm install
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173) in your browser. TOT's server runs on port 8787 behind it.

For an everyday setup that serves the built app from one port (8787), run:

```bash
npm run build
npm start
```

## Build the Mac app

The Mac app is built from the same code:

```bash
npm run app:build
```

It makes a `.dmg` and a `.zip` in the `release` folder. The build is signed "ad hoc", so it runs on the Mac that built it. On another Mac, right-click the app and choose **Open** the first time. See [The Mac app](/docs/mac-app) for what it does.

## Your first five minutes

1. **Open TOT.** You'll meet Tot, your first agent. This computer never asks you to sign in.
2. **Check your logins.** Open **Settings → Models & accounts**. Each account shows **Signed in**, **Proxy** or **Not signed in**. Choose **Check sign-ins again** in the **…** menu after you log in.
3. **Pick a computer for your agents.** Open **Settings → Computer** and choose:
   - **Local sandboxed folder**: commands run in a locked-down folder on this Mac. No account needed.
   - **Boat cloud VM**: a cloud machine per agent, with a desktop. Paste your **Boat API key**.
   - **Off**: no computer. Agents can still search the web and remember things.
4. **Say hi.** Ask Tot something. Its mascot shows what it's doing while it works.
5. **Optional: use it from your phone.** Open **Settings → Devices → Set up**. See [Use it from your phone](/docs/devices).

## Where your things live

- **Your chats, memory and settings** are in `~/.tot` on your Mac. There's no TOT account and no TOT cloud.
- **Your memory** is a set of git repos of markdown files in `~/.tot/memory`. See [Memory](/docs/memory).
- **The Mac app's log** is at `~/Library/Logs/TOT/server.log`. Open it from the menu bar with **Show log**.

## Limits

- No public download yet, and the code is private.
- The Mac app isn't signed or notarized by Apple, and doesn't update itself.
- macOS only. There's no Windows or Linux version.
- You log in to Claude Code in a terminal. TOT signs ChatGPT accounts in from Settings, but for Claude it only shows the command to run.
- An account's Claude Code plugins load with their skills and hooks. Its `CLAUDE.md` and settings hooks don't.
