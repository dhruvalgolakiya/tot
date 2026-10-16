import type { GateReport, Review } from "@tot/shared/types";

/** One of each state a gate can be in, for the Checks lab (/dev/trust). */
export const SAMPLE_REPORT: GateReport = {
  ok: false,
  at: Date.now(),
  headSha: "4f2a9c1d7e3b",
  baseSha: "9b81e0aa45c2",
  results: [
    { gate: "typecheck", status: "pass", command: "npm run typecheck", exitCode: 0, durationMs: 6400, outputTail: "> shop@1.0.0 typecheck\n> tsc --noEmit" },
    {
      gate: "lint",
      status: "fail",
      command: "npm run lint",
      exitCode: 1,
      durationMs: 2100,
      baseline: "fail",
      newFailures: [],
      note: "Fails the same way on the base branch, so it doesn't block.",
      outputTail: "> shop@1.0.0 lint\n> eslint .\n\nsrc/legacy/report.js\n  12:5  error  'total' is assigned a value but never used  no-unused-vars\n\n✖ 1 problem (1 error, 0 warnings)",
    },
    {
      gate: "test",
      status: "fail",
      command: "npm test",
      exitCode: 1,
      durationMs: 14800,
      baseline: "fail",
      newFailures: ["✖ checkout rejects an empty cart", "AssertionError [ERR_ASSERTION]: Missing expected exception (Error)."],
      note: "Fails on the base branch too, but these failures are new.",
      outputTail:
        "> shop@1.0.0 test\n> node --test\n\n✔ totals the cart (0.4ms)\n✖ legacy discount rounding (0.9ms)\n✖ checkout rejects an empty cart (0.6ms)\n  AssertionError [ERR_ASSERTION]: Missing expected exception (Error).\nℹ tests 3\nℹ pass 1\nℹ fail 2",
    },
    { gate: "build", status: "pass", command: "npm run build", exitCode: 0, durationMs: 31200, outputTail: "> shop@1.0.0 build\n> vite build\n✓ built in 29.8s" },
    { gate: "e2e", status: "skipped", note: "No end-to-end command in the repo profile." },
    {
      gate: "scope",
      status: "needs-approval",
      note: "It touches 1 protected path and changes 1 file the plan doesn't name.",
      details: ["db/migrations/002_carts.sql (protected: db/migrations/**)", "src/pricing.js (outside the plan)"],
    },
    {
      gate: "deps",
      status: "needs-approval",
      note: "New or changed dependencies (1 change).",
      details: ["package.json: + decimal.js ^10.4.3", "package-lock.json changed"],
    },
    { gate: "size", status: "pass", note: "86 changed lines in 4 files." },
  ],
};

export const SAMPLE_REVIEW: Review = {
  verdict: "changes-requested",
  summary:
    "The empty-cart guard works, but the new total loop reads one item past the end of the cart and checkout calls applyDiscount, which doesn't exist anywhere in the repo. The migration isn't mentioned in the plan.",
  reviewer: { provider: "chatgpt", model: "gpt-5.5" },
  findings: [
    {
      file: "src/cart.js",
      line: 3,
      severity: "must-fix",
      issue: "Off-by-one: `i <= items.length` reads items[items.length], which is undefined, so every non-empty cart throws.",
      suggestion: "Loop while `i < items.length`.",
    },
    {
      file: "src/checkout.js",
      line: 5,
      severity: "must-fix",
      issue: "applyDiscount is called but isn't defined or imported anywhere.",
      suggestion: "Drop the call, or add and import a discount helper with tests.",
    },
    { file: "db/migrations/002_carts_coupon.sql", line: 1, severity: "should-fix", issue: "A schema change the plan doesn't mention; nothing reads the coupon column yet." },
    { file: "test/checkout.test.js", line: 9, severity: "nit", issue: "“rejects a missing cart” tests the same guard as the empty-cart test." },
  ],
};
