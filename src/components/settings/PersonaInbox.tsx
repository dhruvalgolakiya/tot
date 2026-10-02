import { useEffect, useState } from "react";
import { Inbox } from "lucide-react";
import type { MailSummary, Persona } from "@shared/types";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { api, errorMessage } from "../../lib/api";
import { useStore } from "../../store";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { SearchInput } from "../ui/SearchInput";
import { Skeleton } from "../ui/Skeleton";
import { PersonaMailModal } from "./PersonaMailModal";
import { PersonaMailRow } from "./PersonaMailRow";

/** Connected: search + the message list, kept live by the `mail` AppEvent. */
export function PersonaInbox({ persona }: { persona: Persona }) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), 250);
  const [mail, setMail] = useState<MailSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedMailId, setSelectedMailId] = useState<string | null>(null);
  const mailEvent = useStore((s) => s.mailEvent);

  function load() {
    setLoadError(null);
    api.listPersonaMail(persona.id, { q: debouncedQuery || undefined }).then(setMail, (err: unknown) => setLoadError(errorMessage(err)));
  }

  // Switching personas starts fresh (skeleton instead of the previous persona's stale list).
  useEffect(() => {
    setMail(null);
    setLoadError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset keyed only on the persona
  }, [persona.id]);

  // Reload on persona switch and on every settled search query; keeps the previous
  // results on screen while a new query is in flight, instead of flashing a skeleton.
  useEffect(load, [persona.id, debouncedQuery]);

  // Live updates: insert new mail from this persona at the top, unless a search is
  // narrowing the list (the new message may not match it).
  useEffect(() => {
    if (!mailEvent || mailEvent.personaId !== persona.id || debouncedQuery) return;
    setMail((list) => {
      if (!list || list.some((m) => m.id === mailEvent.mail.id)) return list;
      return [mailEvent.mail, ...list];
    });
  }, [mailEvent, persona.id, debouncedQuery]);

  function markRowRead(mailId: string) {
    setMail((list) => list?.map((m) => (m.id === mailId ? { ...m, unread: false } : m)) ?? list);
  }

  return (
    <div className="space-y-3">
      <SearchInput
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search mail"
        aria-label="Search mail"
      />

      {loadError && (
        <Callout tone="danger" action={<button type="button" onClick={load} className="link-muted">Try again</button>}>
          {loadError}
        </Callout>
      )}

      {!mail && !loadError && (
        <div className="space-y-1.5" aria-busy="true" aria-label="Loading mail">
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      )}

      {mail && mail.length === 0 && (
        <EmptyState
          variant="dashed"
          size="sm"
          icon={<Inbox />}
          title={debouncedQuery ? `No mail matches “${debouncedQuery}”.` : "No mail yet"}
          description={debouncedQuery ? undefined : `New mail to ${persona.email} shows up here.`}
        />
      )}

      {mail && mail.length > 0 && (
        <ul className="space-y-0.5">
          {mail.map((message) => (
            <PersonaMailRow key={message.id} mail={message} onOpen={() => setSelectedMailId(message.id)} />
          ))}
        </ul>
      )}

      <PersonaMailModal personaId={persona.id} mailId={selectedMailId} onClose={() => setSelectedMailId(null)} onRead={markRowRead} />
    </div>
  );
}
