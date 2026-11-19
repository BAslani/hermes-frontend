/**
 * Free-flight drone model for the playground: pure functions, no DOM or
 * MapLibre, unit-tested in drone-controls.test.mts.
 *
 * Inputs set a target velocity; the drone eases towards it (inertia), so it
 * glides to a stop instead of halting dead. Speeds scale with height above
 * the ground: careful near the surface, fast up high — which also keeps the
 * camera from outrunning the imagery tiles. Heights are metres in rendered
 * (exaggerated) terrain space, like everything MapLibre reports.
 *
 * Keep this file import-free (types only): Node runs the tests on it directly.
 */

export interface DroneState {
  position: [number, number];
  /** Camera metres above sea level, rendered terrain space. */
  altitude: number;
  /** Degrees, 0 = north. */
  heading: number;
  /** Camera pitch as MapLibre uses it: 0 = straight down, 90 = horizon. */
  pitch: number;
  /** Cosmetic bank, degrees. */
  roll: number;
  /** Metres per second: east, north, up. */
  velocity: [number, number, number];
  /** Ground under the drone, eased so sharper DEM tiles don't jolt it. */
  ground: number;
}

export interface DroneInput {
  /** -1…1: back/forward, left/right, down/up. */
  forward: number;
  strafe: number;
  lift: number;
  /** -1…1 from keys (arrows); mouse look is applied directly with look(). */
  turn: number;
  tilt: number;
  boost: boolean;
  precise: boolean;
}

export const NO_INPUT: DroneInput = {
  forward: 0,
  strafe: 0,
  lift: 0,
  turn: 0,
  tilt: 0,
  boost: false,
  precise: false,
};

export const DRONE = {
  /** Lowest the camera may get above the ground. */
  minClearance: 25,
  maxAltitude: 15_000,
  minPitch: 10,
  maxPitch: 100,
  /** Horizontal speed = clamp(height above ground × this, min, max) m/s. */
  speedPerMetre: 0.35,
  minSpeed: 12,
  maxSpeed: 600,
  boost: 3,
  precise: 0.25,
  /** How fast velocity catches up with the target (1/s); higher = snappier. */
  response: 2.2,
  /** Keyboard turn and tilt rates, degrees per second. */
  turnRate: 70,
  tiltRate: 45,
  /** Degrees of bank per (degree per second) of turning, and its limit. */
  bankPerTurn: 0.12,
  maxBank: 18,
  /** Near the edge of the map, speed towards it may not exceed distance left × this (1/s). */
  edgeBrake: 0.8,
  /** Fastest the drone is carried back when it is past the edge, m/s. */
  edgeReturn: 60,
} as const;

const EARTH_RADIUS = 6371008.8;
const RAD = Math.PI / 180;
const clamp = (x: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, x));
/** Fraction of the way to a target after dt, for an exponential ease at `rate` per second. */
const ease = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

export function createDrone(pose: {
  position: [number, number];
  altitude: number;
  heading: number;
  pitch: number;
  ground: number;
}): DroneState {
  return { ...pose, roll: 0, velocity: [0, 0, 0] };
}

/** Speed for the current height above the ground, before boost/precision. */
export function cruiseSpeed(heightAboveGround: number) {
  return clamp(
    heightAboveGround * DRONE.speedPerMetre,
    DRONE.minSpeed,
    DRONE.maxSpeed,
  );
}

/** Mouse look: degrees to add to heading and pitch (pitch up to `maxPitch`). */
export function look(
  state: DroneState,
  dHeading: number,
  dPitch: number,
  maxPitch: number = DRONE.maxPitch,
): DroneState {
  return {
    ...state,
    heading: (((state.heading + dHeading) % 360) + 360) % 360,
    pitch: clamp(state.pitch + dPitch, DRONE.minPitch, maxPitch),
  };
}

export interface StepOptions {
  /** Ground elevation under the drone right now (rendered space). */
  groundBelow: number;
  /** [west, south, east, north] the drone must stay inside. */
  bounds?: [number, number, number, number];
  /**
   * The edge of the flyable area: metres left before it (negative once past
   * it) and the unit [east, north] direction that leads out. The drone slows
   * as it nears the edge and settles there, free to fly along it or away.
   */
  edge?: { remaining: number; outward: [number, number] };
  /** Skip the cosmetic bank (reduced motion). */
  noRoll?: boolean;
  /** Cruise speed limit, m/s, before boost or precision (default: DRONE.maxSpeed). */
  maxSpeed?: number;
  /** Highest camera pitch (default: DRONE.maxPitch). */
  maxPitch?: number;
}

/** Advance the drone by dt seconds. */
export function step(
  state: DroneState,
  input: DroneInput,
  dt: number,
  opts: StepOptions,
): DroneState {
  if (dt <= 0) return state;
  const {
    groundBelow,
    bounds,
    edge,
    noRoll,
    maxSpeed = DRONE.maxSpeed,
    maxPitch = DRONE.maxPitch,
  } = opts;

  // Ease the ground reading, but never let it lag below real rising ground.
  let ground = state.ground + (groundBelow - state.ground) * ease(4, dt);
  if (groundBelow > ground) ground = Math.max(ground, groundBelow - 5);

  const height = Math.max(0, state.altitude - ground);
  const multiplier = input.boost
    ? DRONE.boost
    : input.precise
      ? DRONE.precise
      : 1;
  const speed = Math.min(cruiseSpeed(height), maxSpeed) * multiplier;
  const climb = Math.max(8, speed * 0.6);

  const turnDelta =
    input.turn * DRONE.turnRate * (input.precise ? 0.4 : 1) * dt;
  const heading = (((state.heading + turnDelta) % 360) + 360) % 360;
  const pitch = clamp(
    state.pitch + input.tilt * DRONE.tiltRate * dt,
    DRONE.minPitch,
    maxPitch,
  );

  // Target velocity in east/north/up from the heading (flat: W flies level).
  const h = heading * RAD;
  const fwd = clamp(input.forward, -1, 1);
  const side = clamp(input.strafe, -1, 1);
  const len = Math.hypot(fwd, side) || 1;
  const nf = (fwd / Math.max(1, len)) * speed;
  const ns = (side / Math.max(1, len)) * speed;
  const target: [number, number, number] = [
    Math.sin(h) * nf + Math.cos(h) * ns,
    Math.cos(h) * nf - Math.sin(h) * ns,
    clamp(input.lift, -1, 1) * climb,
  ];
  if (edge) {
    // Steering out past what the edge allows scales the whole target down, so
    // the drone stops at the edge instead of sliding along it at full speed.
    const out = target[0] * edge.outward[0] + target[1] * edge.outward[1];
    const cap = Math.max(edge.remaining * DRONE.edgeBrake, 0);
    if (out > cap) {
      target[0] *= cap / out;
      target[1] *= cap / out;
    }
  }
  const k = ease(DRONE.response, dt);
  const velocity: [number, number, number] = [
    state.velocity[0] + (target[0] - state.velocity[0]) * k,
    state.velocity[1] + (target[1] - state.velocity[1]) * k,
    state.velocity[2] + (target[2] - state.velocity[2]) * k,
  ];

  if (edge) {
    // Backstop for the inertia: cap the part of the velocity that heads out.
    // The cap shrinks with the distance left, so there is never a wall to hit,
    // and past the edge it turns negative and carries the drone back.
    const out = velocity[0] * edge.outward[0] + velocity[1] * edge.outward[1];
    const cap = Math.max(edge.remaining * DRONE.edgeBrake, -DRONE.edgeReturn);
    if (out > cap) {
      velocity[0] -= (out - cap) * edge.outward[0];
      velocity[1] -= (out - cap) * edge.outward[1];
    }
  }

  const [lng, lat] = state.position;
  let position: [number, number] = [
    lng + (velocity[0] * dt) / (EARTH_RADIUS * Math.cos(lat * RAD) * RAD),
    clamp(lat + (velocity[1] * dt) / (EARTH_RADIUS * RAD), -85, 85),
  ];
  if (bounds) {
    const [w, s, e, n] = bounds;
    const clamped: [number, number] = [
      clamp(position[0], w, e),
      clamp(position[1], s, n),
    ];
    if (clamped[0] !== position[0]) velocity[0] = 0;
    if (clamped[1] !== position[1]) velocity[1] = 0;
    position = clamped;
  }

  let altitude = state.altitude + velocity[2] * dt;
  const floor = ground + DRONE.minClearance;
  if (altitude < floor) {
    // Pushed up smoothly, but never below a hard minimum just over the real ground.
    altitude = Math.max(
      altitude + (floor - altitude) * ease(8, dt),
      groundBelow + DRONE.minClearance * 0.4,
    );
    if (velocity[2] < 0) velocity[2] = 0;
  }
  if (altitude > DRONE.maxAltitude) {
    altitude = DRONE.maxAltitude;
    if (velocity[2] > 0) velocity[2] = 0;
  }

  // Bank into turns and sideways drift (lateral velocity relative to heading).
  const lateral = velocity[0] * Math.cos(h) - velocity[1] * Math.sin(h);
  const turnRate = dt > 0 ? turnDelta / dt : 0;
  const bankTarget = noRoll
    ? 0
    : clamp(
        turnRate * DRONE.bankPerTurn + (lateral / Math.max(speed, 1)) * 10,
        -DRONE.maxBank,
        DRONE.maxBank,
      );
  const roll = state.roll + (bankTarget - state.roll) * ease(4, dt);

  return { position, altitude, heading, pitch, roll, velocity, ground };
}

/** Horizontal ground speed, m/s. */
export const groundSpeed = (state: DroneState) =>
  Math.hypot(state.velocity[0], state.velocity[1]);
