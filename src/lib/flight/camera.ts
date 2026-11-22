/**
 * Cameras around an aircraft, and the conversion between a camera described
 * by where it looks (forward and up vectors, east-north-up) and the bearing,
 * pitch and roll MapLibre takes.
 *
 * `eyeMatrix` reproduces MapLibre's own view rotation (mercator transform,
 * `_calcMatrices`): scale(1, −1, 1) · rotateZ(−roll) · rotateX(pitch) ·
 * rotateZ(−bearing), applied to a world of east, SOUTH, up. Rendering the
 * aircraft with exactly this rotation keeps it glued to the map behind it.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import {
  add,
  clamp,
  cross,
  DEG,
  dot,
  nlerp,
  normalize,
  type Quat,
  RAD,
  rotate,
  scale,
  sub,
  type Vec3,
} from "./vec.ts";

export interface MapAngles {
  /** Degrees clockwise from north. */
  bearing: number;
  /** Degrees: 0 looks straight down, 90 at the horizon, 180 straight up. */
  pitch: number;
  /** Degrees, positive = banked right (horizon tilts anticlockwise). */
  roll: number;
}

/** Row-major 3×3. */
export type Mat3 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/**
 * Rotation from east-north-up to eye space (x right, y up, z towards the
 * viewer), exactly as MapLibre builds it.
 */
export function eyeMatrix({ bearing, pitch, roll }: MapAngles): Mat3 {
  const cb = Math.cos(bearing * RAD);
  const sb = Math.sin(bearing * RAD);
  const cp = Math.cos(pitch * RAD);
  const sp = Math.sin(pitch * RAD);
  const cr = Math.cos(roll * RAD);
  const sr = Math.sin(roll * RAD);
  // Unrolled camera: right, up and back axes in east-north-up.
  const right: Vec3 = [cb, -sb, 0];
  const up: Vec3 = [sb * cp, cb * cp, sp];
  const back: Vec3 = [-sb * sp, -cb * sp, cp];
  // Roll turns right and up about the view axis.
  return [
    cr * right[0] - sr * up[0],
    cr * right[1] - sr * up[1],
    cr * right[2] - sr * up[2],
    sr * right[0] + cr * up[0],
    sr * right[1] + cr * up[1],
    sr * right[2] + cr * up[2],
    back[0],
    back[1],
    back[2],
  ];
}

export const applyMat3 = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

/** MapLibre angles for a camera looking along `forward` with `up` roughly overhead (east-north-up). */
export function mapAngles(forward: Vec3, up: Vec3): MapAngles {
  const f = normalize(forward);
  const pitch = Math.acos(clamp(-f[2], -1, 1)) * DEG;
  // Looking straight up or down the bearing comes from the up vector instead.
  const flat = Math.hypot(f[0], f[1]);
  const bearing =
    flat > 1e-4
      ? Math.atan2(f[0], f[1]) * DEG
      : Math.atan2(
          up[0] * Math.sign(-f[2] || 1),
          up[1] * Math.sign(-f[2] || 1),
        ) * DEG;
  const level = eyeMatrix({ bearing, pitch, roll: 0 });
  const right0: Vec3 = [level[0], level[1], level[2]];
  const up0: Vec3 = [level[3], level[4], level[5]];
  const roll = Math.atan2(dot(up, right0), dot(up, up0)) * DEG;
  return { bearing: (bearing + 360) % 360, pitch, roll };
}

export interface CameraPose {
  /** East-north-up, same frame as the aircraft. */
  position: Vec3;
  forward: Vec3;
  up: Vec3;
}

export type CameraMode = "chase" | "cockpit" | "orbit";
export const CAMERA_MODES: CameraMode[] = ["chase", "cockpit", "orbit"];

export interface ChaseState {
  /** Smoothed point the camera sits at. */
  position: Vec3;
  ready: boolean;
}

export const CHASE = {
  /** Behind and above the aircraft, metres. */
  back: 14,
  up: 3.6,
  /** Looks at a point this far ahead of the aircraft. */
  lead: 12,
  /** How quickly the camera catches up (1/s). */
  stiffness: 5,
  /** Never closer to the ground than this, metres. */
  clearance: 1.2,
} as const;

/**
 * Chase camera: follows behind and above along the aircraft's heading (not
 * its pitch or roll, so the horizon stays level), with a spring lag.
 */
export function chaseCamera(
  state: ChaseState,
  aircraft: Vec3,
  orientation: Quat,
  dt: number,
  groundAt: (east: number, north: number) => number,
): CameraPose {
  const nose = rotate(orientation, [1, 0, 0]);
  const flat = Math.hypot(nose[0], nose[1]);
  // Nose straight up or down: keep following from where the camera already is.
  const ahead: Vec3 =
    flat > 0.05
      ? [nose[0] / flat, nose[1] / flat, 0]
      : normalize([
          aircraft[0] - state.position[0],
          aircraft[1] - state.position[1],
          0,
        ]);
  const target = add(aircraft, [
    -ahead[0] * CHASE.back,
    -ahead[1] * CHASE.back,
    CHASE.up,
  ]);
  if (!state.ready) {
    state.position = target;
    state.ready = true;
  } else {
    const k = 1 - Math.exp(-CHASE.stiffness * dt);
    state.position = add(state.position, scale(sub(target, state.position), k));
  }
  const floor =
    groundAt(state.position[0], state.position[1]) + CHASE.clearance;
  if (state.position[2] < floor)
    state.position = [state.position[0], state.position[1], floor];
  const lookAt = add(aircraft, scale(ahead, CHASE.lead));
  return {
    position: state.position,
    forward: normalize(sub(lookAt, state.position)),
    up: [0, 0, 1],
  };
}

/** The arcade camera's own attitude, trailing the aircraft's. */
export interface ArcadeCameraState {
  orientation: Quat | null;
}

/** Where the arcade camera sits, body frame of its trailing attitude, metres. */
export interface ArcadeCameraRig {
  back: number;
  up: number;
  /** Looks at a point this far ahead of the aircraft. */
  lead: number;
}

/** How quickly the arcade camera catches up with the aircraft's attitude (1/s). */
export const ARCADE_CAMERA_FOLLOW = 5;

/**
 * Arcade chase camera, as in action flight games: behind the tail and a
 * little above, turning with the aircraft (roll and pitch included, so the
 * horizon tilts in a bank) but a moment behind it, so a hard pull or roll
 * swings the aircraft off centre before the view catches up. The camera's
 * position hangs off the aircraft through that trailing attitude, so at any
 * speed it stays the same distance behind.
 */
export function arcadeCamera(
  state: ArcadeCameraState,
  aircraft: Vec3,
  orientation: Quat,
  dt: number,
  rig: ArcadeCameraRig,
  groundAt: (east: number, north: number) => number,
): CameraPose {
  const q =
    state.orientation === null
      ? orientation
      : nlerp(
          state.orientation,
          orientation,
          1 - Math.exp(-ARCADE_CAMERA_FOLLOW * dt),
        );
  state.orientation = q;
  let position = add(aircraft, rotate(q, [-rig.back, 0, rig.up]));
  const floor = groundAt(position[0], position[1]) + CHASE.clearance;
  if (position[2] < floor) position = [position[0], position[1], floor];
  const lookAt = add(aircraft, rotate(q, [rig.lead, 0, 0]));
  return {
    position,
    forward: normalize(sub(lookAt, position)),
    up: rotate(q, [0, 0, 1]),
  };
}

/** Pilot's eye in the body frame (forward, left, up), metres. */
export const EYE: Vec3 = [0.35, 0.28, 0.62];

/** Cockpit camera: at the pilot's eye, moving with the full attitude, roll included. */
export function cockpitCamera(
  aircraft: Vec3,
  orientation: Quat,
  eye: Vec3 = EYE,
): CameraPose {
  return {
    position: add(aircraft, rotate(orientation, eye)),
    forward: rotate(orientation, [1, 0, 0]),
    up: rotate(orientation, [0, 0, 1]),
  };
}

export interface OrbitState {
  /** Degrees: where the camera sits around the aircraft (0 = north of it) and above the horizon. */
  azimuth: number;
  elevation: number;
  distance: number;
}

export const newOrbit = (): OrbitState => ({
  azimuth: 200,
  elevation: 12,
  distance: 22,
});

/** Right-mouse drag by (dx, dy) pixels. */
export function dragOrbit(state: OrbitState, dx: number, dy: number) {
  state.azimuth = (state.azimuth - dx * 0.3 + 360) % 360;
  state.elevation = clamp(state.elevation + dy * 0.2, -20, 80);
}

/** Free orbit: looks at the aircraft from a point on a sphere around it. */
export function orbitCamera(
  state: OrbitState,
  aircraft: Vec3,
  groundAt: (east: number, north: number) => number,
): CameraPose {
  const az = state.azimuth * RAD;
  const el = state.elevation * RAD;
  const position = add(aircraft, [
    Math.sin(az) * Math.cos(el) * state.distance,
    Math.cos(az) * Math.cos(el) * state.distance,
    Math.sin(el) * state.distance,
  ]);
  position[2] = Math.max(
    position[2],
    groundAt(position[0], position[1]) + CHASE.clearance,
  );
  return {
    position,
    forward: normalize(sub(aircraft, position)),
    up: [0, 0, 1],
  };
}

/** Right vector of a camera pose, for callers that need the full basis. */
export const cameraRight = (pose: CameraPose): Vec3 =>
  normalize(cross(pose.forward, pose.up));
