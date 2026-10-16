import { Hono } from "hono";
import { skills, toSkillInfo } from "./skills.ts";

/** Skills a message can invoke with "/name", mounted on /api; see the route docs in packages/shared/types.ts. */
export const skillRoutes = new Hono();

// Names and one-line descriptions from SKILL.md frontmatter only (no paths), so a paired device may list them too.
skillRoutes.get("/skills", (c) => c.json(skills.list().map(toSkillInfo)));
