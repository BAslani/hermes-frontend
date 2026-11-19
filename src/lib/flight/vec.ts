/**
 * Small vector and quaternion maths for the flight models. Vectors are
 * [x, y, z] tuples and quaternions [x, y, z, w]; every function returns a new
 * value.
 *
 * Frames used throughout src/lib/flight:
 * - World: east, north, up (ENU), metres.
 * - Body: forward, left, up (FLU), origin at the centre of gravity.
 * A body-to-world quaternion of identity therefore means "nose east, level".
 *
 * Keep this file import-free: Node runs the tests on it directly.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export const RAD = Math.PI / 180;
export const DEG = 180 / Math.PI;

export const clamp = (x: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const add = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
export const sub = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
export const scale = (a: Vec3, s: number): Vec3 => [
  a[0] * s,
  a[1] * s,
  a[2] * s,
];
export const dot = (a: Vec3, b: Vec3) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

export const IDENTITY: Quat = [0, 0, 0, 1];

/** Hamilton product: the rotation b followed by the rotation a. */
export const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
export const qnormalize = (q: Quat): Quat => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};
export const qaxis = (axis: Vec3, angle: number): Quat => {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};

/** Rotate a vector by a quaternion (body to world for a body-to-world quaternion). */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // With t = 2 (q × v), the rotated vector is v + w t + (q × t).
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}
/** The inverse rotation (world to body). */
export const unrotate = (q: Quat, v: Vec3): Vec3 => rotate(qconj(q), v);

/** Advance an orientation by a body-frame angular velocity (rad/s) over dt. */
export function integrate(q: Quat, omega: Vec3, dt: number): Quat {
  const d = qmul(q, [omega[0], omega[1], omega[2], 0]);
  return qnormalize([
    q[0] + 0.5 * d[0] * dt,
    q[1] + 0.5 * d[1] * dt,
    q[2] + 0.5 * d[2] * dt,
    q[3] + 0.5 * d[3] * dt,
  ]);
}

/** Normalised linear interpolation along the shorter arc; fine between physics steps. */
export function nlerp(a: Quat, b: Quat, t: number): Quat {
  const s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  return qnormalize([
    lerp(a[0], s * b[0], t),
    lerp(a[1], s * b[1], t),
    lerp(a[2], s * b[2], t),
    lerp(a[3], s * b[3], t),
  ]);
}

export interface Attitude {
  /** Degrees, 0 = north, clockwise. */
  heading: number;
  /** Degrees, nose up positive. */
  pitch: number;
  /** Degrees, right wing down positive. */
  roll: number;
}

/** Body-to-world quaternion for an aircraft attitude. */
export function fromAttitude({ heading, pitch, roll }: Attitude): Quat {
  // FLU body in an ENU world: yaw about up (heading 0 is +90° from east),
  // pitch up is a negative turn about the left axis, right roll a positive
  // turn about the forward axis.
  const yaw = qaxis([0, 0, 1], (90 - heading) * RAD);
  const up = qaxis([0, 1, 0], -pitch * RAD);
  const bank = qaxis([1, 0, 0], roll * RAD);
  return qmul(yaw, qmul(up, bank));
}

export function toAttitude(q: Quat): Attitude {
  const forward = rotate(q, [1, 0, 0]);
  const left = rotate(q, [0, 1, 0]);
  const up = rotate(q, [0, 0, 1]);
  const heading = (Math.atan2(forward[0], forward[1]) * DEG + 360) % 360;
  const pitch = Math.asin(clamp(forward[2], -1, 1)) * DEG;
  // Right roll lifts the left wing: its tip rises above the horizon.
  const roll = Math.atan2(left[2], up[2]) * DEG;
  return { heading, pitch, roll };
}
