/** pnpm test — the co-op partner fed by network reports. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { length, sub, type Vec3 } from "../flight/vec.ts";
import { networkPartner } from "./network-partner.ts";

const start = {
  role: "jet" as const,
  position: [0, 0, 1000] as Vec3,
  velocity: [0, 0, 0] as Vec3,
  orientation: [0, 0, 0, 1] as [number, number, number, number],
};
const report = (position: Vec3, velocity: Vec3) => ({
  position,
  velocity,
  orientation: [0, 0, 0, 1] as [number, number, number, number],
  t: 0,
});

test("network partner: waits at the start, then the first report places it", () => {
  const p = networkPartner("jet", start);
  assert.equal(p.heard, false);
  assert.deepEqual(p.state().position, [0, 0, 1000]);
  p.report(report([500, 0, 1200], [100, 0, 0]));
  assert.equal(p.heard, true);
  assert.deepEqual(p.state().position, [500, 0, 1200]);
});

test("network partner: carries on along its velocity between reports, for a while", () => {
  const p = networkPartner("jet", start);
  p.report(report([0, 0, 1000], [100, 0, 0]));
  for (let i = 0; i < 6; i++) p.step(1 / 60);
  assert.ok(Math.abs(p.state().position[0] - 10) < 1e-6, "100 m/s for 0.1 s");
  // A stalled connection: it stops after MAX_EXTRAPOLATION instead of flying off.
  for (let i = 0; i < 120; i++) p.step(1 / 60);
  assert.ok(p.state().position[0] <= 50 + 1e-6);
});

test("network partner: a report that disagrees blends in instead of jumping", () => {
  const p = networkPartner("jet", start);
  p.report(report([0, 0, 1000], [100, 0, 0]));
  for (let i = 0; i < 4; i++) p.step(1 / 60);
  const before = p.state().position;
  // The real aircraft turned: it is 20 m further north than projected.
  p.report(report([before[0], 20, 1000], [100, 0, 0]));
  const after = p.state().position;
  assert.ok(length(sub(after, before)) < 1e-6, "no jump at the report");
  for (let i = 0; i < 30; i++) p.step(1 / 60);
  // Half a second on: nearly all of the 20 m taken up.
  assert.ok(
    p.state().position[1] > 19,
    `blended in (${p.state().position[1].toFixed(1)} m)`,
  );
});
