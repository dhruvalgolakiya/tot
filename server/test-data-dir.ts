// Imported first by every test. Tests create agents and chats and overwrite secrets
// (Slack and GitHub tokens), so they must never run against the real ~/.tot.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const dir = process.env.TOT_DATA_DIR;
if (!dir || resolve(dir) === resolve(join(homedir(), ".tot"))) {
  console.error("Refusing to run: set TOT_DATA_DIR to a scratch folder, e.g. TOT_DATA_DIR=$(mktemp -d) — or use `npm test`.");
  process.exit(1);
}
