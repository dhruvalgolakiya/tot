import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { computerManager } from "../computer/manager.ts";
import type { UploadRecord } from "../data/uploads.ts";

/**
 * How attachments reach the agent: images go straight to the model, small text
 * files are inlined into the prompt, and everything else is copied onto the
 * agent's computer (~/uploads) so it can work with the file there.
 */

const VISION_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_VISION_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_TEXT_BYTES = 100 * 1024;
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|toml|x-sh|sql|csv|x-ndjson))/;
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".js", ".jsx",
  ".ts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".cs", ".php", ".sh", ".sql",
  ".log", ".ini", ".env.example",
]);

export interface PreparedAttachments {
  images: { path: string; mimeType: string }[];
  /** Text to put before the user's message: inlined files and where the rest were saved. */
  context: string;
}

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function isText(file: UploadRecord): boolean {
  return TEXT_TYPES.test(file.mimeType) || TEXT_EXTENSIONS.has(extname(file.name).toLowerCase());
}

export async function prepareAttachments(files: UploadRecord[], agentId: string): Promise<PreparedAttachments> {
  const images: PreparedAttachments["images"] = [];
  const blocks: string[] = [];

  for (const file of files) {
    if (VISION_TYPES.has(file.mimeType) && file.size <= MAX_VISION_BYTES) {
      images.push({ path: file.path, mimeType: file.mimeType });
      continue;
    }
    if (isText(file) && file.size <= MAX_INLINE_TEXT_BYTES) {
      blocks.push(`<attachment name="${file.name}">\n${readFileSync(file.path, "utf8")}\n</attachment>`);
      continue;
    }
    const target = `uploads/${file.name}`;
    try {
      const { backend, externalId } = await computerManager.ensure(agentId);
      await backend.upload(externalId, target, readFileSync(file.path));
      blocks.push(`[The user attached ${file.name} (${formatSize(file.size)}). It's on your computer at ~/${target}.]`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      blocks.push(`[The user attached ${file.name} (${formatSize(file.size)}), but it couldn't be put on your computer: ${reason}]`);
    }
  }

  return { images, context: blocks.join("\n\n") };
}
