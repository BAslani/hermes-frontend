/** pnpm test — co-op stand-in partners. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { standInDrone, standInJet } from "./partner.ts";
import { length, rotate, toAttitude } from "./vec.ts";

test("stand-in jet: circles the site anticlockwise, banked left, clear of a ridge", () => {
  // A 900 m ridge to the east of the site.
  const ground = (east: number) => (east > 3000 ? 900 : 0);
  const jet = standInJet([0, 0, 15], ground, { radius: 3500, speed: 170 });
  let last = Math.atan2(jet.state().position[0], jet.state().position[1]);
  let turned = 0;
  for (let i = 0; i < 200; i++) {
    jet.step(0.1);
    const s = jet.state();
    assert.ok(Math.abs(Math.hypot(s.position[0], s.position[1]) - 3500) < 1);
    assert.ok(s.position[2] > 900 + 300, "above the ridge");
    // The nose points along the way it flies.
    const nose = rotate(s.orientation, [1, 0, 0]);
    const v = s.velocity;
    assert.ok(
      (nose[0] * v[0] + nose[1] * v[1]) / length(v) > 0.99,
      "nose along the track",
    );
    const now = Math.atan2(s.position[0], s.position[1]);
    turned += ((now - last + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    last = now;
  }
  assert.ok(turned < 0, "anticlockwise seen from above");
  const { roll } = toAttitude(jet.state().orientation);
  // atan(170² / (3500 g)) ≈ 40°, to the left.
  assert.ok(roll < -35 && roll > -45, `banked left (${roll.toFixed(0)}°)`);
});

test("stand-in drone: stays where it was put, turning slowly", () => {
  const drone = standInDrone([100, -50, 2000], 30);
  const h0 = toAttitude(drone.state().orientation).heading;
  for (let i = 0; i < 50; i++) drone.step(0.1);
  const s = drone.state();
  assert.ok(
    Math.abs(s.position[0] - 100) < 1e-9 && Math.abs(s.position[2] - 2000) < 1,
  );
  const turned = toAttitude(s.orientation).heading - h0;
  assert.ok(turned > 30 && turned < 50, `turned ${turned.toFixed(0)}°`);
  assert.equal(s.role, "drone");
});
