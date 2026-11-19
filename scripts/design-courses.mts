/**
 * Designs the air-race courses from the 141 DEM, so no gate is placed from
 * memory, and draws a review map of each over the satellite imagery.
 *
 *   node --no-warnings scripts/design-courses.mts            # all courses
 *   node --no-warnings scripts/design-courses.mts damavand   # one
 *
 * - damavand: a lap round the volcano's cone, every gate on the slope at the
 *   same altitude, so the course follows the mountain's own shape.
 * - chalus: follows the Karaj river gorge (the Karaj–Chalus road's valley)
 *   upstream from the Amir Kabir dam, by walking the valley floor; each gate
 *   sits above the floor and is raised until the walls leave room to fly.
 * - lut-kaluts: the existing slalom, only re-measured (heights, length).
 *
 * Prints each course's gates as TypeScript for src/config/courses.ts and
 * writes scripts/courses/<id>.png: satellite imagery, the gates as rings
 * (amber = first, white = the rest), the start in green.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { COURSES } from "../src/config/courses.ts";
import { TILE_SERVER_URL } from "../src/config/map.ts";
import {
  ahead,
  bearing,
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

const OUT = path.join(ROOT, "scripts/courses");

interface DesignedGate {
  position: LngLat;
  /** Metres above sea level. */
  altitude: number;
  heading: number;
  radius: number;
}
interface Designed {
  id: string;
  start: { position: LngLat; altitude: number; heading: number; speed: number };
  gates: DesignedGate[];
  /** Typical racing speed on this course, m/s, for the medal times. */
  pace: number;
}

/** Headings from each gate towards the middle of its neighbours, so rings face the racing line. */
function faceAlong(start: LngLat, gates: DesignedGate[], loop = false) {
  gates.forEach((g, i) => {
    const prev =
      i > 0
        ? gates[i - 1].position
        : loop
          ? gates[gates.length - 1].position
          : start;
    const next = gates[i + 1]?.position ?? (loop ? gates[0].position : null);
    g.heading = Math.round(
      next ? bearing(prev, next) : bearing(prev, g.position),
    );
  });
}

/** Lowest clearance around a gate: how far sideways (perpendicular to its heading) until terrain rises above it. */
function sideRoom(dem: Dem, g: DesignedGate) {
  let room = Infinity;
  for (const side of [90, -90]) {
    let d = 0;
    while (
      d < 1500 &&
      dem.elev(ahead(g.position, g.heading + side, d)) < g.altitude
    )
      d += 10;
    room = Math.min(room, d);
  }
  return room;
}

async function damavand(): Promise<Designed> {
  const dem = await loadDem([52.109, 35.955], 12_000);
  // The summit: highest point near the guess.
  let summit: LngLat = [52.109, 35.955];
  let top = -Infinity;
  for (let e = -3000; e <= 3000; e += 50) {
    for (let n = -3000; n <= 3000; n += 50) {
      const p = offset([52.109, 35.955], e, n);
      const z = dem.elev(p);
      if (z > top) {
        top = z;
        summit = p;
      }
    }
  }
  console.log(
    `  summit ${summit.map((v) => round(v)).join(", ")} @ ${Math.round(top)} m`,
  );

  // 10 gates anticlockwise round the cone, each where the slope reaches the
  // contour, then stood off it so the ring floats beside the mountain.
  const CONTOUR = 4300;
  const STANDOFF = 240;
  const ALTITUDE = CONTOUR + 70;
  const gates: DesignedGate[] = [];
  for (let k = 0; k < 10; k++) {
    // Start in the south and go anticlockwise (east first).
    const az = (180 - k * 36 + 360) % 360;
    let r = 600;
    while (r < 9000 && dem.elev(ahead(summit, az, r)) > CONTOUR) r += 20;
    gates.push({
      position: ahead(summit, az, r + STANDOFF),
      altitude: ALTITUDE,
      heading: 0,
      radius: 32,
    });
  }
  // Approach from the south-west, heading for gate 1.
  const startPos = ahead(gates[0].position, 250, 2200);
  faceAlong(startPos, gates);
  for (const g of gates) {
    // Raise any gate the slope crowds.
    while (sideRoom(dem, g) < 120 && g.altitude < top) g.altitude += 20;
  }
  return {
    id: "damavand",
    start: {
      position: startPos,
      altitude: ALTITUDE + 60,
      heading: Math.round(bearing(startPos, gates[0].position)),
      speed: 70,
    },
    gates,
    pace: 78,
    ...{ dem },
  } as Designed & { dem: Dem };
}

async function chalus(): Promise<Designed> {
  // The Karaj–Chalus road's valley: east along the gorge above the Amir
  // Kabir reservoir, then north up the valley towards Gachsar. Rough guide
  // points read off the satellite overview (the road is drawn on it); the
  // walker below keeps to the valley floor between them, so the DEM, not the
  // guides, decides where the gates go.
  const GUIDES: LngLat[] = [
    [51.183, 36.035],
    [51.218, 36.029],
    [51.249, 36.021],
    [51.29, 36.017],
    [51.306, 36.06],
    [51.31, 36.095],
  ];
  const dem = await loadDem([51.25, 36.05], 12_000);
  // Snap the first guide to the valley floor.
  const floorNear = (q: LngLat, r: number) => {
    let best = q;
    let low = Infinity;
    for (let e = -r; e <= r; e += 20) {
      for (let n = -r; n <= r; n += 20) {
        const c = offset(q, e, n);
        const z = dem.elev(c);
        if (z < low) {
          low = z;
          best = c;
        }
      }
    }
    return best;
  };
  let p = floorNear(GUIDES[0], 300);
  const start = p;
  // Walk: each step picks the lowest ground just ahead within a fan around
  // the way to the next guide, penalising turning away from it.
  let guide = 1;
  let heading = bearing(p, GUIDES[1]);
  const STEP = 30;
  const path: LngLat[] = [p];
  for (let i = 0; i < 2000 && guide < GUIDES.length; i++) {
    if (dist(p, GUIDES[guide]) < 350) {
      guide++;
      if (guide >= GUIDES.length) break;
    }
    const toward = bearing(p, GUIDES[guide]);
    let bestH = heading;
    let best = Infinity;
    for (let dh = -50; dh <= 50; dh += 5) {
      const h = toward + dh;
      const s =
        dem.elev(ahead(p, h, 90)) +
        0.6 * dem.elev(ahead(p, h, 200)) +
        0.6 * Math.abs(dh);
      if (s < best) {
        best = s;
        bestH = h;
      }
    }
    const turn = ((bestH - heading + 540) % 360) - 180;
    heading += Math.max(-8, Math.min(8, turn));
    p = ahead(p, heading, STEP);
    path.push(p);
  }
  // Smooth, then a gate every ~1.3 km.
  const smooth = path.map((_, i) => {
    let lng = 0;
    let lat = 0;
    let n = 0;
    for (
      let j = Math.max(0, i - 8);
      j <= Math.min(path.length - 1, i + 8);
      j++
    ) {
      lng += path[j][0];
      lat += path[j][1];
      n++;
    }
    return [lng / n, lat / n] as LngLat;
  });
  const gates: DesignedGate[] = [];
  let acc = 0;
  for (let i = 1; i < smooth.length; i++) {
    acc += dist(smooth[i - 1], smooth[i]);
    if (acc >= 1300 && i > 15) {
      // The floor here: lowest ground across the valley, so the gate sits mid-gorge.
      const along = bearing(smooth[i - 1], smooth[i]);
      let floor: LngLat = smooth[i];
      let floorZ = dem.elev(floor);
      for (let s = -450; s <= 450; s += 10) {
        const q = ahead(smooth[i], along + 90, s);
        const z = dem.elev(q);
        if (z < floorZ) {
          floorZ = z;
          floor = q;
        }
      }
      gates.push({
        position: floor,
        altitude: floorZ + 70,
        heading: 0,
        radius: 30,
      });
      acc = 0;
    }
  }
  // A gate whose floor is well above both neighbours' is on a side terrace,
  // not in the gorge (a river does not climb and fall again): move it to the
  // lowest ground between them.
  for (let i = 1; i < gates.length - 1; i++) {
    const [a, g, b] = [gates[i - 1], gates[i], gates[i + 1]];
    if (g.altitude - 40 > Math.max(a.altitude, b.altitude)) {
      const mid: LngLat = [
        (a.position[0] + b.position[0]) / 2,
        (a.position[1] + b.position[1]) / 2,
      ];
      g.position = floorNear(mid, 350);
      g.altitude = dem.elev(g.position) + 70;
    }
  }
  faceAlong(smooth[1] ?? start, gates);
  for (const g of gates) {
    while (sideRoom(dem, g) < 110 && g.altitude < 4000) g.altitude += 10;
  }
  // The start: back from gate 1 along the gorge (the walked path, then straight
  // back along gate 1's heading), as far as possible while the straight line
  // to gate 1 clears the ground by 40 m and the walls leave room either side.
  // The first version started where the walk began and faced a cliff.
  const first = gates[0];
  const clearLine = (from: LngLat, altitude: number) => {
    for (let f = 0; f <= 1; f += 0.04) {
      const at: LngLat = [
        from[0] + (first.position[0] - from[0]) * f,
        from[1] + (first.position[1] - from[1]) * f,
      ];
      if (dem.elev(at) + 40 > altitude + (first.altitude - altitude) * f)
        return false;
    }
    return true;
  };
  // Candidates: straight back from gate 1 along the reverse of its heading,
  // and every point of the walked path before it. Each is tried at a few
  // heights above gate 1: a start higher up the gorge that dives in is fine.
  const candidates: LngLat[] = [];
  for (let d = 500; d <= 1600; d += 50)
    candidates.push(ahead(first.position, (first.heading + 180) % 360, d));
  const nearest = smooth.reduce(
    (best, p, i) =>
      dist(p, first.position) < dist(smooth[best], first.position) ? i : best,
    0,
  );
  for (let i = nearest; i >= 0; i--) candidates.push(smooth[i]);
  let best: { position: LngLat; altitude: number; score: number } | null = null;
  for (const c of candidates) {
    const d = dist(c, first.position);
    if (d < 600) continue;
    for (const above of [20, 50, 90, 140, 200]) {
      const altitude = Math.max(first.altitude + above, dem.elev(c) + 70);
      const room = sideRoom(dem, {
        position: c,
        altitude,
        heading: bearing(c, first.position),
        radius: 0,
      });
      if (!clearLine(c, altitude) || room < 110) continue;
      // Prefer a long run-in at a low height.
      const score = Math.min(d, 1300) - (altitude - first.altitude) * 2;
      if (!best || score > best.score) best = { position: c, altitude, score };
      break;
    }
  }
  // Not a long, low run-in? Then the gorge bends just before gate 1: start
  // there instead, on its spot over the floor, facing down the gorge to the
  // next gate (gates 1–3 lie on one straight reach).
  let startPos: LngLat;
  let startAlt: number;
  if (
    best &&
    dist(best.position, first.position) >= 900 &&
    best.altitude - first.altitude <= 60
  ) {
    startPos = best.position;
    startAlt = best.altitude;
  } else {
    const dropped = gates.shift()!;
    startPos = dropped.position;
    startAlt = dropped.altitude;
    const next = gates[0];
    const reach: LngLat[] = [];
    for (let f = 0; f <= 1; f += 0.04)
      reach.push([
        startPos[0] + (next.position[0] - startPos[0]) * f,
        startPos[1] + (next.position[1] - startPos[1]) * f,
      ]);
    const lowest = Math.min(
      ...reach.map(
        (p, i) =>
          startAlt +
          (next.altitude - startAlt) * (i / (reach.length - 1)) -
          dem.elev(p),
      ),
    );
    console.log(
      `  started at the old gate 1 instead; lowest clearance on the way to the new gate 1: ${Math.round(lowest)} m`,
    );
  }
  console.log(
    `  start ${Math.round(dist(startPos, first.position))} m before gate 1, ${Math.round(startAlt - first.altitude)} m above it, room ${sideRoom(dem, { position: startPos, altitude: startAlt, heading: bearing(startPos, first.position), radius: 0 })} m`,
  );
  return {
    id: "chalus",
    start: {
      position: startPos,
      altitude: startAlt,
      heading: Math.round(bearing(startPos, gates[0].position)),
      speed: 65,
    },
    gates,
    pace: 72,
    ...{ dem },
  } as Designed & { dem: Dem };
}

async function kaluts(): Promise<Designed> {
  const course = COURSES.find((c) => c.id === "lut-kaluts")!;
  const dem = await loadDem(course.gates[4].position, 9000);
  return {
    id: "lut-kaluts",
    start: {
      position: course.start.position,
      altitude: dem.elev(course.start.position) + course.start.height,
      heading: course.start.heading,
      speed: course.start.speed,
    },
    gates: course.gates.map((g) => ({
      ...g,
      altitude: dem.elev(g.position) + g.height,
    })),
    pace: 88,
    ...{ dem },
  } as Designed & { dem: Dem };
}

/* ------------------------------------------------------------------------ */
/* Output                                                                    */
/* ------------------------------------------------------------------------ */

const length = (c: Designed) =>
  c.gates.reduce(
    (sum, g, i) =>
      sum +
      dist(i === 0 ? c.start.position : c.gates[i - 1].position, g.position),
    0,
  );

function print(c: Designed & { dem: Dem }) {
  const L = length(c);
  const gold = Math.round(L / c.pace);
  console.log(`  ${c.gates.length} gates, ${(L / 1000).toFixed(1)} km`);
  console.log(
    `    start: { position: [${c.start.position.map((v) => round(v))}], height: ${Math.round(c.start.altitude - c.dem.elev(c.start.position))}, heading: ${c.start.heading}, speed: ${c.start.speed} },`,
  );
  console.log("    gates: [");
  for (const g of c.gates) {
    const agl = Math.round(g.altitude - c.dem.elev(g.position));
    console.log(
      `      { position: [${g.position.map((v) => round(v))}], height: ${agl}, heading: ${g.heading}, radius: ${g.radius} }, // ${Math.round(g.altitude)} m, room ${sideRoom(c.dem, g)} m`,
    );
  }
  console.log("    ],");
  console.log(
    `    medals: { gold: ${gold}, silver: ${Math.round(gold * 1.1)}, bronze: ${Math.round(gold * 1.25)} },`,
  );
}

/** Satellite imagery under the course, with the gates drawn on it. */
async function reviewMap(c: Designed) {
  const points = [c.start.position, ...c.gates.map((g) => g.position)];
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  const [west, south] = offset(
    [Math.min(...lngs), Math.min(...lats)],
    -700,
    -700,
  );
  const [east, north] = offset(
    [Math.max(...lngs), Math.max(...lats)],
    700,
    700,
  );
  // The deepest zoom that keeps the mosaic within ~16 tiles a side.
  let z = 15;
  while (
    z > 10 &&
    (tileX(east, z) - tileX(west, z) > 14 ||
      tileY(south, z) - tileY(north, z) > 14)
  )
    z--;
  const tx0 = Math.floor(tileX(west, z));
  const tx1 = Math.floor(tileX(east, z));
  const ty0 = Math.floor(tileY(north, z));
  const ty1 = Math.floor(tileY(south, z));
  const T = 512;
  const composites: { input: Buffer; left: number; top: number }[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const res = await fetch(
        `${TILE_SERVER_URL}/styles/satellite/${z}/${tx}/${ty}@2x.png`,
      );
      if (!res.ok) continue;
      composites.push({
        input: Buffer.from(await res.arrayBuffer()),
        left: (tx - tx0) * T,
        top: (ty - ty0) * T,
      });
    }
  }
  const W = (tx1 - tx0 + 1) * T;
  const H = (ty1 - ty0 + 1) * T;
  const px = ([lng, lat]: LngLat) => [
    (tileX(lng, z) - tx0) * T,
    (tileY(lat, z) - ty0) * T,
  ];
  const metresPerPx =
    (2 * Math.PI * R * Math.cos(c.gates[0].position[1] * RAD)) / (2 ** z * T);
  const svg: string[] = [];
  const line = [c.start.position, ...c.gates.map((g) => g.position)]
    .map(px)
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`);
  svg.push(
    `<polyline points="${line.join(" ")}" fill="none" stroke="#ffb547" stroke-opacity="0.55" stroke-width="3" stroke-dasharray="10 8"/>`,
  );
  c.gates.forEach((g, i) => {
    const [x, y] = px(g.position);
    // The ring seen from above: a bar across the flying direction, as wide as the ring.
    const half = Math.max(6, g.radius / metresPerPx);
    const a = (g.heading + 90) * RAD;
    const dx = Math.sin(a) * half;
    const dy = -Math.cos(a) * half;
    const colour = i === 0 ? "#ffb547" : "#ffffff";
    svg.push(
      `<line x1="${x - dx}" y1="${y - dy}" x2="${x + dx}" y2="${y + dy}" stroke="${colour}" stroke-width="7" stroke-linecap="round"/>`,
    );
    svg.push(
      `<text x="${x + 14}" y="${y - 10}" font-family="sans-serif" font-weight="700" font-size="26" fill="#fff" stroke="#000" stroke-width="4" paint-order="stroke">${i + 1}</text>`,
    );
  });
  const [sx, sy] = px(c.start.position);
  svg.push(
    `<circle cx="${sx}" cy="${sy}" r="12" fill="#3ddc84" stroke="#000" stroke-width="3"/>`,
  );
  composites.push({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg.join("")}</svg>`,
    ),
    left: 0,
    top: 0,
  });
  await mkdir(OUT, { recursive: true });
  const file = path.join(OUT, `${c.id}.png`);
  // Sharp resizes before it composites, so flatten first.
  const flat = await sharp({
    create: { width: W, height: H, channels: 3, background: "#6b675d" },
  })
    .composite(composites)
    .png()
    .toBuffer();
  await sharp(flat).resize(Math.min(W, 1800)).png().toFile(file);
  console.log(`  ✓ ${path.relative(ROOT, file)} (zoom ${z})`);
}

const DESIGNERS: Record<string, () => Promise<Designed>> = {
  damavand,
  chalus,
  "lut-kaluts": kaluts,
};
const only = process.argv[2];
for (const [id, design] of Object.entries(DESIGNERS)) {
  if (only && only !== id) continue;
  console.log(`● ${id}`);
  const course = (await design()) as Designed & { dem: Dem };
  print(course);
  await reviewMap(course);
}
