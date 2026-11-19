/**
 * pnpm test — pins the light airplane to known numbers for its class
 * (Cessna 172 at 2,300 lb, sea level, standard day), with tolerances.
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
  MAX_TOUCHDOWN_SINK,
  NEUTRAL_CONTROLS,
  PARKED_HEIGHT,
  parkedAirplane,
  stepAirplane,
  trimLevel,
  windVector,
} from "./airplane.ts";
import { airDensity, standardAir } from "./atmosphere.ts";
import {
  FOOT,
  KNOT,
  maxLift,
  stallSpeed,
  TRAINER,
  targetRpm,
  thrust,
  wingLift,
} from "./fixed-wing.ts";
import { STEP } from "./rigid-body.ts";
import {
  clamp,
  DEG,
  fromAttitude,
  qaxis,
  qmul,
  RAD,
  toAttitude,
} from "./vec.ts";

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
  env = FLAT,
) {
  for (let i = 0; i < Math.round(seconds / STEP); i++)
    stepAirplane(plane, controls(i * STEP), env, STEP);
}

/** A pilot holding a pitch attitude and wings level: enough to fly speeds and climbs. */
function holdPitch(
  plane: Airplane,
  target: number,
  base: AirplaneControls,
): AirplaneControls {
  const { pitch, roll } = toAttitude(plane.body.orientation);
  const pitchRate = -plane.body.omega[1] * DEG;
  return {
    ...base,
    pitch: Math.max(
      -1,
      Math.min(1, base.pitch + 0.08 * (target - pitch) - 0.03 * pitchRate),
    ),
    roll: Math.max(
      -1,
      Math.min(1, -0.03 * roll - 0.01 * plane.body.omega[0] * DEG),
    ),
  };
}

test("standard atmosphere: sea level, 2,000 m and the tropopause", () => {
  within(standardAir(0).density, 1.2249, 1.2251, "sea-level density");
  within(airDensity(2000), 1.006, 1.008, "density at 2,000 m");
  within(
    standardAir(11_000).temperature,
    216.6,
    216.7,
    "tropopause temperature",
  );
  within(airDensity(11_000), 0.363, 0.366, "density at 11 km");
});

test("the clean stall is near 49 kt and flaps lower it", () => {
  const clean = stallSpeed(0) / KNOT;
  const full = stallSpeed(30) / KNOT;
  within(clean, 46, 52, "clean stall, kt");
  within(full, 39, 45, "full-flap stall, kt");
  assert.ok(
    stallSpeed(10) < stallSpeed(0) &&
      stallSpeed(20) < stallSpeed(10) &&
      stallSpeed(30) < stallSpeed(20),
  );
  within(maxLift(0).cl, 1.5, 1.75, "clean CLmax");
  within(maxLift(0).alpha * DEG, 14, 17.5, "critical angle of attack, degrees");
});

test("lift breaks down past the critical angle instead of growing", () => {
  const peak = maxLift(0);
  const past = (deg: number) => wingLift(peak.alpha + deg * RAD, 0).cl;
  assert.ok(past(4) < peak.cl * 0.8, "clearly less lift 4° past the stall");
  assert.ok(past(10) < peak.cl * 0.7);
});

test("in a real stall the airplane sinks and the nose drops", () => {
  const { airplane } = airborneAirplane([0, 0, 1500], 0, 33);
  // Power off, ease the stick all the way back.
  run(airplane, 25, (t) =>
    holdPitch(airplane, 0, { ...NEUTRAL_CONTROLS, pitch: Math.min(1, t / 12) }),
  );
  let warned = false;
  let lowestPitch = 90;
  let fastestSink = 0;
  run(airplane, 15, () => {
    const d = flightData(airplane, FLAT);
    warned ||= d.stallWarning;
    lowestPitch = Math.min(lowestPitch, d.pitch);
    fastestSink = Math.min(fastestSink, d.climb);
    return { ...NEUTRAL_CONTROLS, pitch: 1 };
  });
  assert.ok(warned, "the stall warning sounded");
  assert.ok(fastestSink < -4, `sinking (${fastestSink.toFixed(1)} m/s)`);
  assert.ok(lowestPitch < 0, `the nose dropped (${lowestPitch.toFixed(1)}°)`);
  assert.equal(airplane.crashed, null);
});

test("thrust: static limit at rest, falling with speed and altitude", () => {
  within(thrust(targetRpm(1, 0), 0, 1.225), 2100, 2500, "static thrust, N");
  assert.ok(
    thrust(targetRpm(1, 60), 60, 1.225) < thrust(targetRpm(1, 30), 30, 1.225),
  );
  assert.ok(
    thrust(targetRpm(1, 40), 40, airDensity(3000)) <
      0.8 * thrust(targetRpm(1, 40), 40, 1.225),
  );
  assert.equal(thrust(TRAINER.idleRpm, 40, 1.225), 0);
});

test("trimmed level cruise holds altitude, speed and heading", () => {
  for (const [speed, altitude] of [
    [55, 1000],
    [45, 300],
    [58, 2400],
  ]) {
    const { airplane, trim } = airborneAirplane([0, 0, altitude], 70, speed);
    const controls = {
      ...NEUTRAL_CONTROLS,
      pitch: trim.elevator,
      throttle: trim.throttle,
    };
    let low = Infinity;
    let high = -Infinity;
    run(airplane, 90, () => {
      low = Math.min(low, airplane.body.position[2]);
      high = Math.max(high, airplane.body.position[2]);
      return controls;
    });
    const d = flightData(airplane, FLAT);
    within(
      high - altitude,
      -8,
      8,
      `highest above ${altitude} m at ${speed} m/s`,
    );
    within(low - altitude, -8, 8, `lowest below ${altitude} m at ${speed} m/s`);
    within(d.tas - speed, -1, 1, "speed drift, m/s");
    within(d.heading, 69.5, 70.5, "heading");
    within(Math.abs(d.roll), 0, 0.5, "bank");
  }
});

test("cruise needs sensible power: about 65–80 % for 107 kt at 1,000 m", () => {
  const trim = trimLevel(55, 1000);
  within(trim.throttle, 0.6, 0.9, "throttle");
  within(trim.alpha * DEG, -1, 3, "angle of attack, degrees");
});

test("full power level flight tops out around 120 kt at sea level", () => {
  assert.ok(trimLevel(58, 0).throttle < 1, "110 kt is within reach");
  assert.ok(trimLevel(68, 0).throttle > 0.999, "132 kt is not");
});

test("statically stable: a pitch disturbance dies out and the nose returns to trim", () => {
  const { airplane, trim } = airborneAirplane([0, 0, 1000], 0, 55);
  const controls = {
    ...NEUTRAL_CONTROLS,
    pitch: trim.elevator,
    throttle: trim.throttle,
  };
  // Kick the nose up 6°.
  airplane.body.orientation = qmul(
    airplane.body.orientation,
    qaxis([0, 1, 0], -6 * RAD),
  );
  run(airplane, 0.05, () => controls);
  assert.ok(airplane.alpha > trim.alpha + 4 * RAD, "disturbed");
  run(airplane, 4, () => controls);
  within(
    (airplane.alpha - trim.alpha) * DEG,
    -0.6,
    0.6,
    "angle of attack back at trim after the short period, degrees",
  );
  // The slow phugoid that follows is lightly damped but bounded.
  let low = Infinity;
  let high = -Infinity;
  run(airplane, 120, () => {
    low = Math.min(low, airplane.body.position[2]);
    high = Math.max(high, airplane.body.position[2]);
    return controls;
  });
  assert.ok(
    high - low < 120,
    `phugoid stays bounded (${(high - low).toFixed(0)} m)`,
  );
  assert.equal(airplane.crashed, null);
});

test("directionally stable: sideslip weathervanes away", () => {
  const { airplane, trim } = airborneAirplane([0, 0, 1000], 0, 55);
  const controls = {
    ...NEUTRAL_CONTROLS,
    pitch: trim.elevator,
    throttle: trim.throttle,
  };
  airplane.body.orientation = qmul(
    airplane.body.orientation,
    qaxis([0, 0, 1], 8 * RAD),
  );
  run(airplane, 0.05, () => controls);
  assert.ok(Math.abs(airplane.beta) > 5 * RAD, "slipping");
  run(airplane, 12, () => controls);
  within(Math.abs(airplane.beta) * DEG, 0, 1, "sideslip after 12 s, degrees");
});

test("controls work the right way round", () => {
  const fly = (input: Partial<AirplaneControls>, seconds = 1.5) => {
    const { airplane, trim } = airborneAirplane([0, 0, 1000], 0, 55);
    const base = {
      ...NEUTRAL_CONTROLS,
      pitch: trim.elevator,
      throttle: trim.throttle,
    };
    const start = toAttitude(airplane.body.orientation);
    run(airplane, seconds, () => ({
      ...base,
      ...input,
      pitch: base.pitch + (input.pitch ?? 0),
    }));
    const end = toAttitude(airplane.body.orientation);
    return {
      pitch: end.pitch - start.pitch,
      roll: end.roll - start.roll,
      heading: ((end.heading - start.heading + 540) % 360) - 180,
    };
  };
  assert.ok(fly({ pitch: 0.3 }).pitch > 3, "stick back raises the nose");
  assert.ok(fly({ pitch: -0.3 }).pitch < -3, "stick forward lowers it");
  assert.ok(fly({ roll: 0.4 }).roll > 15, "stick right rolls right");
  assert.ok(fly({ roll: -0.4 }).roll < -15, "stick left rolls left");
  assert.ok(fly({ yaw: 0.6 }, 1).heading > 1.5, "right rudder yaws right");
  assert.ok(fly({ yaw: -0.6 }, 1).heading < -1.5, "left rudder yaws left");
});

test("a banked turn turns the way it banks", () => {
  const { airplane, trim } = airborneAirplane([0, 0, 1000], 0, 55);
  const base = {
    ...NEUTRAL_CONTROLS,
    throttle: Math.min(1, trim.throttle + 0.1),
  };
  run(airplane, 20, () => {
    const { roll } = toAttitude(airplane.body.orientation);
    return assist(
      {
        ...holdPitch(airplane, 3, { ...base, pitch: trim.elevator }),
        roll: 0.03 * (30 - roll),
      },
      airplane,
    );
  });
  const d = flightData(airplane, FLAT);
  within(d.roll, 22, 38, "bank held, degrees");
  assert.ok(
    d.heading > 40 && d.heading < 200,
    `turned right (heading ${d.heading.toFixed(0)}°)`,
  );
  within(
    Math.abs(airplane.beta) * DEG,
    0,
    2.5,
    "coordinated by the assist, degrees of sideslip",
  );
});

test("assist: a pulled stick holds the bank; only the centred stick levels the wings", () => {
  const banked = () => {
    const { airplane, trim } = airborneAirplane([0, 0, 1000], 0, 55);
    const base = { ...NEUTRAL_CONTROLS, throttle: trim.throttle };
    // Roll left to about 30° and stop the roll.
    run(airplane, 6, () => {
      const { roll } = toAttitude(airplane.body.orientation);
      return assist(
        { ...base, roll: clamp(0.03 * (-30 - roll), -0.5, 0.5) },
        airplane,
      );
    });
    return { airplane, base };
  };
  // Ailerons centred, stick pulled back: the turn goes on.
  const pulled = banked();
  run(pulled.airplane, 4, () =>
    assist({ ...pulled.base, roll: 0, pitch: 0.3 }, pulled.airplane),
  );
  const pulledRoll = toAttitude(pulled.airplane.body.orientation).roll;
  assert.ok(
    pulledRoll < -20,
    `bank held while pulling (${pulledRoll.toFixed(0)}°)`,
  );
  // Stick at the centre point: the wings come level.
  const centred = banked();
  run(centred.airplane, 8, () => assist({ ...centred.base }, centred.airplane));
  const centredRoll = toAttitude(centred.airplane.body.orientation).roll;
  assert.ok(
    Math.abs(centredRoll) < 10,
    `levelled (${centredRoll.toFixed(0)}°)`,
  );
});

test("sea-level climb at full power and 76 kt is 600–900 ft/min", () => {
  const { airplane, trim } = airborneAirplane([0, 0, 100], 0, 76 * KNOT);
  let target = 7;
  const fly = () => {
    // Pitch for airspeed, as a pilot does in a climb.
    target += 0.4 * (airplane.airspeed / KNOT - 76) * STEP;
    return holdPitch(airplane, Math.max(0, Math.min(15, target)), {
      ...NEUTRAL_CONTROLS,
      throttle: 1,
      pitch: trim.elevator,
    });
  };
  run(airplane, 40, fly);
  const from = airplane.body.position[2];
  run(airplane, 60, fly);
  const feetPerMinute = (airplane.body.position[2] - from) / FOOT;
  within(airplane.airspeed / KNOT, 72, 80, "climb speed, kt");
  within(feetPerMinute, 600, 900, "rate of climb, ft/min");
});

test("climb is weaker up high: thinner air, less power", () => {
  const rate = (altitude: number) => {
    const { airplane, trim } = airborneAirplane([0, 0, altitude], 0, 40);
    let target = 6;
    const fly = () => {
      target += 0.4 * (flightData(airplane, FLAT).ias / KNOT - 76) * STEP;
      return holdPitch(airplane, Math.max(-2, Math.min(15, target)), {
        ...NEUTRAL_CONTROLS,
        throttle: 1,
        pitch: trim.elevator,
      });
    };
    run(airplane, 40, fly);
    const from = airplane.body.position[2];
    run(airplane, 30, fly);
    return ((airplane.body.position[2] - from) / FOOT) * 2;
  };
  const low = rate(100);
  const high = rate(2500);
  assert.ok(
    high < 0.75 * low,
    `climb at 2,500 m (${high.toFixed(0)}) well below sea level (${low.toFixed(0)})`,
  );
  assert.ok(high > 100, "but still climbing");
});

test("parked with the brakes set it sits still on its three wheels", () => {
  const plane = parkedAirplane(10, 20, 300, 135);
  const env: Environment = { ground: () => 300, wind: CALM };
  run(plane, 20, () => ({ ...NEUTRAL_CONTROLS, brake: 1 }), env);
  assert.equal(plane.crashed, null);
  assert.equal(plane.wheelsDown, 3);
  within(plane.body.position[0], 9.95, 10.05, "east");
  within(plane.body.position[1], 19.95, 20.05, "north");
  within(
    plane.body.position[2] - 300,
    PARKED_HEIGHT - 0.05,
    PARKED_HEIGHT + 0.05,
    "height of the centre of gravity",
  );
  const attitude = toAttitude(plane.body.orientation);
  within(attitude.heading, 134.9, 135.1, "heading");
  within(Math.abs(attitude.pitch), 0, 1.5, "pitch");
  within(Math.hypot(...plane.body.velocity), 0, 0.01, "speed");
});

test("brakes hold against idle and stop a rolling airplane; full power overcomes nothing but time", () => {
  const plane = parkedAirplane(0, 0, 0, 0);
  run(plane, 3, () => ({ ...NEUTRAL_CONTROLS, brake: 1 }));
  run(plane, 8, () => ({ ...NEUTRAL_CONTROLS, throttle: 0.6 }));
  const rolling = plane.body.velocity[1];
  assert.ok(rolling > 5, `rolling at ${rolling.toFixed(1)} m/s`);
  run(plane, 10, () => ({ ...NEUTRAL_CONTROLS, brake: 1 }));
  within(
    Math.abs(plane.body.velocity[1]),
    0,
    0.2,
    "stopped by the brakes, m/s",
  );
});

test("takeoff roll at sea level is 200–350 m, lifting off near 55–65 kt", () => {
  const plane = parkedAirplane(0, 0, 0, 0);
  run(plane, 3, () => ({ ...NEUTRAL_CONTROLS, brake: 1 }));
  let liftoff: { distance: number; speed: number; seconds: number } | null =
    null;
  for (let t = 0; t < 60 && !liftoff; t += STEP) {
    const rotate = plane.airspeed > 55 * KNOT;
    stepAirplane(
      plane,
      { ...NEUTRAL_CONTROLS, throttle: 1, pitch: rotate ? 0.4 : 0 },
      FLAT,
      STEP,
    );
    assert.equal(plane.crashed, null);
    if (
      plane.wheelsDown === 0 &&
      plane.body.position[2] > PARKED_HEIGHT + 0.3
    ) {
      liftoff = {
        distance: plane.body.position[1],
        speed: plane.airspeed / KNOT,
        seconds: t,
      };
    }
  }
  assert.ok(liftoff, "it took off");
  within(liftoff.distance, 200, 350, "ground roll, m");
  within(liftoff.speed, 55, 65, "liftoff speed, kt");
  within(Math.abs(plane.body.position[0]), 0, 1, "stayed on the centreline, m");
});

test("rudder steers on the ground", () => {
  const plane = parkedAirplane(0, 0, 0, 0);
  run(plane, 2, () => ({ ...NEUTRAL_CONTROLS, brake: 1 }));
  run(plane, 10, () => ({ ...NEUTRAL_CONTROLS, throttle: 0.35, yaw: 0.6 }));
  const { heading } = toAttitude(plane.body.orientation);
  assert.ok(
    heading > 20 && heading < 340 && plane.body.position[0] > 2,
    `turned right (heading ${heading.toFixed(0)}°)`,
  );
  assert.equal(plane.crashed, null);
});

test("a gentle landing is fine, a hard one or a wing strike is a crash", () => {
  const land = (sink: number, roll = 0) => {
    const plane = parkedAirplane(0, 0, 0, 0);
    plane.body.position[2] = PARKED_HEIGHT + 0.6;
    plane.body.velocity = [0, 30, -sink];
    plane.body.orientation = fromAttitude({ heading: 0, pitch: 4, roll });
    plane.airspeed = 30;
    run(plane, 3, () => ({ ...NEUTRAL_CONTROLS }));
    return plane.crashed;
  };
  assert.equal(land(1), null);
  assert.equal(land(2.5), null);
  assert.equal(land(MAX_TOUCHDOWN_SINK + 1.5)?.cause, "hard-landing");
  assert.equal(land(1, 35)?.cause, "structure");
});

test("flying into the ground nose first is a crash", () => {
  const { airplane } = airborneAirplane([0, 0, 60], 0, 50);
  run(airplane, 10, () => ({ ...NEUTRAL_CONTROLS, pitch: -0.5 }));
  assert.equal(airplane.crashed?.cause, "structure");
});

test("wind: the airplane drifts with the air mass and keeps its airspeed", () => {
  const wind = windVector(270, 10); // from the west: blows east
  assert.ok(wind[0] > 9.99 && Math.abs(wind[1]) < 1e-9);
  const { airplane, trim } = airborneAirplane([0, 0, 1000], 0, 55, wind);
  const env: Environment = { ground: () => 0, wind };
  run(
    airplane,
    30,
    () => ({
      ...NEUTRAL_CONTROLS,
      pitch: trim.elevator,
      throttle: trim.throttle,
    }),
    env,
  );
  within(airplane.body.position[0], 280, 320, "blown east, m");
  within(airplane.airspeed, 54, 56, "airspeed, m/s");
});
