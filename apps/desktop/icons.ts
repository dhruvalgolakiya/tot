import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Draws the Mac app's icons (roadmap module 08) and renders them with headless Chrome into apps/desktop/resources/:
 * the app icon (the two TOT rings on a dark plate, on Apple's 1024 px icon grid) and the menu bar icon (the
 * rings alone, black on transparent, a template image macOS tints for light and dark menu bars). The SVGs are
 * written next to the PNGs. Run: npx tsx apps/desktop/icons.ts
 */

const OUT = join(import.meta.dirname, "resources");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * The plate: Apple's grid puts an 824 px rounded square in the middle of the 1024 px canvas. A superellipse
 * (n = 5) has the continuous corners of macOS icons; at 45° it meets a 185 px corner radius exactly.
 */
function plate(size = 824, center = 512, n = 5, steps = 360): string {
  const a = size / 2;
  const points: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const x = center + a * Math.sign(cos) * Math.abs(cos) ** (2 / n);
    const y = center + a * Math.sign(sin) * Math.abs(sin) ** (2 / n);
    points.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `M${points.join("L")}Z`;
}

/**
 * The rings as in apps/web/public/tot.svg: stroke ≈ a fifth of their width, a sliver of space between them. A gradient
 * paint spans each ring on its own (objectBoundingBox units), violet at the top left to cyan at the bottom right.
 */
function rings(cx: number, cy: number, outer: number, gap: number, paint: string): string {
  const stroke = outer * 0.217;
  const r = (outer - stroke) / 2;
  const offset = (outer + gap) / 2;
  return [cx - offset, cx + offset]
    .map((x) => `<circle cx="${x}" cy="${cy}" r="${r}" fill="none" stroke="${paint}" stroke-width="${stroke}"/>`)
    .join("");
}

const shape = plate();

const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
  <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#2a2a2f"/><stop offset="1" stop-color="#0c0c10"/>
  </linearGradient>
  <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0.16"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.05"/><stop offset="1" stop-color="#fff" stop-opacity="0.08"/>
  </linearGradient>
  <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#22d3ee"/>
  </linearGradient>
  <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
    <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#000" flood-opacity="0.22"/>
    <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.26"/>
  </filter>
  <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="34"/></filter>
  <!-- A faint grain over the plate: a dark gradient this long bands in 8-bit colour without it. -->
  <filter id="grain" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" stitchTiles="stitch"/>
    <feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.9 0"/>
  </filter>
  <clipPath id="clip"><path d="${shape}"/></clipPath>
</defs>
<!-- The shadow is its own layer: a gradient drawn through a filter comes out in uneven bands. -->
<path d="${shape}" fill="#000" filter="url(#shadow)"/>
<path d="${shape}" fill="url(#plate)"/>
<g clip-path="url(#clip)">
  <rect x="100" y="100" width="824" height="824" filter="url(#grain)" opacity="0.045"/>
  <g filter="url(#glow)" opacity="0.32">${rings(512, 512, 248, 12, "url(#ring)")}</g>
  ${rings(512, 512, 248, 12, "url(#ring)")}
</g>
<path d="${shape}" fill="none" stroke="url(#edge)" stroke-width="3" clip-path="url(#clip)"/>
</svg>
`;

const trayIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16" viewBox="0 0 24 16">${rings(12, 8, 10.6, 1.2, "#000")}</svg>
`;

async function render(svg: string, width: number, height: number, scale: number, file: string) {
  const dir = mkdtempSync(join(tmpdir(), "tot-icons-"));
  const shot = join(dir, "shot.png");
  try {
    const page = join(dir, "icon.html");
    writeFileSync(
      page,
      `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`,
    );
    // Chrome writes the screenshot but doesn't always exit afterwards: wait for the file, then end it. No
    // `timeout` binary on macOS, so perl's alarm is the backstop.
    const chrome = spawn(
      "perl",
      [
        "-e",
        "alarm 30; exec @ARGV",
        CHROME,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${join(dir, "profile")}`,
        "--default-background-color=00000000",
        "--force-color-profile=srgb",
        `--force-device-scale-factor=${scale}`,
        `--window-size=${width},${height}`,
        `--screenshot=${shot}`,
        `file://${page}`,
      ],
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
    const size = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", join(OUT, file)], { encoding: "utf8" });
    if (!size.includes(`pixelWidth: ${width * scale}`) || !size.includes(`pixelHeight: ${height * scale}`)) throw new Error(`${file} came out the wrong size:\n${size}`);
    console.log(`wrote apps/desktop/resources/${file} (${width * scale}×${height * scale})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

writeFileSync(join(OUT, "icon.svg"), appIcon);
writeFileSync(join(OUT, "trayTemplate.svg"), trayIcon);
await render(appIcon, 1024, 1024, 1, "icon.png");
await render(trayIcon, 24, 16, 1, "trayTemplate.png");
await render(trayIcon, 24, 16, 2, "trayTemplate@2x.png");
