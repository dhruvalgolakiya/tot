import { personas } from "../data/personas.ts";
import { slack } from "../slack.ts";
import { deviceName } from "./identity.ts";
import { peers, type Peer } from "./peers.ts";
import { relay } from "./relay.ts";

/**
 * What a paired device needs to warn about jobs that must run on exactly one machine (roadmap module 07):
 * the same Slack bot on both would answer every message twice, and the same mailbox on both would run
 * emailed tasks twice. Names only; no tokens or mail.
 */

export interface DeviceInfo {
  slack: { workspace: string; bot: string } | null;
  mailboxes: string[];
}

export function deviceInfo(): DeviceInfo {
  const status = slack.status();
  return {
    slack: status.state === "connected" && status.workspace && status.botName ? { workspace: status.workspace, bot: status.botName } : null,
    mailboxes: personas
      .list()
      .filter((persona) => persona.mailbox.state === "connected")
      .map((persona) => persona.email.toLowerCase()),
  };
}

/** Warnings about a paired device that just connected, from its info and ours. */
async function warningsFor(peer: Peer): Promise<string[]> {
  const token = peers.tokenFor(peer.id);
  if (!peer.address || !token) return [];
  const res = await fetch(`${peer.address}/api/device-info`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) return [];
  const theirs = (await res.json()) as DeviceInfo;
  const ours = deviceInfo();
  const found: string[] = [];
  if (ours.slack && theirs.slack && ours.slack.workspace === theirs.slack.workspace && ours.slack.bot === theirs.slack.bot) {
    found.push(`${deviceName()} and ${peer.name} both run @${ours.slack.bot} in ${ours.slack.workspace}'s Slack, so every message gets two answers. Disconnect Slack on one of them.`);
  }
  for (const mailbox of ours.mailboxes.filter((address) => theirs.mailboxes?.includes(address))) {
    found.push(`${deviceName()} and ${peer.name} both check ${mailbox}, so emailed tasks can run twice. Disconnect that mailbox on one of them.`);
  }
  return found;
}

relay.useInfoCheck(warningsFor);
