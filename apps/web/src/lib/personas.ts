import type { PersonaMailbox } from "@shared/types";
import type { DotTone } from "./computer";

/** Basic shape check, not a full RFC validator — good enough to catch typos in an allow-list. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function isGmailAddress(email: string): boolean {
  return /@gmail\.com$/i.test(email.trim());
}

/** Dot color/pulse + label for a persona's mailbox state, for the detail header and list rows. */
export function mailboxStatus(mailbox: PersonaMailbox): { tone: DotTone; pulse: boolean; label: string } {
  switch (mailbox.state) {
    case "connected":
      return { tone: "green", pulse: false, label: "Connected" };
    case "connecting":
      return { tone: "amber", pulse: true, label: "Connecting…" };
    case "error":
      return { tone: "red", pulse: false, label: mailbox.error ?? "Needs attention" };
    case "not-connected":
      return { tone: "gray", pulse: false, label: "Not connected" };
  }
}

/** Two letters for an avatar when there's no photo, e.g. "Tot Agent" -> "TA", "scout" -> "S". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0][0].toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
