import { deviceName } from "./identity.ts";
import { peers } from "./peers.ts";

/**
 * The `# Device` section of an agent's prompt (roadmap module 07), always the same shape. Only once this
 * device has paired devices: then the user may be talking from another computer, and "this machine" needs a name.
 */
export function deviceSection(): string | null {
  if (peers.list().length === 0) return null;
  return `# Device\nYou run on ${deviceName()}. Your computer, folders and logins are on this machine.`;
}
