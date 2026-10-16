import type { TaskInfo } from "@tot/shared/types";

/**
 * What a coding task is told about its worktree (module 09), in its task instructions: its ports, how
 * to show the user a running app, and how the worktree's setup went. Prepared before its first turn
 * (prepareTask), so a setup that failed is in the prompt that turn starts with.
 */
export function worktreeNotes(task: Pick<TaskInfo, "ports" | "setup">): string {
  const { ports, setup } = task;
  const lines: string[] = [];
  if (ports) {
    const last = ports.base + ports.count - 1;
    lines.push(
      `- Your ports are ${ports.base}–${last}: your commands get PORT=${ports.base} and TOT_PORTS=${ports.base}-${last}. Start servers on those only (other tasks have their own), e.g. \`npm run dev -- --port $PORT\`.`,
    );
  }
  lines.push(
    "- To let the user try your branch in a browser, start its dev server with task_preview_start: TOT keeps it running in your worktree and shows them a Preview link. Don't leave servers running in the background yourself.",
  );
  if (setup?.command && setup.state === "done") lines.push(`- TOT ran \`${setup.command}\` in your worktree when it was made.`);
  if (setup?.state === "failed") {
    lines.push(
      `- ${setup.command ? `TOT ran \`${setup.command}\` in your worktree when it was made, and it failed` : "Setting up your worktree failed"}:\n<setup_output>\n${setup.error ?? ""}\n</setup_output>\n  Sort that out first (fix it, or run the setup again) before you rely on the dependencies.`,
    );
  } else if (setup?.error) {
    lines.push(`- Setting up your worktree: ${setup.error}`);
  }
  return lines.join("\n");
}
