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

/** a, b, c in order anywhere in the text ("dhs" in "dh-stack"). */
function inOrder(needle: string, hay: string): boolean {
  let at = 0;
  for (const char of hay) if (char === needle[at]) at++;
  return at === needle.length;
}

/** The picker's skills for a query: names that start with it (a plugin's skill by its own name too), contain it, have its letters in order, then descriptions that mention it. */
export function skillMatches(skills: SkillInfo[], query: string, limit = 50): SkillInfo[] {
  const needle = query.toLowerCase();
  if (!needle) return skills.slice(0, limit);
  const rank = (skill: SkillInfo): number => {
    const name = skill.name.toLowerCase();
    const own = name.slice(name.indexOf(":") + 1);
    if (name.startsWith(needle) || own.startsWith(needle)) return 0;
    if (name.includes(needle)) return 1;
    if (inOrder(needle, name)) return 2;
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
