/** pnpm test — the shared co-op match: snapshots and the partner's shots. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LAUNCHER,
  newStrike,
  type StrikeSpec,
  stepStrike,
  threatsLeft,
} from "../flight/strike.ts";
import { applyFire, applySnapshot, coast, snapshotOf } from "./match.ts";
import { MAX_MESSAGE_BYTES } from "./protocol.ts";

const flat = () => 0;
const spec: StrikeSpec = {
  site: [0, 0, 15],
  siteRadius: 40,
  spawnDistance: 6000,
  launchers: [[4000, 0]],
  waves: [
    {
      groups: [
        {
          from: 0,
          spread: 0,
          count: 8,
          interval: 2,
          speed: 50,
          cruise: 80,
          weave: 0,
          launcher: 0,
        },
      ],
    },
  ],
  hitsAllowed: 4,
  magazine: 6,
  firstBreak: 1,
  breakTime: 5,
};

test("snapshot: the guest's copy matches the host's game, and stays small", () => {
  const host = newStrike(spec, 3);
  stepStrike(host, flat, 9);
  applyFire(host, "drone", {
    weapon: "gun",
    position: [0, 0, 200],
    velocity: [0, 0, 0],
    forward: [1, 0, 0],
  });
  stepStrike(host, flat, 0.1);
  const snapshot = snapshotOf(host);
  const text = JSON.stringify({ type: "snapshot", state: snapshot });
  assert.ok(text.length < MAX_MESSAGE_BYTES / 4, `${text.length} bytes`);

  const guest = newStrike(spec, 99);
  applySnapshot(guest, JSON.parse(text).state);
  assert.equal(guest.threats.length, host.threats.length);
  assert.equal(threatsLeft(guest), threatsLeft(host));
  assert.equal(guest.wave, host.wave);
  assert.ok(
    Math.abs(guest.threats[0].position[0] - host.threats[0].position[0]) < 0.01,
  );
  assert.equal(guest.launchers[0].health, host.launchers[0].health);
});

test("coast: between snapshots, drones carry on along their velocities", () => {
  const game = newStrike(spec, 3);
  stepStrike(game, flat, 2);
  const t = game.threats[0];
  const before = [...t.position];
  coast(game, 0.1);
  for (let i = 0; i < 3; i++)
    assert.ok(
      Math.abs(t.position[i] - (before[i] + t.velocity[i] * 0.1)) < 1e-9,
    );
});

test("applyFire: the drone's shots use the game's magazine; the F-14's do not, and one missile kills a launcher", () => {
  const game = newStrike(spec, 3);
  stepStrike(game, flat, 1.05);
  const shot = {
    weapon: "missile" as const,
    position: [0, 0, 300] as [number, number, number],
    velocity: [0, 0, 0] as [number, number, number],
    forward: [1, 0, 0] as [number, number, number],
  };
  applyFire(game, "drone", shot);
  assert.equal(game.magazine, spec.magazine - 1);
  // The F-14's missile at the launcher, from 3 km out.
  applyFire(game, "jet", {
    weapon: "missile",
    position: [1000, 0, 600],
    velocity: [200, 0, -40],
    forward: [1, 0, -0.2],
    launcher: 0,
  });
  assert.equal(
    game.magazine,
    spec.magazine - 1,
    "the F-14 keeps its own stores",
  );
  for (let t = 0; t < 20 && game.launchers[0].alive; t += 0.05)
    stepStrike(game, flat, 0.05);
  assert.equal(game.launchers[0].alive, false);
  assert.equal(game.launchers[0].health, LAUNCHER.health - LAUNCHER.health);
});
