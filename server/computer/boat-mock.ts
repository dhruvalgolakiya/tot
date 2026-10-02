// A local stand-in for Boat's REST API (shapes from docs.boat.dev), for tests.
import { serve } from "@hono/node-server";
import { Hono } from "hono";

export function startBoatMock(port: number) {
  // 1x1 transparent PNG.
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

  const log: string[] = [];
  let getCalls = 0;
  let state = "provisioning";
  const files = new Map<string, string>();
  const sandbox = () => ({ id: "bx_test", name: "TOT test", state, desktopAvailable: state === "ready" });

  const mock = new Hono().basePath("/api/v1");
  mock.use("*", async (c, next) => {
    const auth = c.req.header("authorization");
    log.push(`${c.req.method} ${c.req.path}${c.req.query("path") ? `?path=${c.req.query("path")}` : ""}${auth === "Bearer boat_test_key" ? "" : " [BAD AUTH]"}`);
    await next();
  });
  mock.post("/sandboxes", async (c) => {
    const body = await c.req.json();
    log.push(`  create body ${JSON.stringify(body)}`);
    return c.json({ ok: true, type: "sandbox.created", status: "provisioning", ttlSeconds: body.ttlSeconds, sandbox: sandbox() }, 202);
  });
  mock.patch("/sandboxes/:id", async (c) => {
    log.push(`  update body ${JSON.stringify(await c.req.json())}`);
    return c.json({ ok: true, type: "sandbox.info", sandbox: sandbox() });
  });
  mock.get("/sandboxes/:id", (c) => {
    if (++getCalls >= 2 && state === "provisioning") state = "ready";
    return c.json({ ok: true, type: "sandbox.info", sandbox: sandbox() });
  });
  mock.post("/sandboxes/:id/commands", async (c) => {
    const body = await c.req.json();
    // Log what actually runs, without the long DISPLAY/XAUTHORITY preamble desktop commands carry.
    const shown = String(body.command).replace(/^export DISPLAY=.*?export XAUTHORITY=[^;]*;\s*/, "[x11] ");
    log.push(`  command ${JSON.stringify(shown).slice(0, 150)} cwd=${body.cwd ?? "-"} timeout=${body.timeoutSeconds}`);
    const command: string = body.command;
    const stdout = command.includes("identify -format") ? "1920 1080" : command.startsWith("echo") ? "hello from boat\n" : "";
    return c.json({
      ok: true, type: "command.completed", success: true, exitCode: 0, signal: null, oomKilled: false,
      stdout, stderr: "", stdoutTruncated: false, stderrTruncated: false, timedOut: false,
      cwd: "/home/user", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    });
  });
  mock.put("/sandboxes/:id/files", async (c) => {
    const body = await c.req.json();
    files.set(body.path, body.content);
    return c.json({ ok: true, type: "file.written", success: true, path: body.path, encoding: body.encoding ?? "utf8", size: body.content.length });
  });
  mock.get("/sandboxes/:id/files", (c) => {
    const path = c.req.query("path")!;
    if (!files.has(path)) return c.json({ ok: false, type: "sandbox.error", status: 404, code: "not_found", message: `No such file: ${path}` }, 404);
    return c.json({ ok: true, type: "file.read", success: true, path, encoding: "utf8", size: files.get(path)!.length, content: files.get(path) });
  });
  mock.get("/sandboxes/:id/artifacts", () => new Response(PNG, { headers: { "content-type": "application/octet-stream" } }));
  mock.post("/sandboxes/:id/host", async (c) => {
    const body = await c.req.json();
    return c.json({ ok: true, type: "host.created", success: true, port: body.port, url: `https://bx-test-${body.port}.on.boat.dev/?_token=secret`, isProtected: true, access: "private" });
  });
  mock.post("/sandboxes/:id/desktop", () =>
    Response.json({ ok: true, type: "desktop.ready", success: true, desktopUrl: "https://bx-test-desktop.on.boat.dev/stream.html#token=abc", provisioning: false }),
  );
  mock.post("/sandboxes/:id/stop", () => {
    state = "archived";
    return Response.json({ ok: true, type: "sandbox.stopping", id: "bx_test", status: "archiving", sandbox: sandbox() }, { status: 202 });
  });
  mock.post("/sandboxes/:id/resume", () => {
    state = "ready";
    return Response.json({ ok: true, type: "sandbox.resuming", id: "bx_test", status: "provisioning", sandbox: sandbox() }, { status: 202 });
  });
  mock.delete("/sandboxes/:id", (c) => {
    if (c.req.header("x-ascii-confirm-delete") !== "bx_test") {
      return c.json({ ok: false, type: "sandbox.error", status: 409, code: "confirm_required", message: "Missing confirmation" }, 409);
    }
    return c.json({ ok: true, type: "deletion.operation", operation: { id: "bdop_1", kind: "sandbox", targetId: "bx_test", status: "pending" } }, 202);
  });

  const server = serve({ fetch: mock.fetch, port, hostname: "127.0.0.1" });
  return {
    log,
    PNG,
    state: () => state,
    close: () => server.close(),
  };
}
