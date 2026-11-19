/** pnpm test — the building storm and the avalanche. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  moving,
  overruns,
  releaseAvalanche,
  stepAvalanche,
} from "./avalanche.ts";
import {
  gust,
  type StormSpec,
  stormStrength,
  stormWind,
  visibility,
} from "./weather.ts";

const STORM: StormSpec = {
  startWind: 4,
  fullWind: 16,
  from: 300,
  veer: 40,
  buildUp: 240,
  gustiness: 0.35,
  seed: 7,
};
const within = (value: number, lo: number, hi: number, what: string) =>
  assert.ok(
    value >= lo && value <= hi,
    `${what}: ${value.toFixed(2)} not in ${lo}…${hi}`,
  );

test("storm: builds from a breeze to a gale, and stays there", () => {
  assert.equal(stormStrength(STORM, 0), 0);
  assert.equal(stormStrength(STORM, 240), 1);
  assert.equal(stormStrength(STORM, 1000), 1);
  const calm = Math.hypot(...stormWind(STORM, 0));
  within(calm, 3.9, 4.1, "start wind (no gusts yet)");
  let sum = 0;
  for (let t = 300; t < 900; t += 0.5)
    sum += Math.hypot(...stormWind(STORM, t));
  within(sum / 1200, 13, 19, "mean wind at full strength");
});

test("storm: gusts stay within their share and are repeatable", () => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let t = 300; t < 2000; t += 0.25) {
    const g = gust(STORM, t);
    lo = Math.min(lo, g);
    hi = Math.max(hi, g);
  }
  assert.ok(
    lo >= 1 - 2 * STORM.gustiness - 1e-9 &&
      hi <= 1 + 2 * STORM.gustiness + 1e-9,
    `gusts ${lo.toFixed(2)}…${hi.toFixed(2)}`,
  );
  assert.ok(hi - lo > 0.3, "they vary");
  assert.deepEqual(stormWind(STORM, 412.5), stormWind({ ...STORM }, 412.5));
});

test("storm: wind blows from where it says and veers as it builds", () => {
  const [e0, n0] = stormWind({ ...STORM, gustiness: 0 }, 0);
  // From 300° (west-north-west): blowing towards the east-south-east.
  assert.ok(e0 > 0 && n0 < 0);
  const [e1, n1] = stormWind({ ...STORM, gustiness: 0 }, 400);
  // From 340° by now: more southward than before.
  assert.ok(Math.atan2(n1, e1) < Math.atan2(n0, e0));
});

test("storm: visibility falls from clear to a few hundred metres", () => {
  within(visibility(STORM, 0), 29_000, 30_000, "clear");
  within(visibility(STORM, 400), 500, 700, "in the snow");
});

/** A valley side: a 35° slope (70 %) falling south that flattens out below y = 0. */
const slope = (x: number, y: number) => (y > 0 ? 0.7 * y : 0);

test("avalanche: slides down the fall line, faster on the steep part", () => {
  const a = releaseAvalanche([0, 800, slope(0, 800)], slope, 80, 12);
  for (let t = 0; t < 10; t += 1 / 60) stepAvalanche(a, slope, 1 / 60);
  for (const l of a.lumps) {
    assert.ok(l.position[1] < 800, "moved downhill");
    assert.ok(
      Math.abs(l.velocity[0]) < 0.5,
      "straight down the fall line, not sideways",
    );
  }
  const speed = Math.max(
    ...a.lumps.map((l) => Math.hypot(l.velocity[0], l.velocity[1])),
  );
  within(speed, 15, 45, "speed after 10 s, m/s");
});

test("avalanche: runs out onto the flat and stops; overruns what lies in its path", () => {
  const a = releaseAvalanche([0, 800, slope(0, 800)], slope, 80, 12);
  let hit = false;
  for (let t = 0; t < 120; t += 1 / 30) {
    stepAvalanche(a, slope, 1 / 30);
    hit ||= overruns(a, [0, 100, 70], 40);
  }
  assert.ok(hit, "it swept over the spot in its path");
  assert.equal(moving(a), 0, "all at rest");
  assert.ok(
    a.lumps.every((l) => l.position[1] < 50),
    "they ran out past the foot of the slope",
  );
});

test("avalanche: does not start on flat ground", () => {
  const flat = () => 100;
  const a = releaseAvalanche([0, 0, 100], flat, 50, 6);
  for (let t = 0; t < 2; t += 1 / 30) stepAvalanche(a, flat, 1 / 30);
  assert.equal(moving(a), 0);
});
