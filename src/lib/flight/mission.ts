/**
 * Rescue and delivery mission rules: a list of steps flown in order, each a
 * landing (set down in a zone and stay there a few seconds) or a hoist (hover
 * over a spot, low and steady, while the winch goes down and up). Fuel burns
 * with the power the rotor takes; patients have a deadline; touchdowns are
 * scored for smoothness.
 *
 * Positions are local east-north-up metres; the caller converts them from
 * the map as the origin moves.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import type { Vec3 } from "./vec.ts";

export type StepKind = "land" | "hoist";
/** Why a mission ended early. */
export type MissionFailure = "crashed" | "out-of-fuel" | "avalanche";
/** What happens at a step, for the read-outs. */
export type StepRole =
  | "load-cargo"
  | "drop-cargo"
  | "pick-patient"
  | "drop-patient"
  | "return";

export interface MissionStep {
  kind: StepKind;
  role: StepRole;
  /** The spot, on the ground (z = ground elevation). */
  at: Vec3;
  /** Metres: the landing zone's radius, or how far off the spot a hoist may hover. */
  radius: number;
  /** Seconds on the ground, or of winching, to complete it. */
  hold: number;
}

/** A hoist works with the hook between these heights above the spot, metres. */
export const HOIST_MIN = 6;
export const HOIST_MAX = 40;
/** Hover steadier than this to winch, m/s over the ground. */
export const HOIST_DRIFT = 2.5;
/** Landed means at least this many skid points down and nearly still. */
const LANDED_POINTS = 3;
const LANDED_SPEED = 1;
/** Turboshaft fuel burn, kg per kWh of rotor power. */
export const FUEL_PER_KWH = 0.36;
/** A touchdown softer than this costs nothing, m/s. */
const SOFT_TOUCHDOWN = 1.5;

export interface MissionSpec {
  steps: MissionStep[];
  /** kg of fuel at the start. */
  fuel: number;
  /** Seconds from the start by which the patient should be on board, if there is one. */
  patientDeadline?: number;
  /** A good time for the whole mission, seconds; finishing faster earns a bonus. */
  par: number;
}

export interface MissionState {
  phase: "flying" | "done" | "failed";
  failure: MissionFailure | null;
  time: number;
  step: number;
  /** Seconds accumulated on the current step's hold. */
  hold: number;
  fuel: number;
  patientOnBoard: boolean;
  patientLate: boolean;
  cargoOnBoard: boolean;
  /** Fastest touchdown so far, m/s. */
  hardestTouchdown: number;
  /** Total of touchdown sink rates over the soft limit, m/s. */
  roughness: number;
  /** Whether the skids were down at the last step, to catch touchdowns. */
  wasDown: boolean;
}

export function newMission(
  spec: MissionSpec,
  startsWithCargo = false,
): MissionState {
  return {
    phase: "flying",
    failure: null,
    time: 0,
    step: 0,
    hold: 0,
    fuel: spec.fuel,
    patientOnBoard: false,
    patientLate: false,
    cargoOnBoard: startsWithCargo,
    hardestTouchdown: 0,
    roughness: 0,
    wasDown: true,
  };
}

/** What the mission needs to know about the helicopter each step. */
export interface Craft {
  position: Vec3;
  velocity: Vec3;
  /** Skid points touching the ground. */
  skidsDown: number;
  /** Fastest downward speed of a skid point touching down this step, m/s. */
  sinkRate: number;
  /** Rotor power, W. */
  power: number;
  crashed: boolean;
}

export type MissionEvent =
  | { type: "step"; index: number; role: StepRole }
  | { type: "touchdown"; sink: number }
  | { type: "patient-late" }
  | { type: "done" }
  | { type: "failed"; failure: MissionFailure };

/** End the mission now for a reason outside these rules (an avalanche took the patient). */
export function failMission(
  state: MissionState,
  failure: MissionFailure,
): MissionEvent[] {
  if (state.phase !== "flying") return [];
  state.phase = "failed";
  state.failure = failure;
  return [{ type: "failed", failure }];
}

/** How far along the current step is, 0–1. */
export const stepProgress = (state: MissionState, spec: MissionSpec) =>
  state.phase !== "flying" || !spec.steps[state.step]
    ? 0
    : Math.min(1, state.hold / spec.steps[state.step].hold);

/** Horizontal distance to a step's spot, and the height above it. */
export function relation(craft: Craft, step: MissionStep) {
  return {
    distance: Math.hypot(
      craft.position[0] - step.at[0],
      craft.position[1] - step.at[1],
    ),
    height: craft.position[2] - step.at[2],
    drift: Math.hypot(craft.velocity[0], craft.velocity[1]),
  };
}

/**
 * Whether a hoist could work right now: over the spot, the hook height in
 * the band, steady. `hookOffset` is how far below the craft's reference
 * point the hoist hangs from (it is lowered from the cabin roof).
 */
export function hoistReady(craft: Craft, step: MissionStep, hookOffset = 0) {
  const { distance, height, drift } = relation(craft, step);
  const hook = height - hookOffset;
  return (
    craft.skidsDown === 0 &&
    distance <= step.radius &&
    hook >= HOIST_MIN &&
    hook <= HOIST_MAX &&
    drift <= HOIST_DRIFT
  );
}

/** Advance the mission by one physics step (mutates the state). */
export function stepMission(
  state: MissionState,
  spec: MissionSpec,
  craft: Craft,
  dt: number,
  hookOffset = 0,
): MissionEvent[] {
  const events: MissionEvent[] = [];
  if (state.phase !== "flying") return events;
  if (craft.crashed) {
    state.phase = "failed";
    state.failure = "crashed";
    events.push({ type: "failed", failure: "crashed" });
    return events;
  }
  state.time += dt;
  state.fuel = Math.max(
    0,
    state.fuel - ((craft.power / 1000) * FUEL_PER_KWH * dt) / 3600,
  );
  if (state.fuel <= 0) {
    state.phase = "failed";
    state.failure = "out-of-fuel";
    events.push({ type: "failed", failure: "out-of-fuel" });
    return events;
  }

  // Touchdowns: the moment the skids meet the ground.
  const down = craft.skidsDown > 0;
  if (down && !state.wasDown) {
    state.hardestTouchdown = Math.max(state.hardestTouchdown, craft.sinkRate);
    state.roughness += Math.max(0, craft.sinkRate - SOFT_TOUCHDOWN);
    events.push({ type: "touchdown", sink: craft.sinkRate });
  }
  state.wasDown = down;

  if (
    spec.patientDeadline !== undefined &&
    !state.patientOnBoard &&
    !state.patientLate &&
    state.time > spec.patientDeadline
  ) {
    const stillToPick = spec.steps
      .slice(state.step)
      .some((s) => s.role === "pick-patient");
    if (stillToPick) {
      state.patientLate = true;
      events.push({ type: "patient-late" });
    }
  }

  const step = spec.steps[state.step];
  if (!step) return events;
  const { distance, drift } = relation(craft, step);
  let working: boolean;
  if (step.kind === "land") {
    working =
      craft.skidsDown >= LANDED_POINTS &&
      distance <= step.radius &&
      drift <= LANDED_SPEED;
    // Lifting off starts the wait again.
    if (!working) state.hold = 0;
  } else {
    working = hoistReady(craft, step, hookOffset);
    // The winch stops while out of limits, and gives up if the craft flies away.
    if (!working && distance > step.radius * 4) state.hold = 0;
  }
  if (working) state.hold += dt;

  if (state.hold >= step.hold) {
    if (step.role === "pick-patient") state.patientOnBoard = true;
    if (step.role === "drop-patient") state.patientOnBoard = false;
    if (step.role === "load-cargo") state.cargoOnBoard = true;
    if (step.role === "drop-cargo") state.cargoOnBoard = false;
    events.push({ type: "step", index: state.step, role: step.role });
    state.step += 1;
    state.hold = 0;
    if (state.step >= spec.steps.length) {
      state.phase = "done";
      events.push({ type: "done" });
    }
  }
  return events;
}

export interface Score {
  base: number;
  time: number;
  fuel: number;
  smoothness: number;
  patient: number;
  total: number;
}

/** Points for a finished mission: completion, speed against par, fuel left, gentle touchdowns, the patient on time. */
export function scoreMission(state: MissionState, spec: MissionSpec): Score {
  const base = state.phase === "done" ? 1000 : 0;
  const time =
    state.phase === "done"
      ? Math.round(Math.max(0, spec.par - state.time) * 4)
      : 0;
  const fuel =
    state.phase === "done" ? Math.round((state.fuel / spec.fuel) * 300) : 0;
  const smoothness = -Math.round(state.roughness * 250);
  const patient = state.patientLate ? -300 : 0;
  return {
    base,
    time,
    fuel,
    smoothness,
    patient,
    total: Math.max(0, base + time + fuel + smoothness + patient),
  };
}

export type MissionMedal = "gold" | "silver" | "bronze" | null;

export function missionMedal(
  total: number,
  targets: { gold: number; silver: number; bronze: number },
): MissionMedal {
  if (total >= targets.gold) return "gold";
  if (total >= targets.silver) return "silver";
  if (total >= targets.bronze) return "bronze";
  return null;
}
