import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { Conversation, Project } from "@shared/types";
import { useAttachments } from "../../hooks/useAttachments";
import { api, errorMessage } from "../../lib/api";
import { setNewProjectChat, useLeadUi } from "../../lib/lead";
import { isCodeProject, PROJECT_ICONS, useProjects } from "../../lib/projects";
import { navigateToAgentHome, selectActiveAgent, sendMessage, showLead, useStore } from "../../store";
import { Composer } from "../Composer";
import { defaultMascot, MascotStage } from "../mascot";
import { MessageList } from "../MessageList";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { Skeleton } from "../ui/Skeleton";
import { FolderConsentDialog } from "./FolderConsent";

/**
 * A project's page (roadmap module 11): just its Lead chat, the chat the user runs the project from. Its other
 * chats are in the sidebar under the project, its tasks in Mission control; Repos, Knowledge and "New chat" are
 * in the header's project menu. Opening the page makes the Lead the first time (POST /api/projects/:id/lead) and
 * opens it as the current chat, so the composer, the messages and the live reply work as in any chat. "New chat"
 * swaps the Lead for a new chat in the project. Mounted in the main column while `page === "project"` (see App.tsx).
 */
export function ProjectPage() {
  const projectId = useStore((s) => s.projectId);
  const agent = useStore(selectActiveAgent);
  const project = useProjects((s) => s.projects.find((p) => p.id === projectId));
  const state = useProjects((s) => s.state);

  if (project) return <ProjectScreen key={project.id} project={project} />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pt-20 pb-12 sm:px-6 md:pt-24">
        {state === "loading" ? (
          <div aria-busy="true" aria-label="Loading the project" className="space-y-4">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-16 rounded-3xl" />
          </div>
        ) : (
          <EmptyState
            title="This project isn't here anymore"
            description="It may have been removed, or the link is wrong."
            action={
              agent && (
                <Button size="sm" onClick={() => navigateToAgentHome(agent.id)}>
                  Back to {agent.name}
                </Button>
              )
            }
          />
        )}
      </div>
    </div>
  );
}

type LeadState = { status: "loading" } | { status: "ready"; lead: Conversation } | { status: "error"; message: string };

/** The project's Lead chat: made the first time (with the agent the page is seen from), then opened. */
function useLeadChat(project: Project): { state: LeadState; retry: () => void } {
  const [state, setState] = useState<LeadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    api.openLead(project.id, useStore.getState().homeAgentId).then(
      (lead) => !cancelled && setState({ status: "ready", lead }),
      (error: unknown) => !cancelled && setState({ status: "error", message: errorMessage(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [project.id, attempt]);
  return { state, retry: () => setAttempt((n) => n + 1) };
}

function ProjectScreen({ project }: { project: Project }) {
  const newChat = useLeadUi((s) => s.newChat);
  const { state, retry } = useLeadChat(project);

  // A page opens on its Lead.
  useEffect(() => useLeadUi.setState({ newChat: false }), []);
  // The Lead is the open chat while the page shows it.
  useEffect(() => {
    if (state.status === "ready" && !newChat) showLead(state.lead);
  }, [state, newChat]);

  return <LeadArea project={project} state={state} retry={retry} newChat={newChat} />;
}

/** The middle: the Lead (or a new chat in the project), with the project's notices over the composer. */
function LeadArea({ project, state, retry, newChat }: { project: Project; state: LeadState; retry: () => void; newChat: boolean }) {
  const attachments = useAttachments(project.deviceId ?? null);
  const currentId = useStore((s) => s.currentId);
  const lead = state.status === "ready" ? state.lead : null;
  const open = lead && currentId === lead.id ? lead : null;
  const messages = useStore((s) => (open ? s.messages[open.id] : undefined));
  const loaded = useStore((s) => (open ? s.detailState[open.id] === "ready" : false));
  const [consentOpen, setConsentOpen] = useState(false);
  const empty = Boolean(open && loaded && !messages?.length);

  if (!newChat && state.status !== "ready") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4">
        {state.status === "loading" ? (
          <div aria-busy="true" aria-label="Opening the Lead" className="w-full max-w-3xl space-y-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : project.archived ? (
          <EmptyState title="This project is archived" description="Its chats stay here, but nothing new starts in it." />
        ) : (
          <Callout
            tone="danger"
            className="w-full max-w-md"
            action={
              <button type="button" onClick={retry} className="link-muted">
                Try again
              </button>
            }
          >
            Couldn't open the Lead. {state.message}
          </Callout>
        )}
      </div>
    );
  }

  const notice = project.archived ? (
    <Callout className="mb-2">This project is archived. Its chats stay here, but nothing new starts in it.</Callout>
  ) : project.kind === "folder" && !project.folderGranted ? (
    <Callout
      className="mb-2"
      action={
        <button type="button" onClick={() => setConsentOpen(true)} className="link-muted">
          Allow…
        </button>
      }
    >
      Agents can't work in this folder until you allow it.
    </Callout>
  ) : null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {newChat ? (
        <NewChatHero project={project} />
      ) : open && !empty ? (
        <MessageList conversationId={open.id} topPadding="pt-20" />
      ) : (
        <LeadHero project={project} />
      )}
      <div className="relative z-10 shrink-0 px-3 pb-2 sm:px-4">
        <div className="mx-auto w-full max-w-3xl">
          {notice}
          {!project.archived && (newChat || open) && (
            <Composer
              key={newChat ? "new-chat" : open?.id}
              attachments={attachments}
              placeholder={newChat ? "Ask anything" : `Ask the Lead of ${project.name}…`}
            />
          )}
        </div>
      </div>
      {/* Room under the composer for the hero to sit above it, as on an agent's home. */}
      {(newChat || empty) && <div className="flex flex-1 flex-col pt-4">{empty && !project.archived && <LeadStarters project={project} />}</div>}
      {!newChat && !empty && <div className="h-2 shrink-0" />}
      <FolderConsentDialog project={project} open={consentOpen} onOpenChange={setConsentOpen} />
    </div>
  );
}

/** An empty Lead: who it is and what it does, above the composer. */
function LeadHero({ project }: { project: Project }) {
  const agent = useStore(selectActiveAgent);
  return (
    <div className="flex flex-1 flex-col items-center justify-end px-4 pb-6">
      <MascotStage spec={agent?.mascot ?? defaultMascot} size={96} title={agent?.name ?? "Lead"} />
      <h1 className="mt-5 text-center font-display text-3xl font-semibold text-fg-strong">{project.name}</h1>
      <p className="mt-2 max-w-md text-center text-sm leading-relaxed text-fg-muted">
        {isCodeProject(project)
          ? "The Lead plans the work, runs tasks across the project's repos, and asks you before anything lands."
          : "The Lead plans the work, runs tasks, and keeps track of where things stand."}
      </p>
    </div>
  );
}

function NewChatHero({ project }: { project: Project }) {
  const Icon = PROJECT_ICONS[project.kind];
  return (
    <div className="flex flex-1 flex-col items-center justify-end px-4 pb-8">
      <button
        type="button"
        onClick={() => setNewProjectChat(false)}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-hairline px-3 text-ui text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      >
        <ArrowLeft className="size-3.5" />
        Lead
      </button>
      <h1 className="mt-5 text-center font-display text-3xl font-semibold text-balance text-fg-strong">What should we work on?</h1>
      <p className="mt-2 flex items-center gap-1.5 text-sm text-fg-muted">
        <Icon aria-hidden="true" className="size-4" />
        A new chat in {project.name}
      </p>
    </div>
  );
}

const STARTERS = [
  { label: "Where do things stand?", text: "Where do things stand in this project? Tell me what needs me." },
  { label: "Plan the next step", text: "Read the project's knowledge, then propose the next few tasks. Don't start them yet." },
  { label: "Land what's ready", text: "Check the tasks that are ready to land and propose landing them, one at a time, in order.", code: true },
];

/** First messages for an empty Lead (landing only where there's code). */
function LeadStarters({ project }: { project: Project }) {
  const sending = useStore((s) => s.sending);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-center gap-2 px-3 sm:px-4">
      {STARTERS.filter((starter) => !starter.code || isCodeProject(project)).map(({ label, text }) => (
        <button
          key={label}
          type="button"
          disabled={sending}
          onClick={() => void sendMessage(text)}
          className="inline-flex h-9 shrink-0 items-center rounded-full border border-edge px-3.5 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-50"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
