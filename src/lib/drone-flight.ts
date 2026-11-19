/**
 * Drone flight maths: pure functions, no DOM or MapLibre, unit-tested in
 * drone-flight.test.mts.
 *
 * A flight is a list of legs flown from a start camera. The path is defined
 * by heading as a function of distance flown (turns follow a smootherstep, so
 * the turn rate is zero at every join) and is integrated into a lookup table
 * of positions. Time maps to distance with a cubic Hermite per leg, so speed
 * is continuous from one leg to the next. Heights are metres above the
 * rendered (exaggerated) terrain — the same space MapLibre's
 * queryTerrainElevation() and calculateCameraOptionsFromCameraLngLatAltRotation()
 * use.
 *
 * Keep this file import-free (types only): Node runs the tests on it directly.
 */
import type { FlightLeg, FlightPhase } from "../config/flights.ts";

export interface ViewerView {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

/** "#zoom/lat/lng[/bearing[/pitch]]" from a tileserver-gl viewer URL. */
export function parseViewerHash(url: string): ViewerView {
  const hash = url.slice(url.indexOf("#") + 1);
  const [zoom, lat, lng, bearing = 0, pitch = 0] = hash.split("/").map(Number);
  if (![zoom, lat, lng, bearing, pitch].every(Number.isFinite)) {
    throw new Error(`Not a map viewer position: ${url}`);
  }
  return { center: [lng, lat], zoom, bearing, pitch };
}

const EARTH_RADIUS = 6371008.8;
const RAD = Math.PI / 180;

export const smootherstep = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * t * (t * (6 * t - 15) + 10);
};

/** Move a lng/lat by metres east/north (local tangent plane; fine over a few km). */
export function offset(
  [lng, lat]: [number, number],
  east: number,
  north: number,
): [number, number] {
  return [
    lng + east / (EARTH_RADIUS * Math.cos(lat * RAD) * RAD),
    lat + north / (EARTH_RADIUS * RAD),
  ];
}

export function distanceMetres(a: [number, number], b: [number, number]) {
  const x = (b[0] - a[0]) * RAD * Math.cos(((a[1] + b[1]) / 2) * RAD);
  const y = (b[1] - a[1]) * RAD;
  return Math.hypot(x, y) * EARTH_RADIUS;
}

export interface CameraPose {
  position: [number, number];
  /** Metres above sea level, in rendered (exaggerated) terrain space. */
  altitude: number;
  bearing: number;
  pitch: number;
}

/**
 * Where MapLibre puts the camera for a center/zoom/bearing/pitch view, given
 * the map's height in CSS pixels, vertical field of view and the rendered
 * elevation of the center point.
 */
export function cameraFromView(
  view: ViewerView,
  viewport: { height: number; fov: number; centerElevation: number },
): CameraPose {
  const metresPerPixel =
    (2 * Math.PI * EARTH_RADIUS * Math.cos(view.center[1] * RAD)) /
    (512 * 2 ** view.zoom);
  const distance =
    (0.5 / Math.tan((viewport.fov / 2) * RAD)) *
    viewport.height *
    metresPerPixel;
  const back = distance * Math.sin(view.pitch * RAD);
  const heading = view.bearing * RAD;
  return {
    position: offset(
      view.center,
      -Math.sin(heading) * back,
      -Math.cos(heading) * back,
    ),
    altitude: viewport.centerElevation + distance * Math.cos(view.pitch * RAD),
    bearing: view.bearing,
    pitch: view.pitch,
  };
}

/** Cubic Hermite distance along a leg: s(0)=0, s(T)=D, s'(0)=v0, s'(T)=v1. */
export function hermiteDistance(
  x: number,
  distance: number,
  duration: number,
  v0: number,
  v1: number,
) {
  const m0 = v0 * duration;
  const m1 = v1 * duration;
  const x2 = x * x;
  const x3 = x2 * x;
  return (
    (x3 - 2 * x2 + x) * m0 + (-2 * x3 + 3 * x2) * distance + (x3 - x2) * m1
  );
}

export function hermiteSpeed(
  x: number,
  distance: number,
  duration: number,
  v0: number,
  v1: number,
) {
  const m0 = v0 * duration;
  const m1 = v1 * duration;
  const x2 = x * x;
  return (
    ((3 * x2 - 4 * x + 1) * m0 +
      (-6 * x2 + 6 * x) * distance +
      (3 * x2 - 2 * x) * m1) /
    duration
  );
}

interface PlannedLeg
  extends Required<Omit<FlightLeg, "turn" | "bank" | "phase">> {
  turn: number;
  bank: number;
  phase?: FlightPhase;
  startSpeed: number;
  startDistance: number;
  startTime: number;
  startHeading: number;
  startHeight: number;
  startPitch: number;
}

export interface FlightSample {
  position: [number, number];
  /** Planned height above ground before clearance is applied, metres. */
  height: number;
  bearing: number;
  pitch: number;
  roll: number;
  /** Distance flown, metres. */
  distance: number;
  speed: number;
  /** Seconds since take-off. */
  time: number;
  done: boolean;
}

export interface FlightPath {
  duration: number;
  length: number;
  legs: PlannedLeg[];
  sampleAt(time: number): FlightSample;
  /** Position at a distance along the path (clamped to its ends). */
  positionAt(distance: number): [number, number];
}

const STEP = 2; // metres between lookup-table points

/**
 * Plans a flight from a start pose. `startHeight` is the camera's height above
 * the ground below it at take-off; legs without endHeight hold it.
 */
export function planFlight(
  start: CameraPose,
  startHeight: number,
  legs: FlightLeg[],
): FlightPath {
  const planned: PlannedLeg[] = [];
  let distance = 0;
  let time = 0;
  let heading = start.bearing;
  let height = startHeight;
  let pitch = start.pitch;
  let speed = 0;
  for (const leg of legs) {
    const p: PlannedLeg = {
      distance: leg.distance,
      duration: leg.duration,
      endSpeed: leg.endSpeed,
      turn: leg.turn ?? 0,
      bank: leg.bank ?? 0,
      phase: leg.phase,
      endHeight: leg.endHeight ?? height,
      endPitch: leg.endPitch ?? pitch,
      startSpeed: speed,
      startDistance: distance,
      startTime: time,
      startHeading: heading,
      startHeight: height,
      startPitch: pitch,
    };
    planned.push(p);
    distance += p.distance;
    time += p.duration;
    heading += p.turn;
    height = p.endHeight;
    pitch = p.endPitch;
    speed = p.endSpeed;
  }
  const length = distance;
  const duration = time;

  const legAtDistance = (s: number) =>
    planned.find((l) => s <= l.startDistance + l.distance) ??
    planned[planned.length - 1];
  const headingAt = (s: number) => {
    const l = legAtDistance(s);
    return (
      l.startHeading + l.turn * smootherstep((s - l.startDistance) / l.distance)
    );
  };

  // Integrate the heading into positions (midpoint rule), in metres east/north.
  const count = Math.ceil(length / STEP) + 1;
  const east = new Float64Array(count);
  const north = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    const s0 = (i - 1) * STEP;
    const ds = Math.min(STEP, length - s0);
    const h = headingAt(s0 + ds / 2) * RAD;
    east[i] = east[i - 1] + Math.sin(h) * ds;
    north[i] = north[i - 1] + Math.cos(h) * ds;
  }
  const positionAt = (s: number): [number, number] => {
    const f = Math.min(Math.max(s, 0), length) / STEP;
    const i = Math.min(Math.floor(f), count - 2);
    const k = f - i;
    return offset(
      start.position,
      east[i] + (east[i + 1] - east[i]) * k,
      north[i] + (north[i + 1] - north[i]) * k,
    );
  };

  const sampleAt = (t: number): FlightSample => {
    const clamped = Math.min(Math.max(t, 0), duration);
    const leg =
      planned.find((l) => clamped <= l.startTime + l.duration) ??
      planned[planned.length - 1];
    const x = (clamped - leg.startTime) / leg.duration;
    const s =
      leg.startDistance +
      hermiteDistance(
        x,
        leg.distance,
        leg.duration,
        leg.startSpeed,
        leg.endSpeed,
      );
    const u = smootherstep((s - leg.startDistance) / leg.distance);
    const turnDirection = Math.sign(leg.turn);
    return {
      position: positionAt(s),
      height: leg.startHeight + (leg.endHeight - leg.startHeight) * u,
      bearing: headingAt(s),
      pitch: leg.startPitch + (leg.endPitch - leg.startPitch) * u,
      // Bank into the turn, easing in and out within the leg.
      roll:
        leg.bank *
        Math.sin(Math.PI * Math.min(Math.max(x, 0), 1)) *
        turnDirection,
      distance: s,
      speed: hermiteSpeed(
        x,
        leg.distance,
        leg.duration,
        leg.startSpeed,
        leg.endSpeed,
      ),
      time: clamped,
      done: t >= duration,
    };
  };

  return { duration, length, legs: planned, sampleAt, positionAt };
}

/**
 * Highest ground in the stretch just ahead of a distance, so the camera
 * climbs before a ridge rather than after it.
 */
export function groundAhead(
  path: FlightPath,
  distance: number,
  groundAt: (position: [number, number]) => number,
  lookAhead = 300,
  step = 30,
) {
  let max = -Infinity;
  for (let d = 0; d <= lookAhead; d += step)
    max = Math.max(max, groundAt(path.positionAt(distance + d)));
  return max;
}

/** Target altitude: planned height over the ground, never below the clearance over what's ahead. */
export function targetAltitude(
  groundBelow: number,
  groundAheadMax: number,
  height: number,
  minClearance: number,
) {
  return Math.max(groundBelow + height, groundAheadMax + minClearance);
}

/**
 * Critically damped smoothing of the altitude over time, so clearance
 * corrections never jerk the camera. `stiffness` is in 1/s.
 */
export function smoothAltitude(
  state: { value: number; velocity: number },
  target: number,
  dt: number,
  stiffness = 3,
) {
  const k = stiffness;
  const accel = k * k * (target - state.value) - 2 * k * state.velocity;
  state.velocity += accel * dt;
  state.value += state.velocity * dt;
  return state.value;
}

/**
 * Plans the camera altitude once, before take-off, as a smooth function of
 * distance flown. Reading the terrain every frame makes the camera twitch
 * (sharper terrain tiles arrive mid-flight and rough ground bumps the
 * height); a profile sampled up front and smoothed flies like a drone that
 * holds a steady line over the landscape.
 *
 * `ground` is called for positions along the whole path (rendered metres).
 */
export function planAltitude(
  path: FlightPath,
  ground: (position: [number, number]) => number,
  minClearance: number,
  { spacing = 40, lookAhead = 300, lookBehind = 150, smoothing = 250 } = {},
): (distance: number, height: number) => number {
  const n = Math.max(2, Math.ceil(path.length / spacing) + 1);
  const g = Float64Array.from({ length: n }, (_, i) =>
    ground(path.positionAt(Math.min(i * spacing, path.length))),
  );

  // Highest ground from a little behind to further ahead of each point.
  const ahead = Math.round(lookAhead / spacing);
  const behind = Math.round(lookBehind / spacing);
  const envelope = Float64Array.from({ length: n }, (_, i) => {
    let max = -Infinity;
    for (let j = Math.max(0, i - behind); j <= Math.min(n - 1, i + ahead); j++)
      max = Math.max(max, g[j]);
    return max;
  });

  // Moving-average passes (≈ a Gaussian) for both the terrain and the floor.
  const smooth = (src: Float64Array) => {
    const w = Math.max(1, Math.round(smoothing / spacing));
    let a = src;
    for (let pass = 0; pass < 3; pass++) {
      const b = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) {
          sum += a[j];
          count++;
        }
        b[i] = sum / count;
      }
      a = b;
    }
    return a;
  };
  const terrain = smooth(g);
  // Smoothing lowers peaks; lift the floor back so it never sits below them.
  const floorRaw = smooth(envelope);
  let lift = 0;
  for (let i = 0; i < n; i++) lift = Math.max(lift, envelope[i] - floorRaw[i]);
  const floor = floorRaw.map((v) => v + lift);

  // Catmull-Rom between samples: no corner at each sample point.
  const at = (arr: Float64Array, distance: number) => {
    const f = Math.min(Math.max(distance, 0), path.length) / spacing;
    const i = Math.min(Math.floor(f), n - 2);
    const t = f - i;
    const p0 = arr[Math.max(i - 1, 0)];
    const p1 = arr[i];
    const p2 = arr[i + 1];
    const p3 = arr[Math.min(i + 2, n - 1)];
    return (
      p1 +
      0.5 *
        t *
        (p2 -
          p0 +
          t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)))
    );
  };
  // Soft maximum: hands over between "follow the terrain" and "stay above
  // the floor" without a corner, and is never below either.
  const softMax = (a: number, b: number, k = 40) =>
    Math.max(a, b) + k * Math.log1p(Math.exp(-Math.abs(a - b) / k));
  return (distance, height) =>
    softMax(at(terrain, distance) + height, at(floor, distance) + minClearance);
}
