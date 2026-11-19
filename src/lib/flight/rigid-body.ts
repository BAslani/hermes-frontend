/**
 * Six-degree-of-freedom rigid body and the fixed-timestep loop that drives
 * it. Position and velocity are in the world frame (east, north, up); the
 * angular velocity is in the body frame (forward, left, up).
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import {
  add,
  cross,
  integrate,
  lerp3,
  nlerp,
  type Quat,
  scale,
  type Vec3,
} from "./vec.ts";

export interface RigidBody {
  position: Vec3;
  velocity: Vec3;
  /** Body to world. */
  orientation: Quat;
  /** rad/s about the body's forward, left and up axes. */
  omega: Vec3;
}

export interface MassProperties {
  /** kg. */
  mass: number;
  /** Principal moments about forward (roll), left (pitch) and up (yaw), kg·m². */
  inertia: Vec3;
}

export const cloneBody = (b: RigidBody): RigidBody => ({
  position: [...b.position],
  velocity: [...b.velocity],
  orientation: [...b.orientation],
  omega: [...b.omega],
});

/**
 * One semi-implicit Euler step: velocities first, then positions with the new
 * velocities. `force` is in the world frame, `torque` in the body frame.
 */
export function integrateBody(
  body: RigidBody,
  mass: MassProperties,
  force: Vec3,
  torque: Vec3,
  dt: number,
) {
  const [ix, iy, iz] = mass.inertia;
  const w = body.omega;
  // Euler's equations for principal axes: I ẇ = τ − ω × (I ω).
  const gyro = cross(w, [ix * w[0], iy * w[1], iz * w[2]]);
  body.omega = [
    w[0] + ((torque[0] - gyro[0]) / ix) * dt,
    w[1] + ((torque[1] - gyro[1]) / iy) * dt,
    w[2] + ((torque[2] - gyro[2]) / iz) * dt,
  ];
  body.velocity = add(body.velocity, scale(force, dt / mass.mass));
  body.position = add(body.position, scale(body.velocity, dt));
  body.orientation = integrate(body.orientation, body.omega, dt);
}

/** The pose between two physics steps, for rendering. */
export function interpolatePose(
  a: RigidBody,
  b: RigidBody,
  t: number,
): { position: Vec3; orientation: Quat } {
  return {
    position: lerp3(a.position, b.position, t),
    orientation: nlerp(a.orientation, b.orientation, t),
  };
}

/** Physics rate, Hz. */
export const STEP_HZ = 120;
export const STEP = 1 / STEP_HZ;

/**
 * Runs `step` at a fixed rate whatever the frame rate. Returns how far the
 * current frame sits between the last two steps (0–1), for interpolation.
 */
export class FixedStep {
  private accumulator = 0;
  private readonly dt: number;
  /** Never try to catch up more than this many steps in one frame. */
  private readonly maxSteps: number;

  // Plain fields, not parameter properties: Node's type stripping needs erasable syntax.
  constructor(dt = STEP, maxSteps = 12) {
    this.dt = dt;
    this.maxSteps = maxSteps;
  }

  advance(frameSeconds: number, step: (dt: number) => void): number {
    this.accumulator += Math.max(0, frameSeconds);
    let steps = 0;
    while (this.accumulator >= this.dt && steps < this.maxSteps) {
      step(this.dt);
      this.accumulator -= this.dt;
      steps++;
    }
    // A long stall (tab in the background): drop the backlog instead of spiralling.
    if (this.accumulator >= this.dt) this.accumulator = 0;
    return this.accumulator / this.dt;
  }

  reset() {
    this.accumulator = 0;
  }
}
