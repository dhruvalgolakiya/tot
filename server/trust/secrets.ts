/**
 * What a secret looks like (API keys, Slack tokens, AWS keys, private keys): shared by the scrubber for check
 * output (shell.ts) and by memory, which refuses to store anything that matches (roadmap module 10).
 */
export const SECRET_SHAPES = [
  /\bsk-ant-[\w-]{20,}/g,
  /\bsk-(?:proj-)?[\w-]{32,}/g,
  /\bxox[abprs]-[\w-]{10,}/g,
  /\bxapp-[\w-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
