/**
 * A snow avalanche as a cloud of lumps sliding down the real terrain: each
 * lump accelerates down the local slope (gravity along it, less Coulomb
 * friction and air drag), follows the fall line as it bends, spreads a
 * little, and comes to rest where the ground flattens out. The cloud's front
 * (the furthest-down moving lump) is what overruns a spot.
 *
 * Positions are local east-north-up metres; the caller moves them with the
 * origin.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import type { GroundFn } from "./contact.ts";
import type { Vec3 } from "./vec.ts";

export interface Lump {
  position: Vec3;
  velocity: Vec3;
  /** Seconds since it came to rest, or −1 while moving. */
  resting: number;
}

export interface Avalanche {
  lumps: Lump[];
  time: number;
}

const G = 9.80665;
/** Snow on snow: the slope (tan) below which a lump decelerates and stops. */
const FRICTION = 0.2;
/** Air and snow drag, 1/m: caps the speed near 45 m/s on steep slopes. */
const DRAG = 0.0045;
/** Below this speed on gentle ground a lump stops, m/s. */
const STOP_SPEED = 0.6;
/** Metres between elevation samples for the slope. */
const PROBE = 6;

/**
 * Lumps released across a crown: `count` of them spread along a line `width`
 * metres long through `at`, across the downhill direction.
 */
export function releaseAvalanche(
  at: Vec3,
  ground: GroundFn,
  width: number,
  count: number,
  seed = 1,
): Avalanche {
  const [gx, gy] = gradient(ground, at[0], at[1]);
  const len = Math.hypot(gx, gy) || 1;
  // Across the slope: perpendicular to the fall line.
  const ax = -gy / len;
  const ay = gx / len;
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const lumps: Lump[] = [];
  for (let i = 0; i < count; i++) {
    const along =
      (i / Math.max(1, count - 1) - 0.5) * width + (next() - 0.5) * 8;
    const back = (next() - 0.5) * 20;
    const x = at[0] + ax * along + (gx / len) * back;
    const y = at[1] + ay * along + (gy / len) * back;
    lumps.push({
      position: [x, y, ground(x, y)],
      velocity: [0, 0, 0],
      resting: -1,
    });
  }
  return { lumps, time: 0 };
}

/** Uphill gradient of the ground (rise per metre east and north). */
function gradient(ground: GroundFn, x: number, y: number): [number, number] {
  return [
    (ground(x + PROBE, y) - ground(x - PROBE, y)) / (2 * PROBE),
    (ground(x, y + PROBE) - ground(x, y - PROBE)) / (2 * PROBE),
  ];
}

/** Advance the avalanche by dt seconds (mutates it). */
export function stepAvalanche(
  avalanche: Avalanche,
  ground: GroundFn,
  dt: number,
) {
  avalanche.time += dt;
  for (const lump of avalanche.lumps) {
    if (lump.resting >= 0) {
      lump.resting += dt;
      continue;
    }
    const [x, y] = lump.position;
    const [gx, gy] = gradient(ground, x, y);
    const slope = Math.hypot(gx, gy);
    const speed = Math.hypot(lump.velocity[0], lump.velocity[1]);
    // Along the ground: gravity's component down the slope, friction against the motion, drag.
    const sin = slope / Math.sqrt(1 + slope * slope);
    const cos = 1 / Math.sqrt(1 + slope * slope);
    let ax = slope > 1e-6 ? (-gx / slope) * G * sin : 0;
    let ay = slope > 1e-6 ? (-gy / slope) * G * sin : 0;
    if (speed > 1e-3) {
      const brake = FRICTION * G * cos + DRAG * speed * speed;
      ax -= (lump.velocity[0] / speed) * brake;
      ay -= (lump.velocity[1] / speed) * brake;
    }
    lump.velocity = [lump.velocity[0] + ax * dt, lump.velocity[1] + ay * dt, 0];
    const nextSpeed = Math.hypot(lump.velocity[0], lump.velocity[1]);
    if (nextSpeed < STOP_SPEED && slope < FRICTION * 1.2) {
      lump.velocity = [0, 0, 0];
      lump.resting = 0;
      continue;
    }
    const nx = x + lump.velocity[0] * dt;
    const ny = y + lump.velocity[1] * dt;
    lump.position = [nx, ny, ground(nx, ny)];
  }
}

/** Whether any moving lump is within `radius` metres (horizontally) of a spot. */
export function overruns(avalanche: Avalanche, spot: Vec3, radius: number) {
  return avalanche.lumps.some(
    (l) =>
      l.resting < 0 &&
      Math.hypot(l.position[0] - spot[0], l.position[1] - spot[1]) < radius,
  );
}

/** Lumps still moving. */
export const moving = (avalanche: Avalanche) =>
  avalanche.lumps.filter((l) => l.resting < 0).length;

/** Move every lump when the local frame's origin moves by (east, north). */
export function shiftAvalanche(
  avalanche: Avalanche,
  east: number,
  north: number,
) {
  for (const l of avalanche.lumps)
    l.position = [l.position[0] - east, l.position[1] - north, l.position[2]];
}
