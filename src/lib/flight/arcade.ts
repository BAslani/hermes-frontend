/**
 * Arcade flight: the action-game way of flying, for the playground's arcade
 * mode. The aircraft goes where its nose points, and it follows a pointer
 * the player moves: it eases into a bank towards it and pulls round onto it,
 * smoothly rather than snappily. Speed is held for you at a
 * cruise: hold boost to go fast, the air brake to slow, and both together for
 * a high-G turn that trades speed for a tighter circle. Climbing bleeds speed,
 * diving builds it, and too slow it stalls and the nose drops. No wind, no
 * landing gear in the air; touching the ground with the airframe is a crash.
 *
 * It steps the same Airplane state as the realistic model, so the cameras,
 * drawing and instruments carry on unchanged.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import type { Airplane } from "./airplane.ts";
import { contactForces, type GroundFn } from "./contact.ts";
import {
  clamp,
  cross,
  DEG,
  fromAttitude,
  integrate,
  normalize,
  RAD,
  rotate,
  scale,
  toAttitude,
  unrotate,
  type Vec3,
} from "./vec.ts";

const G = 9.81;

/** How each aircraft handles in arcade mode. Speeds m/s, rates rad/s. */
export interface ArcadeHandling {
  /** Held with neither boost nor brake. */
  cruise: number;
  /** Boost holds this. */
  max: number;
  /** The air brake slows to this. */
  min: number;
  /** Below this the wings let go and the nose drops. */
  stall: number;
  pitchRate: number;
  rollRate: number;
  yawRate: number;
  /** Pitch rate multiplier in a high-G turn (boost and brake held together). */
  highG: number;
  /** Speed change towards the target, m/s²: boosting, braking, and settling back to cruise from below and above. */
  boostAccel: number;
  brakeDecel: number;
  settleUp: number;
  settleDown: number;
}

export const ARCADE_HANDLING: Record<Airplane["frame"]["id"], ArcadeHandling> =
  {
    jet: {
      cruise: 190,
      max: 330,
      min: 85,
      stall: 65,
      pitchRate: 38 * RAD,
      rollRate: 230 * RAD,
      yawRate: 22 * RAD,
      highG: 1.6,
      boostAccel: 35,
      brakeDecel: 60,
      settleUp: 4,
      settleDown: 18,
    },
    racer: {
      cruise: 95,
      max: 145,
      min: 45,
      stall: 35,
      pitchRate: 60 * RAD,
      rollRate: 290 * RAD,
      yawRate: 30 * RAD,
      highG: 1.6,
      boostAccel: 22,
      brakeDecel: 35,
      settleUp: 4,
      settleDown: 12,
    },
    trainer: {
      cruise: 75,
      max: 115,
      min: 38,
      stall: 30,
      pitchRate: 45 * RAD,
      rollRate: 160 * RAD,
      yawRate: 22 * RAD,
      highG: 1.5,
      boostAccel: 15,
      brakeDecel: 28,
      settleUp: 3,
      settleDown: 10,
    },
  };

/** The whole game runs this much faster than real time in arcade mode. */
export const ARCADE_TIME_SCALE = 1.2;

export interface ArcadeInput {
  /**
   * The pointer: a world direction (unit, east-north-up) the aircraft eases
   * round to fly along. The stick values below add on top of it (or fly the
   * aircraft alone without one).
   */
  aim?: Vec3;
  /** −1…1, positive = nose up. */
  pitch: number;
  /** −1…1, positive = roll right. */
  roll: number;
  /** −1…1, positive = nose right. */
  yaw: number;
  boost: boolean;
  brake: boolean;
}

/**
 * Following the pointer: below `levelBelow` off the nose it is flown wings
 * level; from `bankFrom` on, banked towards. The `*Full` angles are the
 * errors that call for full stick; they are wide, so the aircraft eases onto
 * the pointer instead of snapping to it.
 */
const AIM = {
  levelBelow: 4 * RAD,
  bankFrom: 20 * RAD,
  rollFull: 80 * RAD,
  pitchFull: 22 * RAD,
  yawFull: 10 * RAD,
  /** The most of the roll rate it uses: banks ease in rather than flick. */
  roll: 0.5,
  /** Steepest bank for a pointer within `wideFrom` of the nose. */
  maxBank: 70 * RAD,
  wideFrom: 60 * RAD,
  /** Pushing the nose down is gentler than pulling. */
  push: 0.4,
} as const;

/** The stick that flies the nose onto the pointer, as a calm pilot would. */
export function followAim(
  orientation: Airplane["body"]["orientation"],
  aim: Vec3,
): { pitch: number; roll: number; yaw: number } {
  const t = unrotate(orientation, normalize(aim));
  const off = Math.acos(clamp(t[0], -1, 1));
  // The bank that puts the pointer straight above the canopy (right positive).
  const towards = Math.atan2(-t[1], t[2]);
  const { roll } = toAttitude(orientation);
  const k = clamp(
    (off - AIM.levelBelow) / (AIM.bankFrom - AIM.levelBelow),
    0,
    1,
  );
  const bank = k * k * (3 - 2 * k);
  // A pointer near the nose is a turn, not a knife-edge: the bank stops at
  // AIM.maxBank, and a pull plus a little rudder finish the job. Only one far
  // off (behind, or straight above) rolls all the way over to it.
  let wantedBank = roll * RAD + towards;
  wantedBank = Math.atan2(Math.sin(wantedBank), Math.cos(wantedBank));
  if (off < AIM.wideFrom)
    wantedBank = clamp(wantedBank, -AIM.maxBank, AIM.maxBank);
  const rollError =
    bank * (wantedBank - roll * RAD) + (1 - bank) * (-roll * RAD);
  return {
    roll: clamp(rollError / AIM.rollFull, -AIM.roll, AIM.roll),
    pitch: clamp(Math.atan2(t[2], t[0]) / AIM.pitchFull, -AIM.push, 1),
    yaw: clamp(Math.atan2(-t[1], t[0]) / AIM.yawFull, -1, 1),
  };
}

/**
 * Seconds for the turn rates to follow the controls: long enough that
 * every turn and roll eases in and out.
 */
const RATE_LAG = 0.4;
/** Share of gravity along the flight path that changes the speed. */
const ENERGY = 1;
/** Nose drop in a stall, rad/s at the stall speed's full shortfall. */
const STALL_DROP = 70 * RAD;

/** Arcade throttle for the engine sound and instruments: idle, cruise or full. */
export const arcadeThrottle = (input: ArcadeInput) =>
  input.boost && !input.brake ? 1 : input.brake ? 0.15 : 0.6;

/**
 * Start an arcade flight at the aircraft's cruise, the nose put on the
 * flight path (a trimmed start has it a few degrees up) and flying along it.
 */
export function toArcade(plane: Airplane) {
  const h = ARCADE_HANDLING[plane.frame.id];
  const { heading, roll } = toAttitude(plane.body.orientation);
  const v = plane.body.velocity;
  const path = Math.atan2(v[2], Math.hypot(v[0], v[1])) * DEG;
  plane.body.orientation = fromAttitude({ heading, pitch: path, roll });
  const forward = rotate(plane.body.orientation, [1, 0, 0]);
  plane.body.velocity = scale(forward, h.cruise);
  plane.body.omega = [0, 0, 0];
  plane.airspeed = h.cruise;
  plane.alpha = 0;
  plane.beta = 0;
  plane.gearDown = 0;
  plane.gearCommand = false;
  plane.wheelsDown = 0;
}

/** Advance the airplane by dt seconds under arcade rules (mutates it). */
export function stepArcade(
  plane: Airplane,
  input: ArcadeInput,
  ground: GroundFn,
  dt: number,
) {
  if (plane.crashed) return;
  const h = ARCADE_HANDLING[plane.frame.id];
  const { body } = plane;
  const p = plane.frame.params;
  let speed = plane.airspeed;

  // Speed: towards the commanded speed, plus what climbing or diving does.
  const highG = input.boost && input.brake;
  const target = highG
    ? h.min
    : input.boost
      ? h.max
      : input.brake
        ? h.min
        : h.cruise;
  // A high-G turn bleeds speed at half the air brake's rate.
  const rate =
    target > speed
      ? input.boost
        ? h.boostAccel
        : h.settleUp
      : highG
        ? h.brakeDecel / 2
        : input.brake
          ? h.brakeDecel
          : h.settleDown;
  speed += clamp(target - speed, -rate * dt, rate * dt);
  const forward = rotate(body.orientation, [1, 0, 0]);
  speed -= ENERGY * G * forward[2] * dt;
  speed = clamp(speed, 0.4 * h.stall, h.max * 1.35);

  // Control authority fades as the speed drops towards the stall.
  const authority = clamp(
    (speed - 0.6 * h.stall) / (h.min - 0.6 * h.stall),
    0.25,
    1,
  );
  const stall = clamp((h.stall - speed) / h.stall, 0, 1);

  const steer = input.aim
    ? followAim(body.orientation, input.aim)
    : { pitch: 0, roll: 0, yaw: 0 };
  const rollInput = clamp(steer.roll + input.roll, -1, 1);
  const pitchInput = clamp(steer.pitch + input.pitch, -1, 1);
  const yawInput = clamp(steer.yaw + input.yaw, -1, 1);
  const wanted: Vec3 = [
    rollInput * h.rollRate * authority,
    -pitchInput * h.pitchRate * (highG ? h.highG : 1) * authority,
    -yawInput * h.yawRate * authority,
  ];
  const follow = 1 - Math.exp(-dt / RATE_LAG);
  body.omega = [
    body.omega[0] + (wanted[0] - body.omega[0]) * follow,
    body.omega[1] + (wanted[1] - body.omega[1]) * follow,
    body.omega[2] + (wanted[2] - body.omega[2]) * follow,
  ];
  let orientation = integrate(body.orientation, body.omega, dt);

  if (stall > 0) {
    // Stalled: the nose falls towards the ground about the axis across the flight path.
    const nose = rotate(orientation, [1, 0, 0]);
    const axis = cross(nose, [0, 0, -1]);
    if (Math.hypot(axis[0], axis[1], axis[2]) > 1e-3) {
      const bodyAxis = unrotate(orientation, normalize(axis));
      orientation = integrate(
        orientation,
        scale(bodyAxis, STALL_DROP * stall),
        dt,
      );
    }
  }
  body.orientation = orientation;

  // Along the nose, with a little sink when slow so a stall really falls.
  const nose = rotate(body.orientation, [1, 0, 0]);
  body.velocity = [
    nose[0] * speed,
    nose[1] * speed,
    nose[2] * speed - stall * 25,
  ];
  body.position = [
    body.position[0] + body.velocity[0] * dt,
    body.position[1] + body.velocity[1] * dt,
    body.position[2] + body.velocity[2] * dt,
  ];

  const hit = contactForces(body, plane.frame.structure, ground, {
    steer: 0,
    brake: 0,
  }).loads.findIndex((load) => load > 0);
  const gear =
    plane.gearDown > 0
      ? contactForces(body, plane.frame.gear, ground, {
          steer: 0,
          brake: 0,
        }).loads.some((load) => load > 0)
      : false;
  if (hit >= 0 || gear) {
    plane.crashed = {
      cause: "structure",
      part: hit >= 0 ? plane.frame.structure[hit].name : undefined,
    };
    body.velocity = [0, 0, 0];
    body.omega = [0, 0, 0];
  }

  const throttle = arcadeThrottle(input);
  plane.rpm +=
    (p.idleRpm + (p.maxRpm - p.idleRpm) * throttle - plane.rpm) *
    (1 - Math.exp(-dt / 0.6));
  plane.airspeed = speed;
  plane.alpha = 0;
  plane.beta = 0;
  plane.stalled = stall;
  plane.thrust = 0;
  plane.wheelsDown = 0;
  plane.surfaces.elevator = pitchInput;
  plane.surfaces.aileron = rollInput;
  plane.surfaces.rudder = yawInput;
}
