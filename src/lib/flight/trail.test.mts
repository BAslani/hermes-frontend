/** pnpm test — the smoke trail: emission rate, gap filling, ageing out, drift, origin shifts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Trail } from "./trail.ts";

test("trail: one puff per interval, gone after its lifetime", () => {
  const trail = new Trail(2, 0.1);
  for (let t = 0; t <= 1.0001; t += 1 / 60)
    trail.emit(t, [t * 50, 0, 100], [0, 0, 0]);
  const live = trail.live(1);
  assert.ok(live.length >= 10 && live.length <= 12, `${live.length} puffs`);
  assert.equal(trail.live(3.5).length, 0);
});

test("trail: a long frame is filled along the line, not one lonely puff", () => {
  const trail = new Trail(5, 0.05);
  trail.emit(0, [0, 0, 0], [0, 0, 0]);
  trail.emit(0.3, [30, 0, 0], [0, 0, 0]);
  const xs = trail.live(0.3).map((p) => p.position[0]);
  assert.ok(xs.length >= 6, `${xs.length} puffs`);
  assert.ok(
    xs.some((x) => x > 5 && x < 25),
    "puffs in between",
  );
});

test("trail: puffs drift with the air and rise; ages run 0 → 1", () => {
  const trail = new Trail(4, 0.1);
  trail.emit(0, [0, 0, 0], [2, 0, 0]);
  const [puff] = trail.live(2);
  assert.ok(Math.abs(puff.position[0] - 4) < 1e-9, "drifted 4 m east");
  assert.ok(puff.position[2] > 0, "rose");
  assert.ok(Math.abs(puff.age - 0.5) < 1e-9);
});

test("trail: an origin shift moves every puff the other way", () => {
  const trail = new Trail(4, 0.1);
  trail.emit(0, [100, 50, 10], [0, 0, 0]);
  trail.shift(100, 50);
  const [puff] = trail.live(0);
  assert.deepEqual(puff.position.slice(0, 2), [0, 0]);
});

test("trail: cut starts a new line without joining the old one", () => {
  const trail = new Trail(5, 0.05);
  trail.emit(0, [0, 0, 0], [0, 0, 0]);
  trail.cut();
  trail.emit(1, [1000, 0, 0], [0, 0, 0]);
  assert.equal(trail.live(1).length, 2);
});
