/** pnpm test — the laser rangefinder. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { rangefinder } from "./rangefinder.ts";

test("rangefinder: looking down 45° from 100 m over flat ground reads 141 m", () => {
  const s = Math.SQRT1_2;
  const hit = rangefinder([0, 0, 100], [0, s, -s], () => 0);
  assert.ok(hit);
  assert.ok(Math.abs(hit.range - 100 * Math.SQRT2) < 0.1, `${hit.range}`);
  assert.ok(Math.abs(hit.point[1] - 100) < 0.1);
});

test("rangefinder: hits a cliff face ahead, not the ground beyond it", () => {
  const ground = (_e: number, n: number) => (n > 2400 ? 500 : 0);
  const hit = rangefinder([0, 0, 200], [0, 1, 0], ground);
  assert.ok(hit);
  assert.ok(Math.abs(hit.range - 2400) < 1, `${hit.range}`);
});

test("rangefinder: the sky and unknown ground return nothing", () => {
  assert.equal(
    rangefinder([0, 0, 100], [0, 0.6, 0.8], () => 0),
    null,
  );
  assert.equal(
    rangefinder([0, 0, 100], [0, 0, -1], () => Number.NaN),
    null,
  );
});
