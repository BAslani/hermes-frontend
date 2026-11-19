/** pnpm test — Node's built-in runner, no extra dependencies. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { IRAN_OUTLINE } from "../config/iran-outline.ts";
import {
  edgeState,
  flightLimit,
  pointInOutline,
  pointInRing,
  readBoundary,
} from "./geo-boundary.ts";

/** A 1° square on the equator, so 1° is 111.2 km both ways. */
const SQUARE: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];
const DEGREE = 111_195;
const near = (actual: number, expected: number, tolerance: number) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} vs ${expected} ± ${tolerance}`,
  );

test("point in ring: inside, outside and a concave notch", () => {
  assert.equal(pointInRing([0.5, 0.5], SQUARE), true);
  assert.equal(pointInRing([1.5, 0.5], SQUARE), false);
  assert.equal(pointInRing([0.5, -0.1], SQUARE), false);
  const notched: [number, number][] = [
    [0, 0],
    [2, 0],
    [2, 2],
    [1, 0.5],
    [0, 2],
  ];
  assert.equal(
    pointInRing([1, 1.5], notched),
    false,
    "inside the notch is outside the ring",
  );
  assert.equal(pointInRing([0.3, 1], notched), true);
});

test("separate rings are separate pieces of land", () => {
  const island: [number, number][] = [
    [3, 0],
    [4, 0],
    [4, 1],
    [3, 1],
  ];
  assert.equal(pointInOutline([3.5, 0.5], [SQUARE, island]), true);
  assert.equal(pointInOutline([2, 0.5], [SQUARE, island]), false);
});

test("signed distance is positive inside, negative outside, with the way out", () => {
  const inside = readBoundary([0.9, 0.5], [SQUARE]);
  near(inside.signedDistance, 0.1 * DEGREE, 50);
  near(inside.outward[0], 1, 1e-6);
  near(inside.outward[1], 0, 1e-6);
  near(inside.nearest[0], 1, 1e-9);

  const outside = readBoundary([0.5, 1.2], [SQUARE]);
  near(outside.signedDistance, -0.2 * DEGREE, 50);
  near(outside.outward[1], 1, 1e-6);
});

test("distance to a corner is measured to the corner", () => {
  const r = readBoundary([1.1, 1.1], [SQUARE]);
  near(r.signedDistance, -Math.hypot(0.1, 0.1) * DEGREE, 80);
  near(r.outward[0], Math.SQRT1_2, 1e-3);
  near(r.outward[1], Math.SQRT1_2, 1e-3);
});

test("the margin grows the flyable area and the bounds cut it", () => {
  const p: [number, number] = [1.05, 0.5];
  near(flightLimit(p, [SQUARE], 0).remaining, -0.05 * DEGREE, 50);
  near(flightLimit(p, [SQUARE], 20_000).remaining, 20_000 - 0.05 * DEGREE, 50);
  const cut = flightLimit(p, [SQUARE], 20_000, [-1, -1, 1.06, 2]);
  near(cut.remaining, 0.01 * DEGREE, 50);
  assert.deepEqual(cut.outward, [1, 0]);
});

test("edge notices by distance left", () => {
  assert.equal(edgeState(8000, 5000, 200), "clear");
  assert.equal(edgeState(4999, 5000, 200), "near");
  assert.equal(edgeState(150, 5000, 200), "edge");
  assert.equal(edgeState(-30, 5000, 200), "edge");
});

test("the Iran outline holds its cities and not its neighbours", () => {
  assert.ok(
    IRAN_OUTLINE.reduce((n, ring) => n + ring.length, 0) <= 400,
    "a few hundred points at most",
  );
  const inside: Record<string, [number, number]> = {
    Tehran: [51.39, 35.7],
    Tabriz: [46.29, 38.08],
    Mashhad: [59.6, 36.3],
    Zahedan: [60.86, 29.5],
    Ahvaz: [48.67, 31.32],
    Qeshm: [55.9, 26.8],
  };
  const outside: Record<string, [number, number]> = {
    Baghdad: [44.4, 33.31],
    Baku: [49.87, 40.4],
    Herat: [62.2, 34.35],
    Dubai: [55.27, 25.2],
    "Caspian Sea": [51, 38.5],
  };
  for (const [name, p] of Object.entries(inside))
    assert.ok(pointInOutline(p, IRAN_OUTLINE), name);
  for (const [name, p] of Object.entries(outside))
    assert.ok(!pointInOutline(p, IRAN_OUTLINE), name);
  // Tehran is about 100 km from the Caspian coast, the nearest edge.
  const tehran = readBoundary(inside.Tehran, IRAN_OUTLINE).signedDistance;
  assert.ok(
    tehran > 80_000 && tehran < 130_000,
    `Tehran to the outline: ${tehran}`,
  );
});
