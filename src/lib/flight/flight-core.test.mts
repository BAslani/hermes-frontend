/** pnpm test — the maths under the flight models: vectors, frames, stepping, cameras, runways, pilot inputs. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NEUTRAL_CONTROLS } from "./airplane.ts";
import {
  applyMat3,
  chaseCamera,
  cockpitCamera,
  eyeMatrix,
  type Mat3,
  mapAngles,
  newOrbit,
  orbitCamera,
} from "./camera.ts";
import { type ContactPoint, contactForces } from "./contact.ts";
import { needsRebase, rangeAndBearing, toLngLat, toLocal } from "./frame.ts";
import {
  controlsFrom,
  type HeldKeys,
  moveStick,
  newPilot,
  PILOT,
  shaped,
  stepFlaps,
  updatePilot,
} from "./pilot.ts";
import {
  FixedStep,
  integrateBody,
  interpolatePose,
  type RigidBody,
  STEP,
} from "./rigid-body.ts";
import { findRunway, lineUp } from "./runway.ts";
import {
  fromAttitude,
  IDENTITY,
  length,
  qaxis,
  qmul,
  RAD,
  rotate,
  sub,
  toAttitude,
  unrotate,
  type Vec3,
} from "./vec.ts";

const close = (a: number, b: number, tolerance: number, what = "") =>
  assert.ok(
    Math.abs(a - b) <= tolerance,
    `${what} ${a} vs ${b} ± ${tolerance}`,
  );
const closeVec = (a: Vec3, b: Vec3, tolerance: number, what = "") =>
  a.forEach((x, i) => close(x, b[i], tolerance, `${what}[${i}]`));

test("attitude ↔ quaternion: axes point where they should", () => {
  closeVec(
    rotate(IDENTITY, [1, 0, 0]),
    [1, 0, 0],
    1e-12,
    "identity nose is east",
  );
  const north = fromAttitude({ heading: 0, pitch: 0, roll: 0 });
  closeVec(rotate(north, [1, 0, 0]), [0, 1, 0], 1e-12, "nose north");
  closeVec(rotate(north, [0, 1, 0]), [-1, 0, 0], 1e-12, "left wing west");
  const climbing = fromAttitude({ heading: 90, pitch: 10, roll: 0 });
  assert.ok(rotate(climbing, [1, 0, 0])[2] > 0.17, "pitch up raises the nose");
  const banked = fromAttitude({ heading: 0, pitch: 0, roll: 30 });
  assert.ok(
    rotate(banked, [0, 1, 0])[2] > 0.49,
    "right roll raises the left wing",
  );
});

test("attitude round trip", () => {
  for (const a of [
    { heading: 0, pitch: 0, roll: 0 },
    { heading: 273, pitch: 12, roll: -35 },
    { heading: 45.5, pitch: -20, roll: 60 },
    { heading: 180, pitch: 5, roll: 120 },
  ]) {
    const back = toAttitude(fromAttitude(a));
    close(back.heading, a.heading, 1e-9, "heading");
    close(back.pitch, a.pitch, 1e-9, "pitch");
    close(back.roll, a.roll, 1e-9, "roll");
  }
});

test("rotate and unrotate are inverses; products compose", () => {
  const q = qmul(qaxis([0, 0, 1], 0.7), qaxis([1, 0, 0], -1.1));
  const v: Vec3 = [3, -2, 5];
  closeVec(unrotate(q, rotate(q, v)), v, 1e-12);
  closeVec(
    rotate(q, v),
    rotate(qaxis([0, 0, 1], 0.7), rotate(qaxis([1, 0, 0], -1.1), v)),
    1e-12,
  );
  close(length(rotate(q, v)), length(v), 1e-12);
});

test("local frame ↔ lng/lat round trip is exact to well under a millimetre", () => {
  const origin: [number, number] = [51.3, 35.7];
  for (const [east, north] of [
    [0, 0],
    [1234.5678, -9876.5432],
    [-19_000, 19_000],
    [0.001, 0.002],
  ]) {
    const [e, n] = toLocal(origin, toLngLat(origin, east, north));
    close(e, east, 1e-6, "east");
    close(n, north, 1e-6, "north");
  }
  // One degree of latitude is 111.2 km; of longitude, that times cos(latitude).
  close(toLocal(origin, [51.3, 36.7])[1], 111_195, 1);
  close(toLocal(origin, [52.3, 35.7])[0], 111_195 * Math.cos(35.7 * RAD), 1);
  const there = rangeAndBearing(origin, toLngLat(origin, 3000, 4000));
  close(there.distance, 5000, 1e-6);
  close(there.bearing, 36.8699, 1e-3);
  assert.equal(needsRebase(15_000, 10_000), false);
  assert.equal(needsRebase(15_000, 15_000), true);
});

test("moving the origin leaves the position on the map where it was", () => {
  const origin: [number, number] = [51.3, 35.7];
  const at = toLngLat(origin, 21_000, -4000);
  const moved = toLngLat(at, 0, 0);
  close(moved[0], at[0], 1e-12);
  close(moved[1], at[1], 1e-12);
  // A point 100 m further east is 100 m east of the new origin too (to the projection's 0.3 %).
  const further = toLngLat(origin, 21_100, -4000);
  close(toLocal(at, further)[0], 100, 0.3);
});

test("a free body falls 4.9 m in the first second and keeps spinning", () => {
  const body: RigidBody = {
    position: [0, 0, 100],
    velocity: [10, 0, 0],
    orientation: IDENTITY,
    omega: [0, 0, 1],
  };
  const mass = { mass: 2, inertia: [1, 1, 1] as Vec3 };
  for (let i = 0; i < 120; i++)
    integrateBody(body, mass, [0, 0, -2 * 9.80665], [0, 0, 0], STEP);
  close(body.position[2], 100 - 4.903, 0.05, "height");
  close(body.position[0], 10, 1e-9, "distance");
  close(
    toAttitude(body.orientation).heading,
    90 - 180 / Math.PI,
    0.01,
    "turned one radian to the left",
  );
});

test("the fixed step runs at 120 Hz whatever the frame rate", () => {
  for (const fps of [30, 60, 144]) {
    const loop = new FixedStep();
    let steps = 0;
    let alpha = 0;
    for (let i = 0; i < fps * 2; i++)
      alpha = loop.advance(1 / fps, () => steps++);
    assert.ok(
      Math.abs(steps - 240) <= 1,
      `${steps} steps in 2 s at ${fps} fps`,
    );
    assert.ok(alpha >= 0 && alpha < 1);
  }
  // A long stall does not turn into a burst of hundreds of steps.
  const loop = new FixedStep();
  let steps = 0;
  loop.advance(5, () => steps++);
  assert.ok(steps <= 12);
});

test("interpolation sits between two steps", () => {
  const a: RigidBody = {
    position: [0, 0, 0],
    velocity: [0, 0, 0],
    orientation: fromAttitude({ heading: 10, pitch: 0, roll: 0 }),
    omega: [0, 0, 0],
  };
  const b: RigidBody = {
    ...a,
    position: [2, 4, 6],
    orientation: fromAttitude({ heading: 20, pitch: 0, roll: 0 }),
  };
  const mid = interpolatePose(a, b, 0.5);
  closeVec(mid.position, [1, 2, 3], 1e-12);
  close(toAttitude(mid.orientation).heading, 15, 0.01);
});

test("a wheel carries load only when compressed, and the ground never pulls", () => {
  const wheel: ContactPoint = {
    name: "w",
    position: [0, 0, -1],
    kind: "wheel",
    stiffness: 10_000,
    damping: 1000,
    friction: 0.02,
    sideFriction: 0.7,
  };
  const body = (z: number, vz = 0): RigidBody => ({
    position: [0, 0, z],
    velocity: [0, 0, vz],
    orientation: IDENTITY,
    omega: [0, 0, 0],
  });
  const ground = () => 0;
  const input = { steer: 0, brake: 0 };
  assert.equal(contactForces(body(1.2), [wheel], ground, input).loads[0], 0);
  close(
    contactForces(body(0.9), [wheel], ground, input).force[2],
    1000,
    1e-6,
    "spring",
  );
  assert.ok(
    contactForces(body(0.9, -1), [wheel], ground, input).force[2] > 1900,
    "damper adds on the way down",
  );
  assert.equal(
    contactForces(body(0.99, 5), [wheel], ground, input).force[2],
    0,
    "rebounding fast: no suction",
  );
  // Sliding sideways (north, with the nose east) meets far more friction than rolling.
  const sideways = contactForces(
    { ...body(0.9), velocity: [0, 3, 0] },
    [wheel],
    ground,
    input,
  ).force;
  const rolling = contactForces(
    { ...body(0.9), velocity: [3, 0, 0] },
    [wheel],
    ground,
    input,
  ).force;
  assert.ok(sideways[1] < -600 && Math.abs(rolling[0]) < 30);
});

/** MapLibre's view rotation written out literally, to check the closed form against. */
function literalEyeMatrix(bearing: number, pitch: number, roll: number): Mat3 {
  const mul = (a: number[][], b: number[][]) =>
    a.map((row) =>
      b[0].map((_, j) => row.reduce((s, x, k) => s + x * b[k][j], 0)),
    );
  const rz = (t: number) => [
    [Math.cos(t), -Math.sin(t), 0],
    [Math.sin(t), Math.cos(t), 0],
    [0, 0, 1],
  ];
  const rx = (t: number) => [
    [1, 0, 0],
    [0, Math.cos(t), -Math.sin(t)],
    [0, Math.sin(t), Math.cos(t)],
  ];
  const flipY = [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, 1],
  ];
  // scale(1,-1,1) · rotateZ(-roll) · rotateX(pitch) · rotateZ(-bearing), on (east, south, up).
  const m = mul(
    mul(mul(mul(flipY, rz(-roll * RAD)), rx(pitch * RAD)), rz(-bearing * RAD)),
    flipY,
  );
  return m.flat() as Mat3;
}

test("the eye matrix matches MapLibre's view rotation", () => {
  for (const [b, p, r] of [
    [0, 0, 0],
    [0, 90, 0],
    [37, 62, 0],
    [215, 95, 18],
    [300, 130, -40],
  ]) {
    const ours = eyeMatrix({ bearing: b, pitch: p, roll: r });
    literalEyeMatrix(b, p, r).forEach((x, i) =>
      close(ours[i], x, 1e-12, `m[${i}] at ${b}/${p}/${r}`),
    );
  }
  // Level, looking north: east is right, up is up, north is into the screen.
  const m = eyeMatrix({ bearing: 0, pitch: 90, roll: 0 });
  closeVec(applyMat3(m, [1, 0, 0]), [1, 0, 0], 1e-12);
  closeVec(applyMat3(m, [0, 0, 1]), [0, 1, 0], 1e-12);
  closeVec(applyMat3(m, [0, 1, 0]), [0, 0, -1], 1e-12);
});

test("map angles reproduce the camera they came from", () => {
  for (const attitude of [
    { heading: 0, pitch: 0, roll: 0 },
    { heading: 123, pitch: 14, roll: 25 },
    { heading: 301, pitch: -30, roll: -70 },
    { heading: 45, pitch: 60, roll: 10 },
  ]) {
    const q = fromAttitude(attitude);
    const pose = cockpitCamera([0, 0, 0], q);
    const angles = mapAngles(pose.forward, pose.up);
    const m = eyeMatrix(angles);
    closeVec(
      applyMat3(m, pose.forward),
      [0, 0, -1],
      1e-9,
      "forward is into the screen",
    );
    closeVec(applyMat3(m, pose.up), [0, 1, 0], 1e-9, "up is up");
    close(angles.pitch, 90 + attitude.pitch, 1e-9, "pitch");
    close(
      ((angles.bearing - attitude.heading + 540) % 360) - 180,
      0,
      1e-9,
      "bearing",
    );
    close(angles.roll, attitude.roll, 1e-9, "roll: banking right is positive");
  }
});

test("chase camera sits behind and above, lags, and stays out of the ground", () => {
  const state = { position: [0, 0, 0] as Vec3, ready: false };
  const q = fromAttitude({ heading: 0, pitch: 20, roll: 45 });
  const flat = () => 0;
  const first = chaseCamera(state, [0, 0, 500], q, 1 / 60, flat);
  assert.ok(
    first.position[1] < -10 && first.position[2] > 502,
    "behind (south) and above",
  );
  closeVec(first.up, [0, 0, 1], 0, "horizon stays level");
  assert.ok(first.forward[1] > 0.9, "looking north at the aircraft");
  const next = chaseCamera(state, [0, 60, 500], q, 1 / 60, flat);
  const lag = sub([0, 60 - 14, 503.6], next.position)[1];
  assert.ok(lag > 40, "one frame later it has not caught up");
  for (let i = 0; i < 300; i++)
    chaseCamera(state, [0, 60, 500], q, 1 / 60, flat);
  close(state.position[1], 46, 0.01, "settles behind");
  const low = chaseCamera(
    { position: [0, 0, 0], ready: false },
    [0, 0, 1],
    q,
    1 / 60,
    () => 4,
  );
  assert.ok(low.position[2] >= 5.2 - 1e-9, "kept above the ground");
});

test("orbit camera looks at the aircraft from the chosen side", () => {
  const orbit = newOrbit();
  orbit.azimuth = 90;
  orbit.elevation = 0;
  const pose = orbitCamera(orbit, [100, 200, 300], () => 0);
  closeVec(pose.position, [100 + orbit.distance, 200, 300], 1e-9);
  closeVec(pose.forward, [-1, 0, 0], 1e-9);
});

const LINES = [
  // Mehrabad 11L/29R and 11R/29L from the 141 basemap (z14 tile 10527/6451), the second cut in two.
  {
    ref: "11L/29R",
    points: [
      [51.32847, 35.68606],
      [51.32745, 35.68635],
      [51.32151, 35.68809],
      [51.30923, 35.69168],
      [51.30581, 35.69267],
    ] as [number, number][],
  },
  {
    ref: "11R/29L",
    points: [
      [51.30581, 35.69053],
      [51.318, 35.68696],
    ] as [number, number][],
  },
  {
    ref: "11R/29L",
    points: [
      [51.318, 35.68696],
      [51.32847, 35.6839],
    ] as [number, number][],
  },
  {
    points: [
      [51.31438, 35.68479],
      [51.31462, 35.68795],
    ] as [number, number][],
  }, // a taxiway-like stub
];

test("runway finder joins tile-cut pieces and ignores the parallel runway", () => {
  const south = findRunway(LINES, [51.317, 35.6865]);
  assert.ok(south);
  assert.equal(south.ref, "11R/29L");
  close(south.length, 2190, 40, "length of the joined pieces, m");
  close(
    Math.min(south.heading, (south.heading + 180) % 360),
    109.8,
    1.5,
    "runway 11/29",
  );
  const north = findRunway(LINES, [51.317, 35.6895]);
  assert.equal(north?.ref, "11L/29R");
  assert.equal(findRunway(LINES, [52.5, 35.7]), null, "nothing within reach");
  assert.equal(
    findRunway([LINES[3]], [51.3145, 35.686]),
    null,
    "a 350 m stub is not a runway",
  );
});

test("line-up: into the wind, or westward in calm", () => {
  const runway = findRunway(LINES, [51.317, 35.6865])!;
  const calm = lineUp(runway);
  close(calm.heading, 289.8, 1.5, "runway 29 in calm");
  assert.ok(calm.position[0] > 51.327, "at the east end");
  const easterly = lineUp(runway, 100, 8);
  close(easterly.heading, 109.8, 1.5, "runway 11 with wind from the east");
  assert.ok(easterly.position[0] < 51.307, "at the west end");
});

const NO_KEYS: HeldKeys = {
  throttleUp: false,
  throttleDown: false,
  rudderLeft: false,
  rudderRight: false,
  trimUp: false,
  trimDown: false,
  brake: false,
};

test("mouse yoke: deflects, has a deadzone, clamps, and springs back only when asked", () => {
  const pilot = newPilot({ parkingBrake: false });
  moveStick(pilot, 5, 0);
  assert.equal(controlsFrom(pilot, NO_KEYS).roll, 0, "inside the deadzone");
  moveStick(pilot, 195, 120);
  const c = controlsFrom(pilot, NO_KEYS);
  assert.ok(c.roll > 0.45 && c.roll < 0.5, `roll right (${c.roll})`);
  assert.ok(c.pitch > 0.25, "pulling back raises the nose");
  moveStick(pilot, 5000, -5000);
  assert.equal(controlsFrom(pilot, NO_KEYS).roll, 1);
  assert.equal(controlsFrom(pilot, NO_KEYS).pitch, -1);
  close(shaped(1), 1, 1e-12);

  for (let i = 0; i < 120; i++) updatePilot(pilot, NO_KEYS, STEP, false);
  assert.equal(pilot.stickX, 1, "stays put without self-centring");
  for (let i = 0; i < 360; i++) updatePilot(pilot, NO_KEYS, STEP, true);
  assert.ok(Math.abs(pilot.stickX) < PILOT.deadzone, "springs back with it");
});

test("keys: rudder ramps and returns, throttle and trim hold, flaps step, brakes", () => {
  const pilot = newPilot();
  assert.equal(
    controlsFrom(pilot, NO_KEYS).brake,
    1,
    "starts with the parking brake set",
  );
  pilot.parkingBrake = false;
  assert.equal(controlsFrom(pilot, NO_KEYS).brake, 0);
  assert.equal(controlsFrom(pilot, { ...NO_KEYS, brake: true }).brake, 1);

  for (let i = 0; i < 12; i++)
    updatePilot(
      pilot,
      { ...NO_KEYS, rudderRight: true, throttleUp: true, trimUp: true },
      STEP,
      false,
    );
  assert.ok(
    pilot.rudder > 0.2 && pilot.rudder < 0.4,
    "rudder still travelling after 0.1 s",
  );
  for (let i = 0; i < 240; i++)
    updatePilot(
      pilot,
      { ...NO_KEYS, rudderRight: true, throttleUp: true, trimUp: true },
      STEP,
      false,
    );
  assert.equal(pilot.rudder, 1);
  assert.equal(pilot.throttle, 1);
  assert.ok(pilot.trim > 0.3);
  const trim = pilot.trim;
  for (let i = 0; i < 120; i++) updatePilot(pilot, NO_KEYS, STEP, false);
  assert.equal(pilot.rudder, 0, "rudder returns");
  assert.equal(pilot.throttle, 1, "throttle stays");
  assert.equal(pilot.trim, trim, "trim stays");

  stepFlaps(pilot, 1);
  stepFlaps(pilot, 1);
  assert.equal(controlsFrom(pilot, NO_KEYS).flaps, 2);
  for (let i = 0; i < 5; i++) stepFlaps(pilot, 1);
  assert.equal(pilot.flaps, 3);
  for (let i = 0; i < 5; i++) stepFlaps(pilot, -1);
  assert.equal(pilot.flaps, 0);
  assert.deepEqual(
    Object.keys(controlsFrom(pilot, NO_KEYS)).sort(),
    Object.keys(NEUTRAL_CONTROLS).sort(),
  );
});
