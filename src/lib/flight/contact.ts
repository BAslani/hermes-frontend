/**
 * Ground contact: wheels and skids as spring-damper points with friction,
 * plus "structure" points (propeller, wing tips, belly) that must never touch.
 *
 * The ground is taken as locally level under each point: the normal force is
 * straight up and friction acts in the horizontal plane. Friction is
 * regularised with tanh so a parked aircraft settles instead of chattering.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import type { RigidBody } from "./rigid-body.ts";
import { add, cross, rotate, unrotate, type Vec3 } from "./vec.ts";

export interface ContactPoint {
  name: string;
  /** Unloaded position in the body frame (forward, left, up), metres. */
  position: Vec3;
  kind: "wheel" | "skid" | "structure";
  /** N/m and N·s/m. */
  stiffness: number;
  damping: number;
  /** Wheels: turns with the steering input. */
  steered?: boolean;
  /** Wheels: has a brake. */
  braked?: boolean;
  /** Friction along the rolling direction (wheels) or in every direction (skids, structure). */
  friction: number;
  /** Wheels: friction across the rolling direction. */
  sideFriction?: number;
  /** Wheels: extra friction along the rolling direction at full brake. */
  brakeFriction?: number;
}

export interface ContactInput {
  /** Steering angle of steered wheels, radians, positive = left. */
  steer: number;
  /** 0–1. */
  brake: number;
}

export interface ContactResult {
  /** World frame, N. */
  force: Vec3;
  /** Body frame, N·m. */
  torque: Vec3;
  /** Normal load on each point, N (0 when off the ground), in point order. */
  loads: number[];
  /** Fastest downward speed among points that touch the ground this step, m/s. */
  sinkRate: number;
}

export type GroundFn = (east: number, north: number) => number;

/** Speeds below which friction fades out, m/s. */
const ROLL_SLIP = 0.25;
const SIDE_SLIP = 0.5;

export function contactForces(
  body: RigidBody,
  points: ContactPoint[],
  ground: GroundFn,
  input: ContactInput,
): ContactResult {
  let force: Vec3 = [0, 0, 0];
  let torqueWorld: Vec3 = [0, 0, 0];
  const loads: number[] = [];
  let sinkRate = 0;
  const omegaWorld = rotate(body.orientation, body.omega);
  const forward = rotate(body.orientation, [1, 0, 0]);

  for (const point of points) {
    const arm = rotate(body.orientation, point.position);
    const at = add(body.position, arm);
    const depth = ground(at[0], at[1]) - at[2];
    if (depth <= 0) {
      loads.push(0);
      continue;
    }
    const velocity = add(body.velocity, cross(omegaWorld, arm));
    // The spring pushes, the damper may only reduce the push: the ground never pulls.
    const normal = Math.max(
      0,
      point.stiffness * depth - point.damping * velocity[2],
    );
    loads.push(normal);
    sinkRate = Math.max(sinkRate, -velocity[2]);

    let fx: number;
    let fy: number;
    if (point.kind === "wheel") {
      // Rolling direction: the nose, flattened onto the ground, turned by the steering.
      let dx = forward[0];
      let dy = forward[1];
      const flat = Math.hypot(dx, dy) || 1;
      dx /= flat;
      dy /= flat;
      if (point.steered && input.steer !== 0) {
        const c = Math.cos(input.steer);
        const s = Math.sin(input.steer);
        [dx, dy] = [dx * c - dy * s, dx * s + dy * c];
      }
      const along = velocity[0] * dx + velocity[1] * dy;
      const across = -velocity[0] * dy + velocity[1] * dx;
      const rolling =
        point.friction +
        (point.braked ? input.brake * (point.brakeFriction ?? 0) : 0);
      const fAlong = -normal * rolling * Math.tanh(along / ROLL_SLIP);
      const fAcross =
        -normal *
        (point.sideFriction ?? point.friction) *
        Math.tanh(across / SIDE_SLIP);
      fx = fAlong * dx - fAcross * dy;
      fy = fAlong * dy + fAcross * dx;
    } else {
      const speed = Math.hypot(velocity[0], velocity[1]);
      const grip =
        speed > 0
          ? (-normal * point.friction * Math.tanh(speed / SIDE_SLIP)) / speed
          : 0;
      fx = velocity[0] * grip;
      fy = velocity[1] * grip;
    }

    const f: Vec3 = [fx, fy, normal];
    force = add(force, f);
    torqueWorld = add(torqueWorld, cross(arm, f));
  }

  return {
    force,
    torque: unrotate(body.orientation, torqueWorld),
    loads,
    sinkRate,
  };
}
