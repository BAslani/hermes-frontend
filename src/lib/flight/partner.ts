import type { GroundFn } from "./contact.ts";
import { fromAttitude, type Quat, type Vec3 } from "./vec.ts";

// Only imports sibling modules by relative path with their .ts extension, so
// Node runs the tests on it directly.

/**
 * The other aircraft in a co-op strike, in the game's frame (metres from the
 * site). For now a stand-in flies it; online play will feed the same shape
 * from the other player's reports.
 */
export interface PartnerState {
  role: "drone" | "jet";
  position: Vec3;
  velocity: Vec3;
  /** Body to world (forward, left, up). */
  orientation: Quat;
}

export interface Partner {
  step(dt: number): void;
  state(): PartnerState;
}

const G = 9.81;
const DEG = 180 / Math.PI;

/**
 * A stand-in F-14: circles the site anticlockwise in a steady banked turn,
 * high enough to clear the ground all the way round. It never fires.
 */
export function standInJet(
  site: Vec3,
  ground: GroundFn,
  { radius = 3500, speed = 170, clearance = 400 } = {},
): Partner {
  let highest = -Infinity;
  for (let a = 0; a < 360; a += 10) {
    const r = a / DEG;
    highest = Math.max(
      highest,
      ground(site[0] + Math.sin(r) * radius, site[1] + Math.cos(r) * radius),
    );
  }
  const altitude = Math.max(highest, site[2]) + clearance;
  // The bank of a level turn at this speed and radius, rolled left (anticlockwise).
  const roll = -Math.atan((speed * speed) / (radius * G)) * DEG;
  // Angle round the circle from north, decreasing (anticlockwise seen from above).
  let angle = 0;
  return {
    step(dt) {
      angle -= (speed / radius) * dt;
    },
    state() {
      const position: Vec3 = [
        site[0] + Math.sin(angle) * radius,
        site[1] + Math.cos(angle) * radius,
        altitude,
      ];
      const velocity: Vec3 = [
        -Math.cos(angle) * speed,
        Math.sin(angle) * speed,
        0,
      ];
      const heading = Math.atan2(velocity[0], velocity[1]) * DEG;
      return {
        role: "jet",
        position,
        velocity,
        orientation: fromAttitude({ heading, pitch: 2, roll }),
      };
    },
  };
}

/** A stand-in interceptor drone: hovers at `position`, turning slowly as if watching for drones. */
export function standInDrone(position: Vec3, heading = 0): Partner {
  let time = 0;
  return {
    step(dt) {
      time += dt;
    },
    state() {
      return {
        role: "drone",
        position: [
          position[0],
          position[1],
          position[2] + Math.sin(time) * 0.6,
        ],
        velocity: [0, 0, 0],
        orientation: fromAttitude({
          heading: heading + time * 8,
          pitch: 0,
          roll: 0,
        }),
      };
    },
  };
}
