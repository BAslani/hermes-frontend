/**
 * Renders a cinematic flight from src/config/flights.ts as video footage,
 * frame by frame, from the live 141 tile server.
 *
 *   pnpm render-flight savadkuh
 *   pnpm render-flight jandaq --from 0 --to 14.5 --fps 30 --scale 2
 *
 * Options: --fps (30), --width (1920), --height (1080), --scale (1; 2 renders
 * at double resolution and downsamples, for smoother edges), --from / --to
 * (flight seconds, default the whole flight), --labels (keep map labels and
 * POI icons; hidden by default for clean footage).
 *
 * The flight is the same path the site plays (drone-flight.ts), but time is
 * driven by the frame number instead of the clock, and every frame waits for
 * all of its tiles, so the result never stutters or shows unloaded tiles.
 * Frames are kept in video/renders/<id>/frames and reused on a re-run, so an
 * interrupted render resumes where it stopped (delete the folder after
 * changing the flight or options).
 *
 * Needs Google Chrome (CHROME_PATH to override) and ffmpeg. ANGLE picks the
 * GL backend (default d3d11 on Windows, i.e. the GPU; swiftshader elsewhere).
 * Chrome runs with web security off only so the /sat imagery (which allows
 * just the https://141.ir origin) can be read from this local capture page.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import * as nodeModule from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import puppeteer from "puppeteer-core";
import { FLIGHT_SCENES } from "../src/config/flights.ts";
import { styleUrl } from "../src/config/map.ts";

// Node ≥22.13; not yet in the project's @types/node.
const { stripTypeScriptTypes } = nodeModule as unknown as {
  stripTypeScriptTypes: (code: string) => string;
};

const ROOT = path.resolve(import.meta.dirname, "..");
const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fps: { type: "string", default: "30" },
    width: { type: "string", default: "1920" },
    height: { type: "string", default: "1080" },
    scale: { type: "string", default: "1" },
    from: { type: "string" },
    to: { type: "string" },
    labels: { type: "boolean", default: false },
  },
});
const scene = FLIGHT_SCENES.find((s) => s.id === positionals[0]);
if (!scene) {
  console.error(
    `Usage: pnpm render-flight <${FLIGHT_SCENES.map((s) => s.id).join("|")}> [options]`,
  );
  process.exit(1);
}
const FPS = Number(opt.fps);
const WIDTH = Number(opt.width);
const HEIGHT = Number(opt.height);
const SCALE = Number(opt.scale);
const CHROME =
  process.env.CHROME_PATH ??
  (process.platform === "win32"
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
    : "/usr/bin/google-chrome");
const ANGLE =
  process.env.ANGLE ?? (process.platform === "win32" ? "d3d11" : "swiftshader");

const OUT = path.join(ROOT, "video/renders", scene.id);
const FRAMES = path.join(OUT, "frames");

/** Serves MapLibre, the flight maths (types stripped) and the capture page. */
async function startServer() {
  const dist = path.join(ROOT, "node_modules/maplibre-gl/dist");
  const flightJs = stripTypeScriptTypes(
    await readFile(path.join(ROOT, "src/lib/drone-flight.ts"), "utf8"),
  );
  const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/dist/maplibre-gl.css">
<style>html,body,#map{margin:0;width:100%;height:100%;background:#04070c}</style></head>
<body><div id="map"></div><script type="module">
import * as maplibregl from "/dist/maplibre-gl.mjs";
import { cameraFromView, parseViewerHash, planAltitude, planFlight } from "/lib/drone-flight.js";
maplibregl.setWorkerUrl(location.origin + "/dist/maplibre-gl-worker.mjs");
const scene = ${JSON.stringify(scene)};
const labels = ${JSON.stringify(opt.labels)};
const view = parseViewerHash(scene.viewerUrl);
const map = new maplibregl.Map({
  container: "map",
  style: ${JSON.stringify(styleUrl("satellite-terrain"))},
  ...view,
  interactive: false,
  attributionControl: false,
  fadeDuration: 0,
  maxPitch: 85,
  canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
});
map.on("style.load", () => {
  for (const layer of map.getStyle().layers) {
    if (layer.type === "raster") map.setPaintProperty(layer.id, "raster-fade-duration", 0);
    if (layer.type === "symbol" && !labels) map.setLayoutProperty(layer.id, "visibility", "none");
  }
});
// Waits until the frame is complete. "idle" alone is not enough: where the
// imagery has no high-zoom tiles (404s) MapLibre keeps repainting and never
// goes idle, so also accept a few consecutive frames with every tile loaded.
const idle = () =>
  new Promise((resolve) => {
    let stable = 0;
    const check = () => {
      stable = map.isStyleLoaded() && map.areTilesLoaded() && !map.isMoving() ? stable + 1 : 0;
      if (stable >= 4) { clearTimeout(t); resolve(); } else if (!done) requestAnimationFrame(check);
    };
    let done = false;
    const t = setTimeout(() => {
      done = true;
      const style = map.style;
      const pending = Object.entries(style.tileManagers ?? style.sourceCaches ?? {})
        .filter(([, c]) => !c.loaded()).map(([id]) => id);
      console.error("idle timeout: moving=" + map.isMoving() + " tilesLoaded=" + map.areTilesLoaded() +
        " styleLoaded=" + map.isStyleLoaded() + " pending=" + pending.join(","));
      resolve();
    }, 60000);
    map.once("idle", () => { done = true; clearTimeout(t); resolve(); });
    map.triggerRepaint();
    requestAnimationFrame(check);
  });

let path, altitudeAt;
window.prepare = async () => {
  // Fail fast when the tile server is unreachable, instead of waiting forever.
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("map did not load within 60 s — is the tile server reachable?")), 60000);
    map.once("load", () => { clearTimeout(t); resolve(); });
  });
  await idle();
  // Same take-off as flight-player.ts: no ground clamping, start from the view.
  map.setCenterClampedToGround(false);
  const container = map.getContainer();
  const start = cameraFromView(
    { center: map.getCenter().toArray(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() },
    { height: container.clientHeight, fov: map.getVerticalFieldOfView(), centerElevation: map.getCenterElevation() },
  );
  let last = map.getCenterElevation();
  const ground = (p) => {
    const e = map.queryTerrainElevation(p);
    if (e !== null) last = e;
    return last;
  };
  const startHeight = start.altitude - ground(start.position);
  path = planFlight(start, startHeight, scene.legs);
  // Load the DEM for the whole route before planning the altitude, so it is
  // planned from real terrain everywhere (the site only has what is on screen).
  const lngs = [], lats = [];
  for (let s = 0; s <= path.length; s += 100) {
    const [lng, lat] = path.positionAt(s);
    lngs.push(lng); lats.push(lat);
  }
  map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
    { padding: 80, pitch: 0, bearing: 0, maxZoom: 12, animate: false });
  await idle();
  altitudeAt = planAltitude(path, ground, scene.minClearance);
  return path.duration;
};
window.frame = async (time) => {
  const s = path.sampleAt(time);
  const alt = altitudeAt(s.distance, s.height);
  map.jumpTo(map.calculateCameraOptionsFromCameraLngLatAltRotation(s.position, alt, s.bearing, s.pitch, s.roll));
  await idle();
};
</script></body></html>`;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/")
      return void res.writeHead(200, { "content-type": "text/html" }).end(page);
    if (url.pathname === "/lib/drone-flight.js") {
      return void res
        .writeHead(200, { "content-type": "text/javascript" })
        .end(flightJs);
    }
    if (url.pathname.startsWith("/dist/")) {
      try {
        const file = await readFile(
          path.join(dist, path.basename(url.pathname)),
        );
        const type = url.pathname.endsWith(".css")
          ? "text/css"
          : "text/javascript";
        return void res.writeHead(200, { "content-type": type }).end(file);
      } catch {
        /* fall through */
      }
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}/` };
}

type CaptureWindow = {
  prepare: () => Promise<number>;
  frame: (t: number) => Promise<void>;
};

await mkdir(FRAMES, { recursive: true });
const { server, url } = await startServer();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    `--use-angle=${ANGLE}`,
    ...(ANGLE === "swiftshader" ? ["--enable-unsafe-swiftshader"] : []),
    "--ignore-gpu-blocklist",
    "--disable-web-security",
    "--hide-scrollbars",
  ],
  defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE },
  protocolTimeout: 0,
});
let first = 0;
let count = 0;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.warn("  page error:", e));
  page.on(
    "console",
    (m) => m.type() === "error" && console.warn("  console:", m.text()),
  );
  page.on("requestfailed", (r) =>
    console.warn("  request failed:", r.failure()?.errorText, r.url()),
  );
  page.on(
    "response",
    (r) => r.status() >= 400 && console.warn("  HTTP", r.status(), r.url()),
  );
  await page.goto(url, { waitUntil: "load" });
  const renderer = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  });
  const duration = await page.evaluate(() =>
    (window as unknown as CaptureWindow).prepare(),
  );
  const from = Math.max(0, Number(opt.from ?? 0));
  const to = Math.min(duration, Number(opt.to ?? duration));
  first = Math.round(from * FPS);
  count = Math.round((to - from) * FPS) + 1;
  console.log(
    `● ${scene.id}: ${from}–${to}s of ${duration}s, ${count} frames @ ${FPS}fps, ${WIDTH}×${HEIGHT}×${SCALE} (${renderer})`,
  );

  const done = new Set(await readdir(FRAMES));
  const started = Date.now();
  let rendered = 0;
  for (let i = 0; i < count; i++) {
    // Named by absolute frame number, so ranges rendered separately line up.
    const name = `${String(first + i).padStart(5, "0")}.png`;
    if (done.has(name)) continue;
    await page.evaluate(
      (t) => (window as unknown as CaptureWindow).frame(t),
      (first + i) / FPS,
    );
    await page.screenshot({ path: path.join(FRAMES, name) as `${string}.png` });
    rendered++;
    const per = (Date.now() - started) / rendered / 1000;
    process.stdout.write(
      `  ${i + 1}/${count}  ${per.toFixed(2)}s/frame  ~${Math.round(((count - i - 1) * per) / 60)} min left   \r`,
    );
  }
  process.stdout.write("\n");
} finally {
  await browser.close();
  server.close();
}

// A near-lossless master for editing and a lighter file for previewing.
const base = `${scene.id}-${WIDTH}x${HEIGHT}-${FPS}fps`;
const encodes = [
  { file: `${base}-master.mp4`, crf: "12", preset: "slow" },
  { file: `${base}.mp4`, crf: "20", preset: "slow" },
];
for (const e of encodes) {
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-framerate",
    String(FPS),
    "-start_number",
    String(first),
    "-i",
    path.join(FRAMES, "%05d.png"),
    "-frames:v",
    String(count),
    "-vf",
    `scale=${WIDTH}:${HEIGHT}:flags=lanczos`,
    "-c:v",
    "libx264",
    "-preset",
    e.preset,
    "-crf",
    e.crf,
    "-tune",
    "film",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-an",
    path.join(OUT, e.file),
  ]);
  if (existsSync(path.join(OUT, e.file)))
    console.log(`  ✓ video/renders/${scene.id}/${e.file}`);
}
