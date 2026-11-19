/**
 * The pilot's side of the controls: turns mouse movement and held keys into
 * the airplane's control inputs. The mouse is a virtual yoke (it deflects and
 * stays, or springs back when self-centring is on); keys ramp the rudder and
 * move the throttle, flaps and trim.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import type { AirplaneControls } from "./airplane.ts";
import { clamp } from "./vec.ts";

export interface PilotState {
  /** Virtual stick, −1…1: x right, y back (nose up). */
  stickX: number;
  stickY: number;
  /** Seconds since the mouse last moved. */
  stickIdle: number;
  rudder: number;
  throttle: number;
  flaps: number;
  trim: number;
  parkingBrake: boolean;
}

export const newPilot = (over: Partial<PilotState> = {}): PilotState => ({
  stickX: 0,
  stickY: 0,
  stickIdle: 0,
  rudder: 0,
  throttle: 0,
  flaps: 0,
  trim: 0,
  parkingBrake: true,
  ...over,
});

export const PILOT = {
  /** Stick travel per pixel of mouse movement: about 400 px from centre to stop. */
  mouseGain: 1 / 400,
  /** Movements smaller than this around the centre count as centred. */
  deadzone: 0.04,
  /** Self-centring: wait, then spring back at this rate (1/s). */
  centreDelay: 0.15,
  centreRate: 2.5,
  /** Rudder: seconds from neutral to full, and back. */
  rudderTime: 0.35,
  /** Throttle travel per second while the key is held. */
  throttleRate: 0.5,
  /** Trim travel per second while the key is held. */
  trimRate: 0.15,
  flapSteps: 4,
} as const;

/** Mouse moved by (dx, dy) pixels: right rolls right, pulling back (down) raises the nose. */
export function moveStick(pilot: PilotState, dx: number, dy: number) {
  pilot.stickX = clamp(pilot.stickX + dx * PILOT.mouseGain, -1, 1);
  pilot.stickY = clamp(pilot.stickY + dy * PILOT.mouseGain, -1, 1);
  pilot.stickIdle = 0;
}

export interface HeldKeys {
  throttleUp: boolean;
  throttleDown: boolean;
  rudderLeft: boolean;
  rudderRight: boolean;
  trimUp: boolean;
  trimDown: boolean;
  brake: boolean;
}

/** Advance the held-key controls and the stick spring by dt seconds. */
export function updatePilot(
  pilot: PilotState,
  keys: HeldKeys,
  dt: number,
  selfCentring: boolean,
) {
  const rudderTarget = (keys.rudderRight ? 1 : 0) - (keys.rudderLeft ? 1 : 0);
  const step = dt / PILOT.rudderTime;
  pilot.rudder += clamp(rudderTarget - pilot.rudder, -step, step);

  const throttle = (keys.throttleUp ? 1 : 0) - (keys.throttleDown ? 1 : 0);
  pilot.throttle = clamp(
    pilot.throttle + throttle * PILOT.throttleRate * dt,
    0,
    1,
  );

  const trim = (keys.trimUp ? 1 : 0) - (keys.trimDown ? 1 : 0);
  pilot.trim = clamp(pilot.trim + trim * PILOT.trimRate * dt, -1, 1);

  pilot.stickIdle += dt;
  if (selfCentring && pilot.stickIdle > PILOT.centreDelay) {
    const keep = Math.exp(-PILOT.centreRate * dt);
    pilot.stickX *= keep;
    pilot.stickY *= keep;
  }
}

export function stepFlaps(pilot: PilotState, direction: 1 | -1) {
  pilot.flaps = clamp(pilot.flaps + direction, 0, PILOT.flapSteps - 1);
}

/** Stick position with the deadzone taken out, rescaled so travel still ends at ±1. */
export function shaped(value: number) {
  const magnitude = Math.abs(value);
  if (magnitude <= PILOT.deadzone) return 0;
  return (
    (Math.sign(value) * (magnitude - PILOT.deadzone)) / (1 - PILOT.deadzone)
  );
}

export function controlsFrom(
  pilot: PilotState,
  keys: HeldKeys,
): AirplaneControls {
  return {
    pitch: shaped(pilot.stickY),
    roll: shaped(pilot.stickX),
    yaw: pilot.rudder,
    throttle: pilot.throttle,
    flaps: pilot.flaps,
    trim: pilot.trim,
    brake: pilot.parkingBrake || keys.brake ? 1 : 0,
  };
}
