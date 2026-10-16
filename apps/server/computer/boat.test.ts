// Exercises the Boat backend end-to-end against a local mock of Boat's REST API
// (shapes from docs.boat.dev), so the real SDK calls are checked without a key or VM.
// Run: TOT_DATA_DIR=/tmp/tot-boat-test npx tsx server/computer/boat.test.ts
import "../test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { startBoatMock } from "./boat-mock.ts";

const PORT = 8797;
process.env.BOAT_API_KEY = "boat_test_key";
process.env.BOAT_API_URL = `http://127.0.0.1:${PORT}/api/v1`;

const mock = startBoatMock(PORT);
const { log, PNG } = mock;
const state = () => mock.state();

const { boatBackend } = await import("./boat.ts");

let failures = 0;
async function check(name: string, run: () => Promise<unknown>, ok: (value: any) => boolean) {
  try {
    const value = await run();
    const pass = ok(value);
    if (!pass) failures++;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(value)?.slice(0, 140) ?? ""}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}  threw: ${(err as Error).message}`);
  }
}

await check("check() with key", () => boatBackend.check(), (v) => v.ok);
let id = "";
await check("create waits until ready", async () => {
  const created = await boatBackend.create({ name: "TOT · Test", agentId: "a", size: "large" });
  id = created.externalId;
  return created;
}, (v) => v.externalId === "bx_test" && v.label === "Boat VM · 8 vCPU / 16 GB" && state() === "ready");
await check("exec", () => boatBackend.exec(id, "echo hello", { cwd: "/home/user/app", timeoutMs: 5000 }), (v) => v.stdout.includes("hello from boat") && v.exitCode === 0);
await check("write + read file", async () => {
  await boatBackend.writeFile(id, "app/index.html", "<h1>hi</h1>");
  return boatBackend.readFile(id, "app/index.html");
}, (v) => v === "<h1>hi</h1>");
try {
  await boatBackend.readFile(id, "nope.txt");
  failures++;
  console.log("FAIL  missing file should throw");
} catch (err) {
  const message = (err as Error).message;
  const pass = message.includes("No such file") && message.includes("not_found");
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  missing file surfaces Boat's message  ${message}`);
}
await check("expose port", () => boatBackend.exposePort(id, 3000), (v) => String(v).startsWith("https://bx-test-3000.on.boat.dev"));
await check("desktop url", () => boatBackend.desktopUrl!(id), (v) => String(v).includes("stream.html"));
await check("screenshot", async () => {
  const shot = await boatBackend.desktop!.screenshot(id, 1280);
  return { screenWidth: shot.screenWidth, screenHeight: shot.screenHeight, bytes: shot.png.length };
}, (v) => v.screenWidth === 1920 && v.screenHeight === 1080 && v.bytes === PNG.length);
await check("click", () => boatBackend.desktop!.click(id, 100, 200, { button: "left", double: true }), () => true);
await check("type", () => boatBackend.desktop!.type(id, `it's "quoted"`), () => true);
await check("key", () => boatBackend.desktop!.key(id, "ctrl+l Return"), () => true);
await check("scroll", () => boatBackend.desktop!.scroll(id, 10, 20, "down", 3), () => true);
await check("open url", () => boatBackend.desktop!.openUrl(id, "https://example.com/?a=1&b=2"), () => true);
await check("stop", async () => { await boatBackend.stop(id); return state(); }, (v) => v === "archived");
await check("resume", async () => { await boatBackend.resume(id); return state(); }, (v) => v === "ready");
await check("destroy sends confirm header", () => boatBackend.destroy(id), () => true);

console.log("\n--- requests the backend made ---");
for (const line of log) console.log(line);
mock.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
