## Do I need API keys?

No. TOT runs on your Claude Pro or Max plan and your ChatGPT Plus or Pro plan, the way Claude Code and Codex do. Keys only come in if TOT is ever hosted for other people.

## What does it cost?

The plans you already have. Cloud computers are optional: boat.dev is a paid service, billed by the second while a machine runs. Without one, your agents work in a sandboxed folder on your Mac.

## Where do I download it?

You can't yet. TOT is in private preview: the code isn't public, and the Mac app isn't signed or available to download. A download is coming. See [Install](/docs/install).

## Claude or ChatGPT?

Both, if you have both. **TOT Auto** picks a model for each message, and moves to the other provider when a plan hits its limit. You can also pick a model yourself in any chat.

## Does TOT send my data anywhere?

Your messages go to Claude or ChatGPT, as they would in their own apps. If you use cloud computers, the commands your agents run go to boat.dev. There's no TOT account and no TOT cloud: your chats, memory and settings stay in `~/.tot` on your Mac.

## Will it touch my files?

Not unless you ask. Agents work on their own computers. If you add a folder on your Mac as a project, agents can read it and make branches in its git repo, but they can't change your checked-out files. See [Safety](/docs/safety).

## Can I leave it running overnight?

Yes. Tasks wait in a queue, switch providers when a plan runs out, pick up again after a restart, and tell you how they went. Your agents won't merge a pull request or send an email without you.

## Can it push to GitHub?

Only if you turn on **Agents can push and open pull requests** in **Settings → GitHub**. It's off by default. Even then, TOT never merges on GitHub.

## Can I use it on my phone?

Yes. Set up remote access in **Settings → Devices**, then scan the code with your phone. It works in the browser, and from your home screen as a web app. See [Use it from your phone](/docs/devices).

## Does it work on Windows or Linux?

No. TOT runs on macOS only, for now.

## Can my team use it?

No. TOT is for one person, on their own computers and their own plans.

## Why the mascots?

So you can tell your agents apart at a glance, and see which ones are busy. Also, a spinner can't look guilty when the tests fail.
