import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Draws the phone app's icons from the Mac app's (electron/icons.ts: the two TOT rings, violet to cyan, on a dark
 * plate) and renders them with headless Chrome into mobile/assets/:
 * - icon.png: iOS wants a full-bleed, opaque square (it rounds the corners itself), so the plate fills the canvas
 *   and the rings grow by the same 1024/824 the Mac plate is inset by.
 * - splash-icon.png: the rings alone on transparent, on a plain light or dark background (app.json's splash).
 * - Android's adaptive icon: the rings inside the 66% safe zone, on the plate's color, and white for monochrome.
 * Run from the repo root: npx tsx mobile/scripts/icons.mts
 */

const OUT = join(import.meta.dirname, "..", "assets");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** As electron/icons.ts: stroke about a fifth of each ring's width, a sliver of space between them. */
function rings(cx: number, cy: number, outer: number, gap: number, paint: string): string {
  const stroke = outer * 0.217;
  const r = (outer - stroke) / 2;
  const offset = (outer + gap) / 2;
  return [cx - offset, cx + offset]
    .map((x) => `<circle cx="${x}" cy="${cy}" r="${r}" fill="none" stroke="${paint}" stroke-width="${stroke}"/>`)
    .join("");
}

const RING = `<linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#22d3ee"/></linearGradient>`;
const PLATE = `<linearGradient id="plate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2a2f"/><stop offset="1" stop-color="#0c0c10"/></linearGradient>`;
/** The Mac icon's rings are 248 px wide with a 12 px gap on its 824 px plate; scaled to a full 1024 px canvas. */
const SCALE = 1024 / 824;

const svg = (size: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><defs>${RING}${PLATE}<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="40"/></filter></defs>${body}</svg>`;

const icon = svg(
  1024,
  `<rect width="1024" height="1024" fill="url(#plate)"/>` +
    `<g filter="url(#glow)" opacity="0.32">${rings(512, 512, 248 * SCALE, 12 * SCALE, "url(#ring)")}</g>` +
    rings(512, 512, 248 * SCALE, 12 * SCALE, "url(#ring)"),
);
// The splash shows its image at about 200 pt wide; the rings fill the middle of the canvas, as on the icon.
const splash = svg(1024, rings(512, 512, 248 * 1.5, 12 * 1.5, "url(#ring)"));
// Android masks the adaptive icon to as little as the middle 66%: the pair of rings (≈ 0.62 of the width) sits in it.
const foreground = svg(512, rings(256, 256, 248 * 0.62, 12 * 0.62, "url(#ring)"));
const background = svg(512, `<rect width="512" height="512" fill="#1b1b1f"/>`);
const monochrome = svg(432, rings(216, 216, 248 * 0.52, 12 * 0.52, "#fff"));

async function render(source: string, size: number, file: string) {
  const dir = mkdtempSync(join(tmpdir(), "tot-mobile-icons-"));
  const shot = join(dir, "shot.png");
  try {
    const page = join(dir, "icon.html");
    writeFileSync(page, `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${source}</body></html>`);
    // As electron/icons.ts: Chrome writes the screenshot but doesn't always exit; perl's alarm is the backstop.
    const chrome = spawn(
      "perl",
      ["-e", "alarm 30; exec @ARGV", CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${join(dir, "profile")}`, "--default-background-color=00000000", "--force-color-profile=srgb", "--force-device-scale-factor=1", `--window-size=${size},${size}`, `--screenshot=${shot}`, `file://${page}`],
      { stdio: "ignore", detached: true },
    );
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    const deadline = Date.now() + 30_000;
    while (!existsSync(shot) && chrome.exitCode === null && chrome.signalCode === null && Date.now() < deadline) await sleep(200);
    await sleep(500);
    try {
      process.kill(-chrome.pid!, "SIGKILL");
    } catch {
      // Already gone.
    }
    await exited;
    if (!existsSync(shot)) throw new Error(`Chrome didn't render ${file}.`);
    copyFileSync(shot, join(OUT, file));
    const dims = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", join(OUT, file)], { encoding: "utf8" });
    if (!dims.includes(`pixelWidth: ${size}`) || !dims.includes(`pixelHeight: ${size}`)) throw new Error(`${file} came out the wrong size:\n${dims}`);
    console.log(`wrote mobile/assets/${file} (${size}×${size})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await render(icon, 1024, "icon.png");
// iOS rejects an app icon with an alpha channel: flatten it (the plate covers every pixel anyway).
execFileSync("sips", ["-s", "format", "jpeg", join(OUT, "icon.png"), "--out", join(OUT, "icon.jpg")], { stdio: "ignore" });
execFileSync("sips", ["-s", "format", "png", join(OUT, "icon.jpg"), "--out", join(OUT, "icon.png")], { stdio: "ignore" });
rmSync(join(OUT, "icon.jpg"));
await render(splash, 1024, "splash-icon.png");
await render(foreground, 512, "android-icon-foreground.png");
await render(background, 512, "android-icon-background.png");
await render(monochrome, 432, "android-icon-monochrome.png");
