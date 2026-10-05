import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { guarded, reply } from "../mcp/results.ts";
import { previews } from "./preview.ts";

/**
 * A coding task's preview tools on TOT's MCP server (module 09): task_preview_start runs its dev server
 * as a background process TOT manages, and shows the user a Preview link; task_preview_stop ends it.
 */
export function registerPreviewTools(server: McpServer, taskId: string): void {
  server.registerTool(
    "task_preview_start",
    {
      title: "Start a preview",
      description:
        "Let the user try your branch in their browser: TOT runs `command` in your worktree as a background process it looks after (the same sandbox as your commands, with PORT set to `port`), waits until http://localhost:<port><path> answers, and shows the user a Preview link on your task. Starting again replaces the one running. Don't add `&` or nohup: TOT keeps it running until task_preview_stop, or until the task lands, is discarded or stopped.",
      inputSchema: {
        command: z.string().min(1).max(500).describe('The dev server, listening on $PORT, e.g. "npm run dev -- --port $PORT --host 127.0.0.1"'),
        port: z.number().int().min(1).max(65535).optional().describe("The port it listens on: one of your task's ports (default: the first, $PORT)"),
        path: z.string().max(200).optional().describe('The page to open, e.g. "/dashboard" (default "/")'),
      },
    },
    ({ command, port, path }) =>
      guarded(async () => {
        const started = await previews.start(taskId, { command, port, path });
        const output = started.output ? `\nIts output so far:\n${started.output}` : "";
        if (!started.ready) {
          return reply(
            `Started \`${command}\`, but nothing answered at ${started.preview.url} within 45 seconds. It's still running, and the user sees its Preview link: check it with curl, then start it again with the right command or port, or stop it with task_preview_stop.${output}`,
          );
        }
        return reply(`Preview running at ${started.preview.url}; the user sees a Preview link on your task. It runs until task_preview_stop, or until the task lands, is discarded or stopped.${output}`);
      }),
  );

  server.registerTool(
    "task_preview_stop",
    {
      title: "Stop the preview",
      description: "Stop the preview you started with task_preview_start; its link goes away.",
      inputSchema: {},
    },
    () =>
      guarded(async () => {
        const output = previews.output(taskId);
        const stopped = await previews.stop(taskId);
        if (!stopped) return reply("No preview was running.");
        return reply(`Stopped the preview.${output ? ` Its last output:\n${output}` : ""}`);
      }),
  );
}
