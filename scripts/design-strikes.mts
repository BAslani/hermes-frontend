/**
 * Scouts the drone-defence scenarios' sites on the 141 satellite imagery and
 * DEM, so nothing is placed from memory.
 *
 *   node --no-warnings scripts/design-strikes.mts overview <lng> <lat> [zoom] [name]
 *   node --no-warnings scripts/design-strikes.mts [check <scenario id>]
 *
 * `overview` draws satellite tiles around a point with a labelled lng/lat
 * grid (for reading guide points off the imagery). With no arguments it
 * checks each scenario: the site's ground, the start's height above it, and
 * the terrain along each wave's approach (how high the drones must fly to
 * clear the ridges), and draws a close-up of the site.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { TILE_SERVER_URL } from "../src/config/map.ts";
import {
  ahead,
  bearing,
  dist,
  type LngLat,
  loadDem,
  R,
  RAD,
  ROOT,
  round,
  tileX,
  tileY,
} from "./lib/dem.mts";

const OUT = path.join(ROOT, "scripts/strikes");

/** The point `east`, `north` metres from `origin`. */
const offsetLocal = (
  [lng, lat]: LngLat,
  east: number,
  north: number,
): LngLat => [
  lng + east / (R * Math.cos(lat * RAD) * RAD),
  lat + north / (R * RAD),
];

const lngOf = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const latOf = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
};

async function tile(z: number, x: number, y: number) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(
        `${TILE_SERVER_URL}/styles/satellite/${z}/${x}/${y}@2x.png`,
      );
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch {
      /* retry */
    }
  }
  return null;
}

/** Satellite tiles (n × n) around a point with a lng/lat grid and optional marks. */
async function overview(
  name: string,
  at: LngLat,
  z: number,
  n = 3,
  marks: { at: LngLat; label: string; colour: string; radius?: number }[] = [],
) {
  const T = 512;
  const cx = tileX(at[0], z);
  const cy = tileY(at[1], z);
  const tx0 = Math.floor(cx) - Math.floor(n / 2);
  const ty0 = Math.floor(cy) - Math.floor(n / 2);
  const composites: { input: Buffer; left: number; top: number }[] = [];
  for (let ty = ty0; ty < ty0 + n; ty++) {
    for (let tx = tx0; tx < tx0 + n; tx++) {
      const input = await tile(z, tx, ty);
      if (input)
        composites.push({ input, left: (tx - tx0) * T, top: (ty - ty0) * T });
    }
  }
  const W = n * T;
  const px = (p: LngLat): [number, number] => [
    (tileX(p[0], z) - tx0) * T,
    (tileY(p[1], z) - ty0) * T,
  ];
  const west = lngOf(tx0, z);
  const east = lngOf(tx0 + n, z);
  const north = latOf(ty0, z);
  const south = latOf(ty0 + n, z);
  const span = east - west;
  const stepDeg =
    span > 0.2 ? 0.05 : span > 0.08 ? 0.02 : span > 0.03 ? 0.01 : 0.005;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}">`;
  const text = (x: number, y: number, s: string, colour = "#fff", size = 26) =>
    `<text x="${x}" y="${y}" font-family="sans-serif" font-size="${size}" font-weight="700" fill="${colour}" stroke="#000" stroke-width="5" paint-order="stroke">${s}</text>`;
  for (
    let lng = Math.ceil(west / stepDeg) * stepDeg;
    lng < east;
    lng += stepDeg
  ) {
    const [x] = px([lng, at[1]]);
    svg +=
      `<line x1="${x}" y1="0" x2="${x}" y2="${W}" stroke="#fff" stroke-opacity="0.45" stroke-width="2"/>` +
      text(x + 4, 30, lng.toFixed(3));
  }
  for (
    let lat = Math.ceil(south / stepDeg) * stepDeg;
    lat < north;
    lat += stepDeg
  ) {
    const [, y] = px([at[0], lat]);
    svg +=
      `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#fff" stroke-opacity="0.45" stroke-width="2"/>` +
      text(6, y - 6, lat.toFixed(3));
  }
  const metresPerPx = (2 * Math.PI * R * Math.cos(at[1] * RAD)) / (2 ** z * T);
  for (const m of marks) {
    const [x, y] = px(m.at);
    const r = m.radius ? Math.max(6, m.radius / metresPerPx) : 8;
    svg +=
      `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${m.colour}" stroke-width="5"/><circle cx="${x}" cy="${y}" r="4" fill="${m.colour}"/>` +
      text(x + r + 6, y + 8, m.label, m.colour);
  }
  svg += "</svg>";
  composites.push({ input: Buffer.from(svg), left: 0, top: 0 });
  await mkdir(OUT, { recursive: true });
  const flat = await sharp({
    create: { width: W, height: W, channels: 3, background: "#6b675d" },
  })
    .composite(composites)
    .png()
    .toBuffer();
  const file = path.join(OUT, `${name}.png`);
  await sharp(flat).resize(1100).png().toFile(file);
  console.log(`wrote ${path.relative(ROOT, file)}`);
}

const args = process.argv.slice(2);
if (args[0] === "overview") {
  const at: LngLat = [Number(args[1]), Number(args[2])];
  await overview(args[4] ?? "overview", at, Number(args[3] ?? 13));
} else {
  const { STRIKES } = await import("../src/config/strikes.ts");
  // `check <id>` runs one scenario; no arguments runs them all.
  const only = args[0] === "check" ? args[1] : undefined;
  for (const s of STRIKES.filter((x) => !only || x.id === only)) {
    const dem = await loadDem(s.site.position, 12_000);
    const ground = dem.elev(s.site.position);
    console.log(`${s.id}: site ground ${Math.round(ground)} m`);
    const startGround = dem.elev(s.start.position);
    console.log(
      `  start ${Math.round(dist(s.site.position, s.start.position))} m from the site, ground ${Math.round(startGround)} m, flying at ${Math.round(startGround + s.start.height)} m`,
    );
    const marks: {
      at: LngLat;
      label: string;
      colour: string;
      radius?: number;
    }[] = [
      {
        at: s.site.position,
        label: "site",
        colour: "#ff5a3c",
        radius: s.site.radius,
      },
      { at: s.start.position, label: "start", colour: "#2cc4ae" },
    ];
    s.launchers?.forEach((at, i) => {
      console.log(
        `  launcher ${i}: ${Math.round(dist(s.site.position, at))} m from the site at ${Math.round(bearing(s.site.position, at))}°, ground ${Math.round(dem.elev(at))} m`,
      );
      marks.push({ at, label: `L${i}`, colour: "#ff8a2a" });
    });
    s.waves.forEach((wave, w) => {
      for (const group of wave.groups) {
        if (group.launcher !== undefined) continue;
        const spawn = ahead(s.site.position, group.from, s.spawnDistance);
        // Highest ground on the straight line in, and the height the drones cruise at above it.
        let top = -Infinity;
        for (let d = 0; d <= s.spawnDistance; d += 100)
          top = Math.max(top, dem.elev(ahead(s.site.position, group.from, d)));
        console.log(
          `  wave ${w + 1} from ${group.from}°: spawn ground ${Math.round(dem.elev(spawn))} m, highest on the way ${Math.round(top)} m (${Math.round(top - ground)} m above the site)`,
        );
        marks.push({
          at: spawn,
          label: `w${w + 1} ${group.from}°`,
          colour: "#ffb547",
        });
      }
    });
    console.log(`  ${s.site.position.map((v) => round(v)).join(", ")}`);

    // Fly every wave with nobody defending, on the DEM: each drone should reach the site, not fly into a hill.
    const { maxScore, newStrike, stepStrike, totalThreats } = await import(
      "../src/lib/flight/strike.ts"
    );
    const groundAt = (e: number, n: number) =>
      dem.elev(offsetLocal(s.site.position, e, n));
    const game = newStrike(
      {
        site: [0, 0, ground + s.site.aim],
        siteRadius: s.site.radius,
        spawnDistance: s.spawnDistance,
        launchers: s.launchers?.map((at) => {
          const [e, n] = [
            (at[0] - s.site.position[0]) *
              RAD *
              R *
              Math.cos(s.site.position[1] * RAD),
            (at[1] - s.site.position[1]) * RAD * R,
          ];
          return [e, n] as [number, number];
        }),
        waves: s.waves,
        hitsAllowed: 999,
        playerHits: 999,
        magazine: 0,
        firstBreak: 1,
        breakTime: 1,
      },
      7,
    );
    // Hunters chase an interceptor hovering where the scenario starts it.
    const startLocal = [
      (s.start.position[0] - s.site.position[0]) *
        RAD *
        R *
        Math.cos(s.site.position[1] * RAD),
      (s.start.position[1] - s.site.position[1]) * RAD * R,
    ];
    const player: [number, number, number] = [
      startLocal[0],
      startLocal[1],
      startGround + s.start.height,
    ];
    let lowest = Infinity;
    const counts: Record<string, number> = {};
    for (let t = 0; t < 3000 && game.phase !== "won"; t += 0.05) {
      for (const e of stepStrike(game, groundAt, 0.05, player)) {
        counts[e.kind] = (counts[e.kind] ?? 0) + 1;
        if (e.kind === "crash")
          console.log(
            `    crashed at ${e.at.map((v) => Math.round(v)).join(", ")} (${Math.round(Math.hypot(e.at[0], e.at[1]))} m from the site)`,
          );
      }
      for (const th of game.threats)
        if (!th.diving)
          lowest = Math.min(
            lowest,
            th.position[2] - groundAt(th.position[0], th.position[1]),
          );
    }
    console.log(
      `  ${totalThreats(game.spec)} real drones, best score ${maxScore(game.spec)}`,
    );
    console.log(
      `  undefended: ${JSON.stringify(counts)}, lowest over the ground while cruising ${Math.round(lowest)} m, all over after ${Math.round(game.time)} s`,
    );
    await overview(`${s.id}-site`, s.site.position, 16, 3, marks.slice(0, 2));
    await overview(`${s.id}-area`, s.site.position, 12, 3, marks);
  }
}
