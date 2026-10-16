import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { messages } from "../data/messages.ts";
import { clip, guarded, reply } from "../mcp/results.ts";
import { skills } from "./skills.ts";

/**
 * skill_read: the files of a skill this chat invoked (its references and scripts), read-only. Neither provider gets
 * file tools on this Mac and the agent's computer can't see its home folder, so a skill's folder is reached here.
 * Only chats that invoked a skill have the tool.
 */

const FILE_LIMIT = 50_000;
const LIST_LIMIT = 200;

/** A path inside the folder (both resolved through symlinks), or null when it points outside. */
function inside(dir: string, path: string): string | null {
  const root = realpathSync(dir);
  const target = realpathSync(isAbsolute(path) ? path : join(dir, path));
  return target === root || target.startsWith(root + sep) ? target : null;
}

/** The folder's files, a few levels deep, with sizes. */
function listing(root: string): string {
  const lines: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const name of readdirSync(dir).sort()) {
      if (lines.length >= LIST_LIMIT || name.startsWith(".")) continue;
      const path = join(dir, name);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (!stat) continue;
      const shown = relative(root, path);
      if (stat.isDirectory()) {
        lines.push(`${shown}/`);
        if (depth < 3) walk(path, depth + 1);
      } else {
        lines.push(`${shown} (${stat.size} bytes)`);
      }
    }
  };
  walk(root, 0);
  return lines.length ? lines.join("\n") : "(empty folder)";
}

export function registerSkillTools(server: McpServer, conversationId: string): void {
  server.registerTool(
    "skill_read",
    {
      title: "Read a skill's file",
      description:
        "Read a file in the folder of a skill the user invoked in this chat (a /name message), e.g. a reference its instructions point to. `path` is relative to the skill's folder; a folder (or no path) lists its files.",
      inputSchema: {
        skill: z.string().min(1).describe('The skill\'s name, e.g. "dh-stack"'),
        path: z.string().optional().describe("File in the skill's folder, e.g. `references/review.md`"),
      },
    },
    ({ skill: name, path }) =>
      guarded(async () => {
        const used = messages.skillsUsed(conversationId);
        const skill = used.some((n) => n.toLowerCase() === name.toLowerCase()) ? skills.find(name) : null;
        if (!skill) {
          return reply(used.length ? `Only the folders of skills used in this chat can be read: ${used.join(", ")}.` : "No skill was used in this chat.", true);
        }
        let target: string | null;
        try {
          target = inside(skill.dir, path?.trim() || ".");
        } catch {
          return reply(`There's no ${path} in ${skill.name}'s folder. Leave path out to list its files.`, true);
        }
        if (!target) return reply(`${path} isn't in ${skill.name}'s folder.`, true);
        if (statSync(target).isDirectory()) return reply(listing(target));
        // A secrets file stays where it is, even inside a skill.
        if (/^\.env(\.|$)/.test(basename(target))) return reply("Environment files aren't readable.", true);
        const content = readFileSync(target);
        if (content.subarray(0, 8192).includes(0)) return reply(`${path} is a binary file (${content.length} bytes).`);
        return reply(clip(content.toString("utf8"), FILE_LIMIT));
      }),
  );
}
