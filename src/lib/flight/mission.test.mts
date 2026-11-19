/** pnpm test — rescue mission rules: landing holds, hoists, fuel, deadlines, touchdowns, scores. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Craft,
  FUEL_PER_KWH,
  failMission,
  HOIST_MAX,
  hoistReady,
  type MissionSpec,
  missionMedal,
  newMission,
  scoreMission,
  stepMission,
  stepProgress,
} from "./mission.ts";

const DT = 1 / 120;
const SPEC: MissionSpec = {
  fuel: 300,
  par: 300,
  patientDeadline: 100,
  steps: [
    {
      kind: "hoist",
      role: "pick-patient",
      at: [1000, 0, 500],
      radius: 12,
      hold: 10,
    },
    { kind: "land", role: "drop-patient", at: [0, 0, 0], radius: 15, hold: 5 },
  ],
};
const still = (position: [number, number, number], skidsDown = 0): Craft => ({
  position,
  velocity: [0, 0, 0],
  skidsDown,
  sinkRate: 0,
  power: 400_000,
  crashed: false,
});
function hold(
  state: ReturnType<typeof newMission>,
  craft: Craft,
  seconds: number,
) {
  const events = [];
  for (let t = 0; t < seconds; t += DT)
    events.push(...stepMission(state, SPEC, craft, DT));
  return events;
}

test("mission: a hoist works hovering low and steady over the spot", () => {
  assert.ok(hoistReady(still([1003, 2, 520]), SPEC.steps[0]));
  assert.equal(
    hoistReady(still([1003, 2, 500 + HOIST_MAX + 5]), SPEC.steps[0]),
    false,
    "too high",
  );
  assert.equal(
    hoistReady(still([1030, 0, 520]), SPEC.steps[0]),
    false,
    "not over it",
  );
  assert.equal(
    hoistReady(
      { ...still([1000, 0, 520]), velocity: [4, 0, 0] },
      SPEC.steps[0],
    ),
    false,
    "drifting",
  );
  assert.equal(
    hoistReady(still([1000, 0, 520], 4), SPEC.steps[0]),
    false,
    "on the ground",
  );
});

test("mission: the winch pauses out of limits and finishes once enough time is held", () => {
  const state = newMission(SPEC);
  state.wasDown = false;
  hold(state, still([1000, 0, 520]), 6);
  const half = stepProgress(state, SPEC);
  assert.ok(half > 0.55 && half < 0.65, `about 60 % (${half.toFixed(2)})`);
  hold(state, still([1000, 0, 600]), 3); // too high: paused, kept
  assert.ok(Math.abs(stepProgress(state, SPEC) - half) < 1e-9, "paused");
  const events = hold(state, still([1000, 0, 520]), 4.1);
  assert.ok(events.some((e) => e.type === "step" && e.role === "pick-patient"));
  assert.equal(state.patientOnBoard, true);
  assert.equal(state.step, 1);
});

test("mission: landing must stay down for the hold; lifting off starts it again", () => {
  const state = newMission(SPEC);
  state.step = 1;
  state.patientOnBoard = true;
  hold(state, still([3, 3, 1.3], 4), 3);
  hold(state, still([3, 3, 4]), 0.5); // hop
  assert.equal(stepProgress(state, SPEC), 0);
  const events = hold(state, still([3, 3, 1.3], 4), 5.1);
  assert.ok(events.some((e) => e.type === "done"));
  assert.equal(state.phase, "done");
  assert.equal(state.patientOnBoard, false);
});

test("mission: landing outside the zone does not count", () => {
  const state = newMission(SPEC);
  state.step = 1;
  hold(state, still([40, 0, 1.3], 4), 8);
  assert.equal(state.step, 1);
});

test("mission: fuel burns with power, and running out fails it", () => {
  const state = newMission({ ...SPEC, fuel: 1 });
  state.wasDown = false;
  const perSecond = (400 * FUEL_PER_KWH) / 3600;
  hold(state, still([500, 0, 800]), 0.5 / perSecond);
  assert.equal(state.phase, "flying");
  const events = hold(state, still([500, 0, 800]), 0.6 / perSecond);
  assert.equal(state.phase, "failed");
  assert.ok(
    events.some((e) => e.type === "failed" && e.failure === "out-of-fuel"),
  );
});

test("mission: an outside failure (avalanche) ends it once", () => {
  const state = newMission(SPEC);
  assert.equal(failMission(state, "avalanche").length, 1);
  assert.equal(state.failure, "avalanche");
  assert.equal(failMission(state, "avalanche").length, 0);
});

test("mission: a crash fails it at once", () => {
  const state = newMission(SPEC);
  const events = stepMission(
    state,
    SPEC,
    { ...still([0, 0, 0]), crashed: true },
    DT,
  );
  assert.equal(state.phase, "failed");
  assert.ok(events.some((e) => e.type === "failed" && e.failure === "crashed"));
});

test("mission: missing the patient's deadline is flagged once", () => {
  const state = newMission(SPEC);
  state.wasDown = false;
  const events = hold(state, still([500, 0, 800]), 101);
  assert.equal(events.filter((e) => e.type === "patient-late").length, 1);
  assert.equal(state.patientLate, true);
});

test("mission: touchdowns are caught, and only hard ones cost", () => {
  const state = newMission(SPEC);
  state.wasDown = false;
  const events = stepMission(
    state,
    SPEC,
    { ...still([500, 0, 1.3], 2), sinkRate: 2.5 },
    DT,
  );
  assert.ok(events.some((e) => e.type === "touchdown"));
  assert.ok(Math.abs(state.roughness - 1) < 1e-9);
  stepMission(state, SPEC, still([500, 0, 5]), DT);
  stepMission(state, SPEC, { ...still([500, 0, 1.3], 2), sinkRate: 0.8 }, DT);
  assert.ok(Math.abs(state.roughness - 1) < 1e-9, "a soft one adds nothing");
});

test("mission: score and medals", () => {
  const state = newMission(SPEC);
  state.phase = "done";
  state.time = 200;
  state.fuel = 150;
  const score = scoreMission(state, SPEC);
  assert.equal(score.total, 1000 + 400 + 150);
  assert.equal(
    missionMedal(score.total, { gold: 1500, silver: 1300, bronze: 1100 }),
    "gold",
  );
  state.phase = "failed";
  assert.equal(scoreMission(state, SPEC).total, 0);
});
