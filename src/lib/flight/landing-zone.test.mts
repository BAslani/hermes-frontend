/** pnpm test — finding flat ground to land on. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { findLandingZone, flatness, MAX_LZ_SLOPE } from "./landing-zone.ts";

test("flatness: a tilted plane reads its slope, with no roughness", () => {
  const f = flatness((e, n) => 100 + 0.1 * e + 0.05 * n, 0, 0, 20);
  assert.ok(Math.abs(f.slope - Math.hypot(0.1, 0.05)) < 1e-9);
  assert.ok(f.rough < 1e-9);
  assert.ok(Math.abs(f.ground - 100) < 1e-9);
});

test("flatness: a boulder shows up as roughness", () => {
  const f = flatness((e, n) => (Math.hypot(e - 5, n) < 3 ? 4 : 0), 0, 0, 20);
  assert.ok(f.rough > 2);
});

test("landing zone: finds the terrace on a steep hillside", () => {
  // A 40 % slope everywhere except a flat shelf around (150, -80).
  const ground = (e: number, n: number) =>
    Math.hypot(e - 150, n + 80) < 45 ? 500 : 500 + 0.4 * (n + 80);
  const zone = findLandingZone(ground, 0, 0, 300, 20);
  assert.ok(zone, "found one");
  assert.ok(
    Math.hypot(zone.east - 150, zone.north + 80) < 30,
    `on the shelf (${zone.east}, ${zone.north})`,
  );
  assert.ok(zone.slope < MAX_LZ_SLOPE);
});

test("landing zone: unknown ground (tiles not loaded) never counts as flat", () => {
  assert.equal(
    findLandingZone(() => Number.NaN, 0, 0, 100, 20),
    null,
  );
});

test("landing zone: nothing flat enough is reported as none", () => {
  assert.equal(
    findLandingZone((e, n) => 0.5 * n, 0, 0, 200, 20),
    null,
  );
});
