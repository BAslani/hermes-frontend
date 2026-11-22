/** pnpm test — arcade flight: speed held at cruise, boost and brake, nose-pointing turns, stalls and crashes. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  airborneAirplane,
  JET_AIRFRAME,
  TRAINER_AIRFRAME,
} from "./airplane.ts";
import {
  ARCADE_HANDLING,
  type ArcadeInput,
  stepArcade,
  toArcade,
} from "./arcade.ts";
import {
  type ArcadeCameraState,
  arcadeCamera,
  type CameraPose,
} from "./camera.ts";
import {
  fromAttitude,
  normalize,
  rotate,
  toAttitude,
  type Vec3,
} from "./vec.ts";

const flat = () => 0;
const STEP = 1 / 120;
const hands: ArcadeInput = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  boost: false,
  brake: false,
};

const jet = (height = 2000) => {
  const { airplane } = airborneAirplane(
    [0, 0, height],
    0,
    150,
    undefined,
    JET_AIRFRAME,
  );
  toArcade(airplane);
  return airplane;
};

const fly = (
  plane: ReturnType<typeof jet>,
  input: Partial<ArcadeInput>,
  seconds: number,
) => {
  for (let t = 0; t < seconds; t += STEP)
    stepArcade(plane, { ...hands, ...input }, flat, STEP);
};

test("arcade: hands off it holds cruise speed and its line", () => {
  const plane = jet();
  fly(plane, {}, 10);
  const h = ARCADE_HANDLING.jet;
  assert.ok(Math.abs(plane.airspeed - h.cruise) < 2, `${plane.airspeed}`);
  assert.ok(Math.abs(plane.body.position[2] - 2000) < 5);
  assert.ok(plane.body.position[1] > 10 * h.cruise * 0.95, "flew north");
  assert.equal(plane.crashed, null);
});

test("arcade: boost speeds up, the brake slows down, and the velocity follows the nose", () => {
  const plane = jet();
  fly(plane, { boost: true }, 6);
  assert.ok(
    plane.airspeed > ARCADE_HANDLING.jet.cruise + 100,
    `${plane.airspeed}`,
  );
  fly(plane, { brake: true }, 6);
  assert.ok(plane.airspeed < ARCADE_HANDLING.jet.min + 10, `${plane.airspeed}`);
  fly(plane, { pitch: 1 }, 0.6);
  const nose = rotate(plane.body.orientation, [1, 0, 0]);
  const along = normalize(plane.body.velocity);
  assert.ok(
    nose[0] * along[0] + nose[1] * along[1] + nose[2] * along[2] > 0.999,
  );
});

test("arcade: a high-G turn comes round faster than a plain one", () => {
  const turnTime = (highG: boolean) => {
    const plane = jet(3000);
    // Bank 90° to the right, then pull until the heading has turned 90°.
    fly(
      plane,
      { roll: 1 },
      (90 * Math.PI) / 180 / ARCADE_HANDLING.jet.rollRate + 0.12,
    );
    let t = 0;
    while (t < 20) {
      fly(plane, { pitch: 1, boost: highG, brake: highG }, 0.05);
      t += 0.05;
      const heading = toAttitude(plane.body.orientation).heading;
      if (heading > 90 && heading < 180) break;
    }
    return t;
  };
  assert.ok(turnTime(true) < turnTime(false) * 0.8);
});

test("arcade: climbing straight up bleeds the speed until it stalls and the nose falls", () => {
  const plane = jet(3000);
  fly(plane, { pitch: 1 }, 2.4);
  fly(plane, {}, 40);
  assert.ok(toAttitude(plane.body.orientation).pitch < 0, "nose came down");
  assert.equal(plane.crashed, null);
});

test("arcade: flying into the ground is a crash", () => {
  const { airplane } = airborneAirplane(
    [0, 0, 200],
    0,
    60,
    undefined,
    TRAINER_AIRFRAME,
  );
  toArcade(airplane);
  for (let t = 0; t < 20 && !airplane.crashed; t += STEP)
    stepArcade(airplane, { ...hands, pitch: -0.5 }, flat, STEP);
  assert.equal(airplane.crashed?.cause, "structure");
});

test("camera: sits behind the tail, banks with the aircraft a moment late, then catches up", () => {
  const rig = { back: 28, up: 6, lead: 40 };
  const state: ArcadeCameraState = { orientation: null };
  const level = fromAttitude({ heading: 0, pitch: 0, roll: 0 });
  const first = arcadeCamera(state, [0, 0, 1000], level, 0, rig, flat);
  assert.ok(
    first.position[1] < -27 && first.position[2] > 1005,
    "behind and above",
  );
  assert.ok(Math.abs(first.up[2] - 1) < 1e-9, "level");

  // Rolled 60° right: the horizon tilts with it, behind at first, all the way after a while.
  const banked = fromAttitude({ heading: 0, pitch: 0, roll: 60 });
  const tilt = (pose: CameraPose) =>
    (Math.atan2(pose.up[0], pose.up[2]) * 180) / Math.PI;
  const soon = arcadeCamera(state, [0, 0, 1000], banked, 0.1, rig, flat);
  assert.ok(tilt(soon) > 5 && tilt(soon) < 40, `${tilt(soon)}`);
  let late = soon;
  for (let i = 0; i < 40; i++)
    late = arcadeCamera(state, [0, 0, 1000], banked, 0.05, rig, flat);
  assert.ok(Math.abs(tilt(late) - 60) < 1, `${tilt(late)}`);
});

/** Angle between the nose and a direction, degrees. */
const offNose = (plane: ReturnType<typeof jet>, aim: Vec3) => {
  const nose = rotate(plane.body.orientation, [1, 0, 0]);
  const a = normalize(aim);
  const c = nose[0] * a[0] + nose[1] * a[1] + nose[2] * a[2];
  return (Math.acos(Math.min(1, c)) * 180) / Math.PI;
};

test("pointer: eases onto a pointer 35° to the right without overshooting, and rolls gently", () => {
  const plane = jet(3000);
  const aim: Vec3 = [Math.sin(0.61), Math.cos(0.61), 0];
  let reached = Infinity;
  let worstRollRate = 0;
  let heading = 0;
  let furthest = 0;
  for (let t = 0; t < 10; t += STEP) {
    stepArcade(plane, { ...hands, aim }, flat, STEP);
    worstRollRate = Math.max(worstRollRate, Math.abs(plane.body.omega[0]));
    heading = toAttitude(plane.body.orientation).heading;
    furthest = Math.max(furthest, heading);
    if (reached === Infinity && offNose(plane, aim) < 2) reached = t;
  }
  assert.ok(reached < 4, `took ${reached.toFixed(1)} s`);
  assert.ok(furthest < 35 + 4, `overshot to ${furthest.toFixed(1)}°`);
  assert.ok(offNose(plane, aim) < 1, `${offNose(plane, aim)}`);
  assert.ok(Math.abs(toAttitude(plane.body.orientation).roll) < 3);
  assert.ok(
    (worstRollRate * 180) / Math.PI < 120,
    `rolled at ${((worstRollRate * 180) / Math.PI).toFixed(0)}°/s`,
  );
});

test("pointer: held 35° off to the right it flies a steady banked turn, not a wobble", () => {
  const plane = jet(3000);
  const rolls: number[] = [];
  for (let t = 0; t < 12; t += STEP) {
    // The pointer stays at the edge of its reach, as when the mouse keeps going right.
    const { heading } = toAttitude(plane.body.orientation);
    const h = ((heading + 35) * Math.PI) / 180;
    stepArcade(
      plane,
      { ...hands, aim: [Math.sin(h), Math.cos(h), 0] },
      flat,
      STEP,
    );
    if (t > 6) rolls.push(toAttitude(plane.body.orientation).roll);
  }
  const spread = Math.max(...rolls) - Math.min(...rolls);
  assert.ok(Math.min(...rolls) > 30, `bank ${Math.min(...rolls).toFixed(0)}°`);
  assert.ok(spread < 8, `bank wobbles by ${spread.toFixed(1)}°`);
  assert.ok(Math.abs(plane.body.position[2] - 3000) < 300, "held its height");
});
