# Security policy

TOT runs agents with access to computers, files, GitHub, Slack, mail and your Claude and ChatGPT logins, so security reports matter a lot to us.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub instead: on this repository's **Security** tab, choose **Report a vulnerability** ([direct link](https://github.com/dhruvalgolakiya/tot/security/advisories/new)). That opens a private security advisory only the maintainers can see.

Include what you can of:

- what the issue is and what an attacker could do with it;
- the steps or a proof of concept to reproduce it;
- the version (the Mac app's About box, or the commit) and how TOT was running (`npm run dev`, `npm start`, the Mac app, remote access on or off).

We aim to acknowledge a report within a few days, keep you updated while we work on a fix, and credit you in the advisory once it's published, unless you'd rather stay anonymous.

## Supported versions

Fixes go into `main` and the next Mac app release. Older releases don't get separate patches: the Mac app updates itself.

## Scope

In scope: the TOT server, the web app, the Mac app and the phone app in this repository, including sign-in, remote access, device pairing, the agents' sandboxing and the MCP tool endpoint.

Out of scope: issues in Claude Code, Codex, boat.dev or other third-party services themselves (report those to their vendors), and attacks that need access to the computer TOT runs on (requests from that computer itself are trusted by design).
