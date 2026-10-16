import clsx from "clsx";

type Row = { text: string; kind: "h1" | "h2" | "done" | "next" | "later" | "comment" | "blank" };

const DOC: Row[] = [
  { kind: "h1", text: "# Roadmap" },
  { kind: "blank", text: "" },
  { kind: "h2", text: "## Shipped" },
  { kind: "done", text: "- [x] Agents, mascots and personalities" },
  { kind: "done", text: "- [x] A computer per agent, with a live desktop" },
  { kind: "done", text: "- [x] Brains: wiki, memory and Learn a repo" },
  { kind: "done", text: "- [x] Routines, attachments, voice and phone access" },
  { kind: "done", text: "- [x] Slack, email and agent personas" },
  { kind: "done", text: "- [x] Apps, MCP plugins and connectors" },
  { kind: "done", text: "- [x] Chats and tasks: branches, queue, steer, pause" },
  { kind: "done", text: "- [x] Orchestration: tiers, subagents, handoffs, failover" },
  { kind: "done", text: "- [x] Trust gates: repo profiles, test gates, cross-provider review" },
  { kind: "done", text: "- [x] Coordination: wake-ups, forks, attached chats" },
  { kind: "blank", text: "" },
  { kind: "h2", text: "## Next (being built)" },
  { kind: "next", text: "- [ ] Playbooks drive every task: plan, build, test, then an independent review, before you see a thing" },
  {
    kind: "next",
    text: "- [ ] Pull requests without leaving TOT: the diff, a draft PR with the evidence, CI checks, fixing review comments, updating the branch",
  },
  { kind: "next", text: "- [ ] Keyboard shortcuts for all of it, and an optional “fix failing checks once”" },
  { kind: "blank", text: "" },
  { kind: "h2", text: "## Later (on the whiteboard)" },
  {
    kind: "later",
    text: "- [ ] Projects: agent → project → session, with a repo's brain, instructions and default branch shared by every agent on it",
  },
  { kind: "later", text: "- [ ] TOT for everyone: hosted, bring your own API keys or sign in with ChatGPT, still one computer per agent" },
  { kind: "blank", text: "" },
  { kind: "comment", text: "<!-- merging stays with you. forever. -->" },
];

const TONE: Record<Row["kind"], string> = {
  h1: "font-semibold text-fg-strong",
  h2: "font-semibold text-fg",
  done: "text-fg-muted",
  next: "text-fg",
  later: "text-fg-muted",
  comment: "text-fg-faint italic",
  blank: "",
};

/** The roadmap as a markdown file in an editor. */
export function RoadmapApp() {
  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <div className="flex h-9 shrink-0 items-end gap-1 border-b border-hairline bg-panel px-2">
        <span className="rounded-t-lg border border-b-0 border-hairline bg-canvas px-3 py-1.5 text-xs text-fg">Roadmap.md</span>
        <span className="px-3 py-1.5 text-xs text-fg-subtle">PLAN.md</span>
      </div>
      <ol className="flex-1 py-3 font-mono text-[13px] leading-6">
        {DOC.map((row, index) => (
          <li key={index} className="flex gap-4 pr-5">
            <span className="w-9 shrink-0 text-right text-fg-faint tabular-nums select-none">{index + 1}</span>
            <span className={clsx("min-w-0 flex-1 whitespace-pre-wrap", TONE[row.kind])}>
              <Marked row={row} />
            </span>
          </li>
        ))}
      </ol>
      <div className="flex h-7 shrink-0 items-center gap-4 border-t border-hairline bg-panel px-3 text-2xs text-fg-subtle">
        <span>Markdown</span>
        <span>10 done · 5 to go</span>
        <span className="ml-auto">Tot is editing…</span>
      </div>
    </div>
  );
}

/** Colors the checkbox at the start of a task line. */
function Marked({ row }: { row: Row }) {
  if (row.kind !== "done" && row.kind !== "next" && row.kind !== "later") return <>{row.text || " "}</>;
  const box = row.text.slice(0, 5);
  return (
    <>
      <span className={row.kind === "done" ? "text-success" : row.kind === "next" ? "text-warning" : "text-fg-subtle"}>{box}</span>
      {row.text.slice(5)}
    </>
  );
}
