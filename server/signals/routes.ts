import { Hono } from "hono";

/**
 * Module 12 (docs/roadmap/12-coordinator.md), lane A: a project's signals (what its Lead heard about on its own)
 * and its subscriptions (which pull requests it watches). Route docs: shared/types.ts.
 */
export const signalRoutes = new Hono();
