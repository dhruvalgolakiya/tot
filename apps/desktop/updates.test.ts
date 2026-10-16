// The Mac app's updates (roadmap module 08), without Electron: how electron-updater's events move the web app's
// update prompt along, the one-line log of a failure, and what Check for Updates… answers.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx apps/desktop/updates.test.ts
import "@tot/server/test-data-dir"; // first: refuses to run against the real ~/.tot
import { checkReply, failureDetail, failureLine, IDLE, nextUpdateState, type UpdateEvent, type UpdateState } from "./update-state.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
}
const run = (events: UpdateEvent[], from: UpdateState = IDLE) => events.reduce(nextUpdateState, from);
const same = (a: UpdateState, b: UpdateState) => JSON.stringify(a) === JSON.stringify(b);
const show = (state: UpdateState) => JSON.stringify(state);

// --- The prompt's state -----------------------------------------------------------------------------------------
console.log("# The prompt's state");
const ready: UpdateState = { status: "ready", version: "0.1.2", dismissed: false };
check("a check with nothing new ends idle", same(run([{ type: "checking" }, { type: "not-available" }]), IDLE));
check("a failed check ends idle, with nothing to show", same(run([{ type: "checking" }, { type: "error" }]), IDLE));
const downloading = run([{ type: "checking" }, { type: "available", version: "0.1.2" }, { type: "progress", percent: 41.6 }]);
check("an update downloads, its progress rounded", same(downloading, { status: "downloading", version: "0.1.2", percent: 42 }), show(downloading));
check("progress stays within 0–100", same(run([{ type: "progress", percent: 140 }], downloading), { status: "downloading", version: "0.1.2", percent: 100 }));
check("progress without a download is ignored", same(run([{ type: "progress", percent: 50 }]), IDLE));
check("a check during the download doesn't interrupt it", same(run([{ type: "checking" }, { type: "available", version: "0.1.2" }], downloading), downloading));
const downloaded = run([{ type: "downloaded", version: "0.1.2" }], downloading);
check("downloaded isn't ready yet: Squirrel.Mac still stages it", downloaded.status === "downloading" && downloaded.percent === 100, show(downloaded));
check("staged: ready, and not dismissed", same(run([{ type: "staged" }], downloaded), ready), show(run([{ type: "staged" }], downloaded)));
check("staged with no download known is ignored", same(run([{ type: "staged" }]), IDLE));
check("a failed download ends idle", same(run([{ type: "error" }], downloading), IDLE));
const dismissed = run([{ type: "dismiss" }], ready);
check("dismiss hides it", same(dismissed, { ...ready, dismissed: true }), show(dismissed));
check("…and nothing later brings it back before a restart", same(run([{ type: "checking" }, { type: "available", version: "0.1.2" }, { type: "downloaded", version: "0.1.2" }, { type: "staged" }, { type: "not-available" }], dismissed), dismissed));
check("a ready update stays ready through later events", same(run([{ type: "checking" }, { type: "available", version: "0.1.3" }, { type: "progress", percent: 10 }], ready), ready));
check("an error once ready (installing failed) hides it", same(run([{ type: "error" }], ready), IDLE));
check("dismissing without an update does nothing", same(run([{ type: "dismiss" }], downloading), downloading));
const newer = run([{ type: "error" }, { type: "available", version: "0.1.3" }, { type: "downloaded", version: "0.1.3" }, { type: "staged" }], dismissed);
check("a newer version shows again after one was dismissed", same(newer, { status: "ready", version: "0.1.3", dismissed: false }), show(newer));
check("a different version available restarts the download", same(run([{ type: "available", version: "0.1.3" }], downloading), { status: "downloading", version: "0.1.3", percent: 0 }));

// --- Failures ---------------------------------------------------------------------------------------------------
console.log("\n# Failures");
const feed = {
  message: "Unable to find latest version on GitHub (https://github.com/dhruvalgolakiya/tot/releases/latest), please ensure a production release exists: HttpError: 404 \n\"method: GET url: https://github.com/dhruvalgolakiya/tot/releases.atom\"\n    at createHttpError (/Applications/TOT.app/…)",
  code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
};
const line = failureLine(feed);
check("the log gets one line, with the code", !line.includes("\n") && line.startsWith("ERR_UPDATER_LATEST_VERSION_NOT_FOUND: Unable to find latest version"), line);
check("…at most 300 characters", failureLine({ message: "x".repeat(1000) }).length === 300);
check("…the code isn't repeated when the message has it", failureLine({ message: "ERR_X: broke", code: "ERR_X" }) === "ERR_X: broke");
check("…an empty message still says something", failureLine({ message: "\n  \n" }) === "unknown error");
check("no release yet (a private repo answers 404 too)", failureDetail(feed) === "There's no published TOT release to update from yet.");
check("…or a release without latest-mac.yml", failureDetail({ message: "Cannot find latest-mac.yml", code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" }).startsWith("There's no published"));
check("offline", failureDetail({ message: "net::ERR_INTERNET_DISCONNECTED" }).startsWith("TOT couldn't reach GitHub"));
check("…or DNS failing", failureDetail({ message: "getaddrinfo ENOTFOUND github.com" }).startsWith("TOT couldn't reach GitHub"));
check(
  "running from the disk image",
  failureDetail({ message: "Cannot update while running on a read-only volume. The application is on a disk image or on a read-only mount." }).startsWith("Move TOT to the Applications folder"),
);
check("anything else points at the log", failureDetail({ message: "sha512 checksum mismatch" }).includes("log"));

// --- Check for Updates… ----------------------------------------------------------------------------------------
console.log("\n# Check for Updates…");
const upToDate = checkReply({ kind: "up-to-date", current: "0.1.2" });
check("up to date", upToDate.message === "You're up to date" && upToDate.detail === "TOT 0.1.2 is the newest version." && !upToDate.restart);
const available = checkReply({ kind: "available", version: "0.1.3" });
check("an update found: it's downloading, no restart yet", available.message === "Downloading TOT 0.1.3" && !available.restart);
const staged = checkReply({ kind: "ready", version: "0.1.3" });
check("an update ready: offers a restart, and says what stops", staged.message === "TOT 0.1.3 is ready to install" && staged.restart && staged.detail.includes("stop"));
const failed = checkReply({ kind: "failed", failure: { message: "net::ERR_NAME_NOT_RESOLVED" } });
check("a failed check says so, and why", failed.message === "Couldn't check for updates" && failed.detail.startsWith("TOT couldn't reach GitHub") && !failed.restart);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
