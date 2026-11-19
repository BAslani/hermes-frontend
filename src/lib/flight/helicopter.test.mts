/**
 * pnpm test — the helicopter (H135-class, 2.6 t, sea level, standard day):
 * the behaviours the playground plan asks for, against class numbers with
 * wide tolerances.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CALM } from "./airplane.ts";
import {
  assistedClimb,
  groundEffect,
  HELI,
  type HeliControls,
  type Helicopter,
  type HeliEnvironment,
  heliAssist,
  heliData,
  hoverCollective,
  hoveringHelicopter,
  NEUTRAL_HELI,
  parkedHelicopter,
  powerRequired,
  stepHelicopter,
  vortexRingState,
} from "./helicopter.ts";
import { STEP } from "./rigid-body.ts";
import { toAttitude } from "./vec.ts";

const FLAT: HeliEnvironment = { ground: () => 0, wind: CALM };
const within = (value: number, lo: number, hi: number, what: string) =>
  assert.ok(
    value >= lo && value <= hi,
    `${what}: ${value.toFixed(3)} not in ${lo}…${hi}`,
  );
function run(
  heli: Helicopter,
  seconds: number,
  controls: (t: number) => HeliControls,
  env = FLAT,
) {
  for (let i = 0; i < Math.round(seconds / STEP); i++)
    stepHelicopter(heli, controls(i * STEP), env, STEP);
}

test("heli: hover needs more collective high up", () => {
  const low = hoverCollective(0);
  const high = hoverCollective(2000);
  within(low, 0.35, 0.7, "sea-level hover collective");
  assert.ok(
    high > low + 0.03,
    `2,000 m (${high.toFixed(3)}) needs more than sea level (${low.toFixed(3)})`,
  );
});

test("heli: hover power is about 400–550 kW; translational lift cuts it at 40 kt", () => {
  const hover = powerRequired(0, 0);
  within(hover / 1000, 350, 600, "hover power, kW");
  const forty = powerRequired(40 * 0.5144, 0);
  assert.ok(
    forty < 0.8 * hover,
    `40 kt (${(forty / 1000).toFixed(0)} kW) well below hover (${(hover / 1000).toFixed(0)} kW)`,
  );
  // The power curve's bucket, then it rises again towards top speed.
  assert.ok(
    powerRequired(70, 0) > powerRequired(35, 0),
    "faster costs more again",
  );
});

test("heli: ground effect adds thrust near the ground and none high up", () => {
  within(groundEffect(3.5, 0), 1.1, 1.35, "skids just off the ground");
  assert.equal(groundEffect(30, 0), 1);
  assert.ok(groundEffect(3.5, 0.2) < 1.01, "gone at speed");
});

test("heli: the hover collective out of ground effect climbs away from the ground (raw controls)", () => {
  const collective = hoverCollective(0);
  const heli = parkedHelicopter(0, 0, 0, 0);
  run(heli, 3, () => ({ ...NEUTRAL_HELI, collective }));
  assert.ok(
    heli.body.position[2] > 1.6,
    `lifted off in ground effect (${heli.body.position[2].toFixed(2)} m)`,
  );
  assert.equal(heli.crashed, null);
});

test("heli: the assisted lever asks for climb rates, eased to a touchdown near the ground", () => {
  within(assistedClimb(0.5, 100), -0.01, 0.01, "middle hovers");
  within(assistedClimb(1, 100), 7.9, 8.1, "top climbs");
  within(assistedClimb(0, 100), -5.1, -4.9, "bottom descends");
  within(assistedClimb(0, 0), -1.1, -0.9, "but only gently at the ground");
});

test("heli: vortex ring state descending at about the hover inflow speed, not when moving forward", () => {
  const vh = 11;
  within(vortexRingState(0.7 * vh, 0, vh), 0.9, 1, "deep in it");
  assert.equal(vortexRingState(0.1 * vh, 0, vh), 0);
  assert.equal(vortexRingState(0.7 * vh, 1.2 * vh, vh), 0);
});

test("heli: a fast vertical descent loses thrust and shakes", () => {
  const { heli, collective } = hoveringHelicopter([0, 0, 2000], 0);
  heli.body.velocity = [0, 0, -8];
  run(heli, 1.5, () => ({ ...NEUTRAL_HELI, collective }));
  assert.ok(
    heli.vortexRing > 0.3,
    `in vortex ring state (${heli.vortexRing.toFixed(2)})`,
  );
});

test("heli: raising the collective with the pedals still yaws the nose right (torque)", () => {
  const { heli, collective } = hoveringHelicopter([0, 0, 1000], 0);
  run(heli, 3, () => ({ ...NEUTRAL_HELI, collective: collective + 0.2 }));
  assert.ok(
    heli.body.omega[2] < -0.05,
    `yawing right (${heli.body.omega[2].toFixed(3)} rad/s)`,
  );
});

test("heli: with assists a centred cyclic holds a steady hover", () => {
  const { heli } = hoveringHelicopter([0, 0, 500], 90);
  run(heli, 20, () =>
    heliAssist({ ...NEUTRAL_HELI, collective: 0.5 }, heli, FLAT),
  );
  const d = heliData(heli, FLAT);
  within(heli.body.position[2] - 500, -25, 25, "height drift, m");
  within(
    Math.hypot(heli.body.velocity[0], heli.body.velocity[1]),
    0,
    4,
    "drift speed, m/s",
  );
  within(Math.abs(d.roll), 0, 4, "bank");
  within(Math.abs(((d.heading - 90 + 540) % 360) - 180), 0, 5, "heading held");
  assert.equal(heli.crashed, null);
});

test("heli: forward cyclic with assists accelerates into forward flight", () => {
  const { heli } = hoveringHelicopter([0, 0, 500], 0);
  run(heli, 25, () =>
    heliAssist({ ...NEUTRAL_HELI, collective: 0.5, pitch: -0.5 }, heli, FLAT),
  );
  const d = heliData(heli, FLAT);
  assert.ok(
    heli.body.velocity[1] > 25,
    `flying north at ${heli.body.velocity[1].toFixed(1)} m/s`,
  );
  assert.ok(
    heli.body.position[2] > 350,
    `not sinking out (${heli.body.position[2].toFixed(0)} m)`,
  );
  within(d.rotor, 92, 108, "rotor speed held, %");
  assert.equal(heli.crashed, null);
});

test("heli: take off, hover, and set it down gently without breaking anything", () => {
  // As a player does with assists: hold W to raise the lever (0.5/s) to about
  // three quarters, climb a while, then lower it to the bottom and let it settle.
  const heli = parkedHelicopter(0, 0, 0, 0);
  run(heli, 10, (t) =>
    heliAssist(
      { ...NEUTRAL_HELI, collective: Math.min(0.75, t * 0.5) },
      heli,
      FLAT,
    ),
  );
  assert.ok(
    heli.body.position[2] > 15,
    `airborne (${heli.body.position[2].toFixed(1)} m)`,
  );
  run(heli, 60, () =>
    heliAssist({ ...NEUTRAL_HELI, collective: 0 }, heli, FLAT),
  );
  assert.equal(
    heli.crashed,
    null,
    `crashed: ${heli.crashed?.part ?? heli.crashed?.cause}`,
  );
  assert.ok(heli.skidsDown >= 3, "back on the skids");
});

test("heli: rotor tips hit the ground when it rolls over", () => {
  const heli = parkedHelicopter(0, 0, 0, 0);
  heli.body.omega = [3, 0, 0];
  run(heli, 2, () => NEUTRAL_HELI);
  assert.ok(heli.crashed, "rolled into the ground");
  void toAttitude;
  void HELI;
});
