import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";

/** Screenshots agents take of their desktops, kept so the UI can show them. */

const ROOT = join(DATA_DIR, "screens");
const KEEP_PER_AGENT = 50;

export function saveScreenshot(agentId: string, png: Buffer): string {
  const dir = join(ROOT, agentId);
  mkdirSync(dir, { recursive: true });
  const file = `${Date.now()}.png`;
  writeFileSync(join(dir, file), png);
  const files = readdirSync(dir).filter((name) => name.endsWith(".png")).sort();
  for (const old of files.slice(0, -KEEP_PER_AGENT)) unlinkSync(join(dir, old));
  return `/api/agents/${agentId}/computer/screens/${file}`;
}

/** Absolute path of a stored screenshot, or null (also for anything that isn't a plain id/file name). */
export function screenshotFile(agentId: string, file: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(agentId) || !/^\d+\.png$/.test(file)) return null;
  const path = join(ROOT, agentId, file);
  return existsSync(path) ? path : null;
}

export function deleteScreenshots(agentId: string): void {
  if (/^[0-9a-f-]{36}$/i.test(agentId)) rmSync(join(ROOT, agentId), { recursive: true, force: true });
}
