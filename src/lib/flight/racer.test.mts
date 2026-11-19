/**
 * pnpm test — pins the race plane (Extra 330-class, 750 kg, 315 hp, sea level,
 * standard day) to known numbers for its class, with tolerances.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Airplane,
  type AirplaneControls,
  airborneAirplane,
  CALM,
  type Environment,
  flightData,
  NEUTRAL_CONTROLS,
  RACER_AIRFRAME,
  stepAirplane,
  trimLevel,
} from "./airplane.ts";
import { KNOT, RACER, stallSpeed } from "./fixed-wing.ts";
import { STEP } from "./rigid-body.ts";
import { DEG, qaxis, qmul, RAD, toAttitude } from "./vec.ts";

const FLAT: Environment = { ground: () => 0, wind: CALM };
const within = (value: number, lo: number, hi: number, what: string) =>
  assert.ok(
    value >= lo && value <= hi,
    `${what}: ${value.toFixed(2)} not in ${lo}…${hi}`,
  );

function run(
  plane: Airplane,
  seconds: number,
  controls: (t: number) => AirplaneControls,
) {
  for (let i = 0; i < Math.round(seconds / STEP); i++)
    stepAirplane(plane, controls(i * STEP), FLAT, STEP);
}

const racer = (altitude: number, speed: number) =>
  airborneAirplane([0, 0, altitude], 0, speed, CALM, RACER_AIRFRAME);

test("racer: stalls near 59 kt", () => {
  within(stallSpeed(0, 1.225, RACER) / KNOT, 54, 64, "stall, kt");
});

test("racer: full power level flight tops out around 200 kt at sea level", () => {
  assert.ok(trimLevel(95, 0, 0, RACER).throttle < 1, "185 kt is within reach");
  assert.ok(trimLevel(118, 0, 0, RACER).throttle > 0.999, "230 kt is not");
});

test("racer: trimmed level cruise holds altitude and speed", () => {
  for (const [speed, altitude] of [
    [80, 500],
    [95, 2500],
  ]) {
    const { airplane, trim } = racer(altitude, speed);
    assert.equal(airplane.frame.id, "racer");
    const controls = {
      ...NEUTRAL_CONTROLS,
      pitch: trim.elevator,
      throttle: trim.throttle,
    };
    let low = Infinity;
    let high = -Infinity;
    run(airplane, 60, () => {
      low = Math.min(low, airplane.body.position[2]);
      high = Math.max(high, airplane.body.position[2]);
      return controls;
    });
    const d = flightData(airplane, FLAT);
    within(high - altitude, -12, 12, `highest at ${speed} m/s`);
    within(low - altitude, -12, 12, `lowest at ${speed} m/s`);
    within(d.tas - speed, -2, 2, "speed drift, m/s");
    within(Math.abs(d.roll), 0, 1, "bank");
  }
});

test("racer: rolls at over 300°/s with full aileron", () => {
  const { airplane, trim } = racer(1500, 85);
  let peak = 0;
  run(airplane, 1.5, () => {
    peak = Math.max(peak, airplane.body.omega[0] * DEG);
    return { ...NEUTRAL_CONTROLS, pitch: trim.elevator, throttle: 1, roll: 1 };
  });
  within(peak, 300, 480, "peak roll rate, °/s");
  assert.equal(airplane.crashed, null);
});

test("racer: climbs at over 2,500 ft/min at full power", () => {
  const { airplane, trim } = racer(300, 55);
  let pitchTarget = 12;
  const fly = () => {
    pitchTarget += 0.4 * (airplane.airspeed - 55) * STEP;
    const { pitch, roll } = toAttitude(airplane.body.orientation);
    return {
      ...NEUTRAL_CONTROLS,
      throttle: 1,
      pitch: Math.max(
        -1,
        Math.min(
          1,
          trim.elevator +
            0.08 * (Math.min(25, Math.max(0, pitchTarget)) - pitch) +
            0.03 * airplane.body.omega[1] * DEG,
        ),
      ),
      roll: Math.max(
        -1,
        Math.min(1, -0.03 * roll - 0.01 * airplane.body.omega[0] * DEG),
      ),
    };
  };
  run(airplane, 20, fly);
  const from = airplane.body.position[2];
  run(airplane, 30, fly);
  const fpm = (((airplane.body.position[2] - from) / 30) * 60) / 0.3048;
  within(fpm, 2500, 4500, "climb, ft/min");
});

test("racer: statically stable in pitch", () => {
  const { airplane, trim } = racer(1500, 80);
  const controls = {
    ...NEUTRAL_CONTROLS,
    pitch: trim.elevator,
    throttle: trim.throttle,
  };
  airplane.body.orientation = qmul(
    airplane.body.orientation,
    qaxis([0, 1, 0], -5 * RAD),
  );
  run(airplane, 0.05, () => controls);
  assert.ok(airplane.alpha > trim.alpha + 3 * RAD, "disturbed");
  run(airplane, 4, () => controls);
  within(
    (airplane.alpha - trim.alpha) * DEG,
    -0.8,
    0.8,
    "angle of attack back at trim, degrees",
  );
});

test("racer: no flaps, whatever the lever says", () => {
  const { airplane, trim } = racer(1500, 80);
  run(airplane, 5, () => ({
    ...NEUTRAL_CONTROLS,
    pitch: trim.elevator,
    throttle: trim.throttle,
    flaps: 3,
  }));
  assert.equal(airplane.flapAngle, 0);
});
