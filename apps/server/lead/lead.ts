import type { Agent, Project } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { appEvents } from "../app-events.ts";
import { agents } from "../data/agents.ts";
import { brains } from "../data/brains.ts";
import { conversations, toPublicConversation, type ConversationRecord } from "../data/conversations.ts";
import { settings } from "../data/settings.ts";
import { db, type Row } from "../db.ts";
import { projects } from "../projects/projects.ts";

/**
 * A project's Lead (roadmap module 11, lane D): the pinned chat the user runs the project from. It's
 * made once per project, with the agent the user is looking from (or the one that works in the project
 * most), and is a normal chat otherwise: its system prompt gets the Lead's section (prompt.ts), it gets
 * the Lead's tools (tools.ts), and it hears about every task in the project (wake.ts).
 */

export const LEAD_TITLE = "Lead";

/** The agent with the most chats and tasks in the project, else the first agent. */
function projectAgent(projectId: string): Agent {
  const rows = db
    .prepare(`SELECT agent_id, COUNT(*) AS n FROM conversations WHERE project_id = ? GROUP BY agent_id ORDER BY n DESC, MAX(updated_at) DESC`)
    .all(projectId) as Row[];
  for (const row of rows) {
    const agent = agents.get(String(row.agent_id));
    if (agent) return agent;
  }
  return agents.first();
}

export const leads = {
  /** The project's Lead chat, or null before it's made. */
  of(project: Pick<Project, "id">): ConversationRecord | null {
    const id = conversations.leadOf(project.id);
    return id ? conversations.get(id) : null;
  },

  /**
   * The project's Lead chat, made the first time (pinned, titled "Lead", its new wiki pages going to
   * the project's brain). Synchronous, so two requests at once can't make two.
   */
  open(projectId: string, agentId?: string | null): { lead: ConversationRecord; created: boolean } {
    const project = projects.get(projectId);
    if (!project) throw new HttpError(404, "Project not found.");
    const existing = leads.of(project);
    if (existing) return { lead: existing, created: false };
    if (project.archived) throw new HttpError(400, "This project is archived.");
    const agent = agentId ? agents.get(agentId) : projectAgent(project.id);
    if (!agent) throw new HttpError(404, "Agent not found.");
    const record = conversations.create({
      agentId: agent.id,
      modelId: agent.modelId || settings.get().defaultModelId,
      title: LEAD_TITLE,
      projectId: project.id,
      lead: true,
    });
    const lead = conversations.update(record.id, { pinned: true })!;
    brains.setFocus(lead.id, project.brainId);
    appEvents.publish({ type: "conversation", conversation: toPublicConversation(lead) });
    appEvents.publish({ type: "project", project: projects.get(project.id)! });
    appEvents.agentChanged(agent.id);
    return { lead, created: true };
  },
};
