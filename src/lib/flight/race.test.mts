/** pnpm test — air-race rules: gate crossing, the race clock, penalties, ghosts, screen direction. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { eyeMatrix } from "./camera.ts";
import {
  COUNTDOWN,
  type Gate,
  GHOST_HZ,
  GhostRecorder,
  gateCrossing,
  headingVector,
  MISSED_PENALTY,
  medalFor,
  newRace,
  type Race,
  sampleGhost,
  screenPoint,
  splitTimes,
  stepRace,
} from "./race.ts";
import { IDENTITY, type Vec3 } from "./vec.ts";

const close = (a: number, b: number, tolerance: number, what = "") =>
  assert.ok(
    Math.abs(a - b) <= tolerance,
    `${what} ${a} vs ${b} ± ${tolerance}`,
  );

/** A gate facing north at y = north, x = east. */
const gateAt = (east: number, north: number, up = 100, radius = 20): Gate => ({
  center: [east, north, up],
  normal: headingVector(0),
  radius,
});

test("crossing: through the middle, inside the ring", () => {
  const c = gateCrossing([0, -5, 100], [0, 5, 100], gateAt(0, 0));
  assert.ok(c);
  close(c.t, 0.5, 1e-12, "t");
  close(c.distance, 0, 1e-12, "distance");
});

test("crossing: a fast pass is caught between two steps", () => {
  // 300 m in one step: both ends far from the ring, the segment through it.
  const c = gateCrossing([3, -150, 104], [3, 150, 104], gateAt(0, 0));
  assert.ok(c);
  close(c.distance, 5, 1e-9, "distance");
});

test("crossing: the wrong way does not count", () => {
  assert.equal(gateCrossing([0, 5, 100], [0, -5, 100], gateAt(0, 0)), null);
});

test("crossing: not reaching the plane does not count", () => {
  assert.equal(gateCrossing([0, -10, 100], [0, -1, 100], gateAt(0, 0)), null);
});

test("crossing: a near miss reports its distance", () => {
  const c = gateCrossing([21, -1, 100], [21, 1, 100], gateAt(0, 0));
  assert.ok(c);
  assert.ok(c.distance > 20, "outside the ring");
});

test("crossing: ending exactly on the plane counts once, the next step does not count again", () => {
  const gate = gateAt(0, 0);
  assert.ok(gateCrossing([0, -1, 100], [0, 0, 100], gate));
  assert.equal(gateCrossing([0, 0, 100], [0, 1, 100], gate), null);
});

const COURSE = [gateAt(0, 100), gateAt(0, 200), gateAt(0, 300)];

/** Fly straight north at `speed` m/s along x = east, z = up, until `seconds` have passed. */
function fly(
  race: Race,
  gates: Gate[],
  seconds: number,
  from: Vec3,
  speed: number,
  dt = 1 / 120,
) {
  let p: Vec3 = [...from];
  const events = [];
  for (let t = 0; t < seconds; t += dt) {
    const q: Vec3 =
      race.phase === "countdown" ? p : [p[0], p[1] + speed * dt, p[2]];
    events.push(...stepRace(race, gates, p, q, dt));
    p = q;
  }
  return { events, position: p };
}

test("race: countdown, then the clock starts at zero", () => {
  const race = newRace(COURSE.length);
  assert.equal(race.phase, "countdown");
  close(race.time, -COUNTDOWN, 1e-12);
  const { events } = fly(race, COURSE, COUNTDOWN + 0.01, [0, 0, 100], 50);
  assert.equal(race.phase, "racing");
  assert.ok(events.some((e) => e.type === "start"));
});

test("race: clean run, split times interpolated inside the step", () => {
  const race = newRace(COURSE.length);
  race.phase = "racing";
  race.time = 0;
  // 50 m/s from y = 0: gates at 2, 4 and 6 s.
  const { events } = fly(race, COURSE, 7, [0, 0, 100], 50);
  assert.equal(race.phase, "finished");
  const splits = splitTimes(race);
  close(splits[0]!, 2, 1e-6, "gate 1");
  close(splits[1]!, 4, 1e-6, "gate 2");
  close(splits[2]!, 6, 1e-6, "gate 3");
  close(race.total!, 6, 1e-6, "total");
  assert.equal(events.filter((e) => e.type === "gate").length, 3);
  assert.ok(events.some((e) => e.type === "finish"));
});

test("race: flying beside a gate misses it and adds the penalty", () => {
  const gates = [gateAt(0, 100), gateAt(60, 200), gateAt(0, 300)];
  const race = newRace(gates.length);
  race.phase = "racing";
  race.time = 0;
  fly(race, gates, 7, [0, 0, 100], 50);
  assert.equal(race.phase, "finished");
  assert.deepEqual(
    race.results.map((r) => r?.passed),
    [true, false, true],
  );
  close(race.penalty, MISSED_PENALTY, 1e-12);
  close(race.total!, 6 + MISSED_PENALTY, 1e-6);
});

test("race: going round a gate entirely (never crossing its plane near it) is caught by passing the next one", () => {
  // Gate 2 is far off to the side: its plane is crossed far outside, so it is
  // not an attempt; passing gate 3 then counts gate 2 as missed.
  const gates = [gateAt(0, 100), gateAt(2000, 200), gateAt(0, 300)];
  const race = newRace(gates.length);
  race.phase = "racing";
  race.time = 0;
  fly(race, gates, 7, [0, 0, 100], 50);
  assert.deepEqual(
    race.results.map((r) => r?.passed),
    [true, false, true],
  );
  assert.equal(race.phase, "finished");
});

test("race: nothing changes after the finish", () => {
  const race = newRace(COURSE.length);
  race.phase = "racing";
  race.time = 0;
  fly(race, COURSE, 7, [0, 0, 100], 50);
  const total = race.total;
  const { events } = fly(race, COURSE, 2, [0, 0, 100], 50);
  assert.equal(events.length, 0);
  assert.equal(race.total, total);
});

test("medals by total time", () => {
  const targets = { gold: 60, silver: 70, bronze: 85 };
  assert.equal(medalFor(59, targets), "gold");
  assert.equal(medalFor(65, targets), "silver");
  assert.equal(medalFor(85, targets), "bronze");
  assert.equal(medalFor(90, targets), null);
});

test("ghost: records at the set rate and interpolates between samples", () => {
  const recorder = new GhostRecorder();
  for (let t = 0; t <= 1.0001; t += 1 / 120) {
    recorder.sample(t, {
      lng: 50 + t * 0.001,
      lat: 30,
      altitude: 100 + t * 10,
      orientation: IDENTITY,
    });
  }
  close(recorder.frames.length, GHOST_HZ + 1, 1, "samples in one second");
  const mid = sampleGhost(recorder.frames, 0.55)!;
  close(mid.altitude, 105.5, 0.15, "altitude");
  close(mid.lng, 50.00055, 6e-6, "lng");
  assert.equal(sampleGhost(recorder.frames, -1), null);
  assert.equal(sampleGhost(recorder.frames, 5), null);
});

test("screen point: ahead is centred, off to the side points that way, behind never reads as ahead", () => {
  // Camera looking north at the horizon.
  const eye = eyeMatrix({ bearing: 0, pitch: 90, roll: 0 });
  const ahead = screenPoint(eye, [0, 1000, 0], 40, 16 / 9);
  assert.ok(ahead.visible);
  close(ahead.x, 0, 1e-9);
  close(ahead.y, 0, 1e-9);

  const right = screenPoint(eye, [1000, 10, 0], 40, 16 / 9);
  assert.equal(right.visible, false);
  close(right.angle, 0, 0.05, "points right");

  const behindLeft = screenPoint(eye, [-200, -1000, 0], 40, 16 / 9);
  assert.equal(behindLeft.visible, false);
  assert.ok(Math.cos(behindLeft.angle) < 0, "points left");
  close(behindLeft.distance, Math.hypot(200, 1000), 1e-9);
});
