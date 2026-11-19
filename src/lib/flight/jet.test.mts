/**
 * pnpm test — the playground jet (F-14A-class, 22 t, wings spread). Rough
 * class numbers with wide tolerances: this is a toy next to the trainer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Airplane,
  type AirplaneControls,
  airborneAirplane,
  assist,
  CALM,
  type Environment,
  flightData,
  JET_AIRFRAME,
  NEUTRAL_CONTROLS,
  parkedAirplane,
  stepAirplane,
  trimLevel,
} from "./airplane.ts";
import { JET, KNOT, stallSpeed } from "./fixed-wing.ts";
import { STEP } from "./rigid-body.ts";
import { DEG, toAttitude } from "./vec.ts";

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

test("jet: stalls near 125 kt clean and about 105 kt with full flaps", () => {
  within(stallSpeed(0, 1.225, JET) / KNOT, 112, 140, "clean stall, kt");
  within(stallSpeed(30, 1.225, JET) / KNOT, 92, 118, "full-flap stall, kt");
});

test("jet: trimmed level cruise at 290 kt holds altitude", () => {
  const { airplane, trim } = airborneAirplane(
    [0, 0, 3000],
    0,
    150,
    CALM,
    JET_AIRFRAME,
  );
  assert.equal(airplane.gearDown, 0, "starts in the air with the gear up");
  within(trim.throttle, 0.15, 0.8, "cruise throttle");
  const controls = {
    ...NEUTRAL_CONTROLS,
    pitch: trim.elevator,
    throttle: trim.throttle,
  };
  let low = Infinity;
  let high = -Infinity;
  run(airplane, 40, () => {
    low = Math.min(low, airplane.body.position[2]);
    high = Math.max(high, airplane.body.position[2]);
    return controls;
  });
  within(high - 3000, -25, 25, "highest");
  within(low - 3000, -25, 25, "lowest");
  assert.equal(airplane.crashed, null);
});

test("jet: the spool lags the throttle", () => {
  const { airplane, trim } = airborneAirplane(
    [0, 0, 3000],
    0,
    150,
    CALM,
    JET_AIRFRAME,
  );
  const before = airplane.rpm;
  run(airplane, 0.5, () => ({
    ...NEUTRAL_CONTROLS,
    pitch: trim.elevator,
    throttle: 1,
  }));
  assert.ok(
    airplane.rpm > before && airplane.rpm < 99,
    `half a second in: ${airplane.rpm.toFixed(1)} %`,
  );
});

test("jet: takes off like a player flies it, with assists: rotate at 145 kt, centre the stick, climb out", () => {
  for (const stick of [0.2, 0.4, 0.7]) {
    const plane = parkedAirplane(0, 0, 0, 0, JET_AIRFRAME);
    assert.equal(plane.gearDown, 1);
    let rolled = 0;
    let liftoff: number | null = null;
    let t = 0;
    run(plane, 40, () => {
      t += STEP;
      const d = flightData(plane, FLAT);
      if (d.onGround) rolled = plane.body.position[1];
      else if (liftoff === null && plane.body.position[2] > 4) liftoff = t;
      const pull = d.ias > 75 && (liftoff === null || t < liftoff + 2);
      return assist(
        { ...NEUTRAL_CONTROLS, throttle: 1, flaps: 1, pitch: pull ? stick : 0 },
        plane,
      );
    });
    assert.equal(
      plane.crashed,
      null,
      `stick ${stick}: crashed (${plane.crashed?.part ?? plane.crashed?.cause})`,
    );
    within(rolled, 400, 1500, `stick ${stick}: ground roll, m`);
    assert.ok(
      plane.body.position[2] > 300,
      `stick ${stick}: climbing (${plane.body.position[2].toFixed(0)} m)`,
    );
  }
});

test("jet: fly-by-wire holds the attitude with the stick centred, and keeps α under its limit when pulled", () => {
  const { airplane } = airborneAirplane(
    [0, 0, 3000],
    0,
    150,
    CALM,
    JET_AIRFRAME,
  );
  run(airplane, 1.5, () =>
    assist({ ...NEUTRAL_CONTROLS, throttle: 0.6, pitch: 0.5 }, airplane),
  );
  const after = toAttitude(airplane.body.orientation).pitch;
  assert.ok(after > 8, `pitched up (${after.toFixed(1)}°)`);
  run(airplane, 3, () =>
    assist({ ...NEUTRAL_CONTROLS, throttle: 0.6 }, airplane),
  );
  const held = toAttitude(airplane.body.orientation).pitch;
  within(held - after, -4, 6, "pitch drift over 3 s hands-off, degrees");
  let maxAlpha = 0;
  run(airplane, 4, () => {
    maxAlpha = Math.max(maxAlpha, airplane.alpha * DEG);
    return assist({ ...NEUTRAL_CONTROLS, throttle: 1, pitch: 1 }, airplane);
  });
  within(maxAlpha, 5, 18, "highest α at full back stick, degrees");
});

test("jet: gear travels up and down, and landing with it up is a crash", () => {
  const { airplane } = airborneAirplane(
    [0, 0, 1000],
    0,
    150,
    CALM,
    JET_AIRFRAME,
  );
  airplane.gearCommand = true;
  run(airplane, 3, () => NEUTRAL_CONTROLS);
  within(airplane.gearDown, 0.4, 0.6, "half way after 3 s");
  run(airplane, 4, () => NEUTRAL_CONTROLS);
  assert.equal(airplane.gearDown, 1);

  // Gear up on the runway: the engines touch first.
  const belly = parkedAirplane(0, 0, 0, 0, JET_AIRFRAME);
  belly.gearDown = 0;
  belly.gearCommand = false;
  run(belly, 2, () => NEUTRAL_CONTROLS);
  assert.ok(belly.crashed, "the airframe hit the ground");
});

test("jet: rolls at over 100°/s at 300 kt", () => {
  const { airplane, trim } = airborneAirplane(
    [0, 0, 3000],
    0,
    155,
    CALM,
    JET_AIRFRAME,
  );
  let peak = 0;
  run(airplane, 2, () => {
    peak = Math.max(peak, airplane.body.omega[0] * DEG);
    return {
      ...NEUTRAL_CONTROLS,
      pitch: trim.elevator,
      throttle: trim.throttle,
      roll: 1,
    };
  });
  within(peak, 100, 260, "peak roll rate, °/s");
  void toAttitude;
});

test("jet: full throttle reaches well over 500 kt at 3,000 m", () => {
  assert.ok(trimLevel(260, 3000, 0, JET).throttle < 1, "505 kt within reach");
});
