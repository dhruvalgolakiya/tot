import type { SkillInfo } from "@tot/shared/types";

/**
 * Skills a message invokes by starting with "/name" (GET /api/skills): the server puts the skill's SKILL.md into that
 * turn. The composer picks them from the "/" menu, alongside /best-of.
 */

/** The message's first word while the caret is in it and it starts with "/" ("/dh" → "dh"), or null. A path isn't one. */
export function slashWordAt(text: string, caret: number): { query: string; end: number } | null {
  const match = /^\/([^\s/]*)/.exec(text);
  if (!match || caret < 1 || caret > match[0].length || text[match[0].length] === "/") return null;
  return { query: match[1]!, end: match[0].length };
}

/** Each letter right after the one before, or at the start of a later word: "ds" and "dhst" in "dh-stack", not "dh" in "edit-in-houdini". */
function wordStarts(needle: string, hay: string, from = 0): boolean {
  if (!needle) return true;
  for (let i = from; i < hay.length; i++) {
    const wordStart = i === 0 || /[-_.: ]/.test(hay[i - 1]!);
    if (hay[i] === needle[0] && (wordStart || (from > 0 && i === from)) && wordStarts(needle.slice(1), hay, i + 1)) return true;
  }
  return false;
}

/** The picker's skills for a query: names that start with it (a plugin's skill by its own name too), contain it, match it by word starts, then descriptions that mention it. */
export function skillMatches(skills: SkillInfo[], query: string, limit = 100): SkillInfo[] {
  const needle = query.toLowerCase();
  if (!needle) return skills.slice(0, limit);
  const rank = (skill: SkillInfo): number => {
    const name = skill.name.toLowerCase();
    const own = name.slice(name.indexOf(":") + 1);
    if (name.startsWith(needle) || own.startsWith(needle)) return 0;
    if (name.includes(needle)) return 1;
    if (wordStarts(needle, name)) return 2;
    return skill.description.toLowerCase().includes(needle) ? 3 : -1;
  };
  return skills
    .map((skill) => ({ skill, rank: rank(skill) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.skill.name.localeCompare(b.skill.name))
    .slice(0, limit)
    .map((entry) => entry.skill);
}

/** The skill a message starts with ("/dh-stack fix it" → "dh-stack"), when the list has it; null otherwise. */
export function typedSkill(skills: SkillInfo[] | null, text: string): string | null {
  const name = /^\/([^\s/]+)(?:\s|$)/.exec(text.trimStart())?.[1]?.toLowerCase();
  return (name && skills?.find((skill) => skill.name.toLowerCase() === name)?.name) || null;
}

/** A sent message's text without the "/name" its chip already shows. */
export function withoutSkill(text: string, skill: string): string {
  const prefix = `/${skill.toLowerCase()}`;
  const start = text.trimStart();
  if (!start.toLowerCase().startsWith(prefix) || /\S/.test(start.charAt(prefix.length))) return text;
  return start.slice(prefix.length).trim();
}
