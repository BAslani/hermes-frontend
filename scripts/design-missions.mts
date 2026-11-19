/**
 * Designs the helicopter missions' sites from the 141 DEM, so no landing
 * zone is placed from memory, and draws a close-up of each site over the
 * satellite imagery for review.
 *
 *   node --no-warnings scripts/design-missions.mts
 *
 * - Landing zones: the flattest disc of the zone's radius near a guide point
 *   (read off the satellite overview), by the slope of a plane fitted to the
 *   ground under it.
 * - Hoist spots: steep ground (no landing possible) near a guide, with nothing
 *   higher within reach of the rotor while hovering above it.
 *
 * Prints the sites as TypeScript for src/config/missions.ts and writes
 * scripts/missions/<site>.png.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { TILE_SERVER_URL } from "../src/config/map.ts";
import {
  type Dem,
  dist,
  type LngLat,
  loadDem,
  offset,
  R,
  RAD,
  ROOT,
  round,
  tileX,
  tileY,
} from "./lib/dem.mts";

const OUT = path.join(ROOT, "scripts/missions");

/** Slope (rise over run) of the plane best fitting the ground in a disc, and its roughness. */
function flatness(dem: Dem, at: LngLat, radius: number) {
  const pts: [number, number, number][] = [];
  for (let e = -radius; e <= radius; e += radius / 3) {
    for (let n = -radius; n <= radius; n += radius / 3) {
      if (Math.hypot(e, n) > radius) continue;
      pts.push([e, n, dem.elev(offset(at, e, n))]);
    }
  }
  // Least squares z = a e + b n + c (e and n are centred, so c is the mean).
  const mean = pts.reduce((s, p) => s + p[2], 0) / pts.length;
  let see = 0,
    snn = 0,
    sez = 0,
    snz = 0;
  for (const [e, n, z] of pts) {
    see += e * e;
    snn += n * n;
    sez += e * (z - mean);
    snz += n * (z - mean);
  }
  const a = sez / see;
  const b = snz / snn;
  const rough = Math.max(
    ...pts.map(([e, n, z]) => Math.abs(z - (mean + a * e + b * n))),
  );
  return { slope: Math.hypot(a, b), rough, ground: mean };
}

function flattestNear(dem: Dem, guide: LngLat, search: number, radius: number) {
  let best: {
    at: LngLat;
    slope: number;
    rough: number;
    ground: number;
    score: number;
  } | null = null;
  for (let e = -search; e <= search; e += 20) {
    for (let n = -search; n <= search; n += 20) {
      if (Math.hypot(e, n) > search) continue;
      const at = offset(guide, e, n);
      const f = flatness(dem, at, radius);
      const score = f.slope + f.rough / 20 + Math.hypot(e, n) / 20_000;
      if (!best || score < best.score) best = { at, ...f, score };
    }
  }
  return best!;
}

/** Steep ground near a guide, clear above: the hoist works, landing does not. */
function hoistSpotNear(dem: Dem, guide: LngLat, search: number) {
  let best: {
    at: LngLat;
    slope: number;
    ground: number;
    score: number;
  } | null = null;
  for (let e = -search; e <= search; e += 15) {
    for (let n = -search; n <= search; n += 15) {
      if (Math.hypot(e, n) > search) continue;
      const at = offset(guide, e, n);
      const f = flatness(dem, at, 15);
      if (f.slope < 0.45) continue; // too gentle: it could just land
      // Hovering 20 m up, the rotor (5 m) and tail must clear everything within 14 m.
      let clear = true;
      for (let a = 0; a < 360 && clear; a += 30) {
        for (const d of [6, 10, 14]) {
          const p = offset(at, Math.sin(a * RAD) * d, Math.cos(a * RAD) * d);
          if (dem.elev(p) > f.ground + 12) clear = false;
        }
      }
      if (!clear) continue;
      const score = -f.slope + Math.hypot(e, n) / 3000;
      if (!best || score < best.score)
        best = { at, slope: f.slope, ground: f.ground, score };
    }
  }
  return best;
}

/** Satellite close-up around a site (zoom 16, about 1.5 km across), with the zone drawn on it. */
async function siteMap(
  name: string,
  at: LngLat,
  radius: number,
  colour: string,
) {
  const z = 16;
  const cx = tileX(at[0], z);
  const cy = tileY(at[1], z);
  const tx0 = Math.floor(cx) - 1;
  const ty0 = Math.floor(cy) - 1;
  const T = 512;
  const composites: { input: Buffer; left: number; top: number }[] = [];
  for (let ty = ty0; ty < ty0 + 3; ty++) {
    for (let tx = tx0; tx < tx0 + 3; tx++) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(
            `${TILE_SERVER_URL}/styles/satellite/${z}/${tx}/${ty}@2x.png`,
          );
          if (res.ok)
            composites.push({
              input: Buffer.from(await res.arrayBuffer()),
              left: (tx - tx0) * T,
              top: (ty - ty0) * T,
            });
          break;
        } catch {
          /* retry */
        }
      }
    }
  }
  const metresPerPx = (2 * Math.PI * R * Math.cos(at[1] * RAD)) / (2 ** z * T);
  const x = (cx - tx0) * T;
  const y = (cy - ty0) * T;
  const r = Math.max(6, radius / metresPerPx);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${3 * T}" height="${3 * T}"><circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${colour}" stroke-width="5"/><circle cx="${x}" cy="${y}" r="4" fill="${colour}"/><text x="${x + r + 8}" y="${y}" font-family="sans-serif" font-size="30" font-weight="700" fill="#fff" stroke="#000" stroke-width="5" paint-order="stroke">${name}</text></svg>`;
  composites.push({ input: Buffer.from(svg), left: 0, top: 0 });
  await mkdir(OUT, { recursive: true });
  const flat = await sharp({
    create: { width: 3 * T, height: 3 * T, channels: 3, background: "#6b675d" },
  })
    .composite(composites)
    .png()
    .toBuffer();
  await sharp(flat)
    .resize(900)
    .png()
    .toFile(path.join(OUT, `${name}.png`));
}

const fmt = (p: LngLat) => `[${round(p[0])}, ${round(p[1])}]`;

const dem = await loadDem([51.4, 35.88], 22_000);

const SITES: {
  name: string;
  kind: "land" | "hoist";
  guide: LngLat;
  search: number;
  radius: number;
}[] = [
  // North-west Tehran at the foot of the mountains: the base.
  { name: "base", kind: "land", guide: [51.3, 35.8], search: 1500, radius: 30 },
  // Up the Kan valley road towards Imamzadeh Davud.
  {
    name: "kan-village",
    kind: "land",
    guide: [51.262, 35.945],
    search: 800,
    radius: 22,
  },
  // Below Tochal's summit.
  {
    name: "tochal-climber",
    kind: "hoist",
    guide: [51.4, 35.885],
    search: 900,
    radius: 12,
  },
  // On the Tehran–Fasham road (the guide was read off the overview as the Shemshak road; the imagery labels it Fasham).
  {
    name: "shemshak-road",
    kind: "land",
    guide: [51.526, 35.915],
    search: 350,
    radius: 18,
  },
  // North-east Tehran: a second pad, the hospital for the Fasham road mission.
  // The DEM has no buildings, so a free search picked a rooftop block; this guide is the vacant lot
  // just north of Lavasani Boulevard, read off the first close-up.
  {
    name: "east-hospital",
    kind: "land",
    guide: [51.46765, 35.80082],
    search: 40,
    radius: 25,
  },
];

for (const site of SITES) {
  if (site.kind === "land") {
    const f = flattestNear(dem, site.guide, site.search, site.radius);
    console.log(
      `${site.name}: ${fmt(f.at)} ground ${Math.round(f.ground)} m, slope ${(Math.atan(f.slope) / RAD).toFixed(1)}°, roughness ${f.rough.toFixed(1)} m, ${Math.round(dist(site.guide, f.at))} m from the guide`,
    );
    await siteMap(site.name, f.at, site.radius, "#ffb547");
  } else {
    // Tochal: start from the summit, the highest point near the guide.
    let summit = site.guide;
    let top = -Infinity;
    for (let e = -1500; e <= 1500; e += 30) {
      for (let n = -1500; n <= 1500; n += 30) {
        const p = offset(site.guide, e, n);
        const zz = dem.elev(p);
        if (zz > top) {
          top = zz;
          summit = p;
        }
      }
    }
    const spot = hoistSpotNear(dem, offset(summit, 0, -350), site.search);
    console.log(`  summit ${fmt(summit)} @ ${Math.round(top)} m`);
    if (!spot) {
      console.log(`${site.name}: no steep, clear spot found`);
      continue;
    }
    console.log(
      `${site.name}: ${fmt(spot.at)} ground ${Math.round(spot.ground)} m, slope ${(Math.atan(spot.slope) / RAD).toFixed(0)}°, ${Math.round(dist(summit, spot.at))} m from the summit`,
    );
    await siteMap(site.name, spot.at, site.radius, "#ff5a3c");
  }
}
const base = SITES[0];
void base;
