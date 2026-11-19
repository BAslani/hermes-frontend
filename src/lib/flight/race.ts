/**
 * Air-race logic: when a gate counts as passed, the race clock with its
 * countdown, splits and missed-gate penalties, ghost recording and replay,
 * and where an off-screen gate lies on the screen.
 *
 * Gates are vertical rings. A gate is passed when the segment between two
 * physics steps crosses the ring's plane in the flying direction, inside the
 * ring. Checking the segment, not the end points, means a fast aircraft can
 * never skip a gate between two steps.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import { applyMat3, type Mat3 } from "./camera.ts";
import {
  dot,
  length,
  lerp,
  nlerp,
  type Quat,
  RAD,
  sub,
  type Vec3,
} from "./vec.ts";

/* ------------------------------------------------------------------------ */
/* Gates                                                                     */
/* ------------------------------------------------------------------------ */

export interface Gate {
  /** Ring centre, east-north-up metres in the simulation's local frame. */
  center: Vec3;
  /** Unit vector the aircraft must fly along to pass, horizontal. */
  normal: Vec3;
  /** Metres, to the inside of the ring. */
  radius: number;
}

/** The horizontal unit vector for a heading in degrees from north. */
export const headingVector = (heading: number): Vec3 => [
  Math.sin(heading * RAD),
  Math.cos(heading * RAD),
  0,
];

export interface Crossing {
  /** 0–1: where along the segment the plane is crossed. */
  t: number;
  /** Distance from the ring centre where it is crossed, metres. */
  distance: number;
}

/**
 * Where the segment a → b crosses the gate's plane in the flying direction,
 * or null if it does not. Whether that is inside the ring is `distance <= radius`.
 */
export function gateCrossing(a: Vec3, b: Vec3, gate: Gate): Crossing | null {
  const da = dot(sub(a, gate.center), gate.normal);
  const db = dot(sub(b, gate.center), gate.normal);
  if (!(da < 0 && db >= 0)) return null;
  const t = da / (da - db);
  const at: Vec3 = [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  return { t, distance: length(sub(at, gate.center)) };
}

/* ------------------------------------------------------------------------ */
/* Race clock                                                                */
/* ------------------------------------------------------------------------ */

/** Seconds of countdown before the clock starts. */
export const COUNTDOWN = 3;
/** Seconds added for every gate missed. */
export const MISSED_PENALTY = 5;
/** A gate's plane crossed further out than this many radii is not an attempt at it (flying past elsewhere). */
const ATTEMPT_RADII = 12;
/** Passing a later gate first counts the ones before it as missed, but only this many ahead. */
const LOOKAHEAD = 2;

export type GateResult = { passed: true; time: number } | { passed: false };

export interface Race {
  phase: "countdown" | "racing" | "finished";
  /** Seconds: counts up from −COUNTDOWN; the race starts at 0. */
  time: number;
  /** Index of the gate to fly through next. */
  next: number;
  results: (GateResult | null)[];
  /** Seconds of penalty so far. */
  penalty: number;
  /** Race time plus penalties, once finished. */
  total: number | null;
}

export type RaceEvent =
  | { type: "start" }
  | { type: "gate"; index: number; time: number }
  | { type: "missed"; index: number }
  | { type: "finish"; total: number };

export function newRace(gateCount: number): Race {
  return {
    phase: "countdown",
    time: -COUNTDOWN,
    next: 0,
    results: Array.from({ length: gateCount }, () => null),
    penalty: 0,
    total: null,
  };
}

/**
 * Advance the race by one physics step in which the aircraft moved from a
 * to b (mutates the race). During the countdown the aircraft is held still,
 * so a and b are ignored.
 */
export function stepRace(
  race: Race,
  gates: Gate[],
  a: Vec3,
  b: Vec3,
  dt: number,
): RaceEvent[] {
  const events: RaceEvent[] = [];
  if (race.phase === "finished") return events;
  if (race.phase === "countdown") {
    race.time += dt;
    if (race.time >= 0) {
      race.phase = "racing";
      race.time = 0;
      events.push({ type: "start" });
    }
    return events;
  }

  const start = race.time;
  race.time += dt;
  /** When in this step the race ended: the moment of the last crossing, else the end of the step. */
  let endedAt = race.time;
  const miss = (index: number) => {
    race.results[index] = { passed: false };
    race.penalty += MISSED_PENALTY;
    events.push({ type: "missed", index });
  };

  // Through the next gate, or one a little further on (the ones skipped are missed)?
  let resolved = false;
  for (
    let k = race.next;
    k < Math.min(race.next + 1 + LOOKAHEAD, gates.length);
    k++
  ) {
    const crossing = gateCrossing(a, b, gates[k]);
    if (!crossing || crossing.distance > gates[k].radius) continue;
    for (let skipped = race.next; skipped < k; skipped++) miss(skipped);
    const time = start + crossing.t * dt;
    race.results[k] = { passed: true, time };
    events.push({ type: "gate", index: k, time });
    race.next = k + 1;
    endedAt = time;
    resolved = true;
    break;
  }
  // Flew past the next gate, outside the ring but near enough to have been trying.
  if (!resolved && race.next < gates.length) {
    const gate = gates[race.next];
    const crossing = gateCrossing(a, b, gate);
    if (crossing && crossing.distance <= gate.radius * ATTEMPT_RADII) {
      miss(race.next);
      race.next += 1;
    }
  }

  if (race.next >= gates.length) {
    race.phase = "finished";
    race.time = endedAt;
    race.total = race.time + race.penalty;
    events.push({ type: "finish", total: race.total });
  }
  return events;
}

/** Time at each gate passed, null where missed or not reached. */
export const splitTimes = (race: Race): (number | null)[] =>
  race.results.map((result) => (result && result.passed ? result.time : null));

export type Medal = "gold" | "silver" | "bronze" | null;

export function medalFor(
  total: number,
  targets: { gold: number; silver: number; bronze: number },
): Medal {
  if (total <= targets.gold) return "gold";
  if (total <= targets.silver) return "silver";
  if (total <= targets.bronze) return "bronze";
  return null;
}

/* ------------------------------------------------------------------------ */
/* Ghost                                                                     */
/* ------------------------------------------------------------------------ */

/** Ghost samples per second. */
export const GHOST_HZ = 10;

/** [race time s, lng, lat, altitude m, qx, qy, qz, qw]. */
export type GhostFrame = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface GhostPose {
  lng: number;
  lat: number;
  altitude: number;
  orientation: Quat;
}

/** Records a pose every 1 / GHOST_HZ seconds of race time. */
export class GhostRecorder {
  readonly frames: GhostFrame[] = [];
  private nextAt = 0;

  /** Call every frame while racing; keeps a sample only when one is due. */
  sample(time: number, pose: GhostPose) {
    if (time < this.nextAt) return;
    const [x, y, z, w] = pose.orientation;
    // Rounded so a stored run stays small: ~1 cm and 1e-5 quaternion units.
    const r = (v: number, digits: number) => Number(v.toFixed(digits));
    this.frames.push([
      r(time, 2),
      r(pose.lng, 7),
      r(pose.lat, 7),
      r(pose.altitude, 2),
      r(x, 5),
      r(y, 5),
      r(z, 5),
      r(w, 5),
    ]);
    this.nextAt = time + 1 / GHOST_HZ;
  }
}

/** The ghost's pose at race time t, interpolated; null before the first or after the last sample. */
export function sampleGhost(frames: GhostFrame[], t: number): GhostPose | null {
  if (
    frames.length === 0 ||
    t < frames[0][0] ||
    t > frames[frames.length - 1][0]
  )
    return null;
  let lo = 0;
  let hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const a = frames[lo];
  const b = frames[hi];
  const span = b[0] - a[0];
  const f = span > 0 ? (t - a[0]) / span : 0;
  return {
    lng: lerp(a[1], b[1], f),
    lat: lerp(a[2], b[2], f),
    altitude: lerp(a[3], b[3], f),
    orientation: nlerp([a[4], a[5], a[6], a[7]], [b[4], b[5], b[6], b[7]], f),
  };
}

/* ------------------------------------------------------------------------ */
/* Pointing at the next gate                                                 */
/* ------------------------------------------------------------------------ */

export interface ScreenPoint {
  /** Normalised device coordinates: −1…1 across the view, y up. */
  x: number;
  y: number;
  /** In front of the camera and inside the view. */
  visible: boolean;
  /** Direction from the screen centre towards the point, radians anticlockwise from screen right. */
  angle: number;
  /** Straight-line distance, metres. */
  distance: number;
}

/**
 * Where a point lies on the screen of a camera with the eye rotation `eye`
 * (camera.ts) and vertical field of view `fov` degrees. `offset` is the point
 * minus the camera position, east-north-up. Points behind the camera get the
 * direction to turn towards them.
 */
export function screenPoint(
  eye: Mat3,
  offset: Vec3,
  fov: number,
  aspect: number,
): ScreenPoint {
  const [ex, ey, ez] = applyMat3(eye, offset);
  const distance = length(offset);
  const tan = Math.tan((fov * RAD) / 2);
  if (ez < 0) {
    const x = ex / -ez / (tan * aspect);
    const y = ey / -ez / tan;
    return {
      x,
      y,
      visible: Math.abs(x) <= 1 && Math.abs(y) <= 1,
      angle: Math.atan2(y, x),
      distance,
    };
  }
  // Behind: point the way round, never straight ahead.
  const angle = Math.atan2(ey, ex === 0 && ey === 0 ? 1 : ex);
  return {
    x: Math.cos(angle) * 2,
    y: Math.sin(angle) * 2,
    visible: false,
    angle,
    distance,
  };
}
