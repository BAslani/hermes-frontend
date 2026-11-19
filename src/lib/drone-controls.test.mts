/** pnpm test — Node's built-in runner, no extra dependencies. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDrone,
  cruiseSpeed,
  DRONE,
  groundSpeed,
  look,
  NO_INPUT,
  step,
} from "./drone-controls.ts";

const start = () =>
  createDrone({
    position: [51.68, 35.79],
    altitude: 2000,
    heading: 0,
    pitch: 75,
    ground: 1500,
  });

/** Run the drone for `seconds` at 60 fps over flat ground at `ground` metres. */
function fly(
  input: Partial<typeof NO_INPUT>,
  seconds: number,
  ground = 1500,
  state = start(),
) {
  for (let i = 0; i < seconds * 60; i++)
    state = step(state, { ...NO_INPUT, ...input }, 1 / 60, {
      groundBelow: ground,
    });
  return state;
}

test("forward flight eases up to cruise speed and heads north at heading 0", () => {
  const s = fly({ forward: 1 }, 5);
  const expected = cruiseSpeed(500);
  assert.ok(
    Math.abs(groundSpeed(s) - expected) / expected < 0.01,
    `speed ${groundSpeed(s)} vs ${expected}`,
  );
  assert.ok(s.position[1] > 35.79);
  assert.ok(Math.abs(s.position[0] - 51.68) < 1e-6);
});

test("releasing the keys glides to a stop instead of halting", () => {
  const moving = fly({ forward: 1 }, 5);
  const after = fly({}, 0.25, 1500, moving);
  assert.ok(
    groundSpeed(after) > 0.3 * groundSpeed(moving),
    "still gliding shortly after release",
  );
  assert.ok(
    groundSpeed(fly({}, 5, 1500, moving)) < 0.01,
    "stopped after a few seconds",
  );
});

test("speed is the same regardless of frame rate", () => {
  let a = start();
  let b = start();
  for (let i = 0; i < 120; i++)
    a = step(a, { ...NO_INPUT, forward: 1 }, 1 / 120, { groundBelow: 1500 });
  for (let i = 0; i < 30; i++)
    b = step(b, { ...NO_INPUT, forward: 1 }, 1 / 30, { groundBelow: 1500 });
  assert.ok(Math.abs(groundSpeed(a) - groundSpeed(b)) / groundSpeed(a) < 0.02);
});

test("boost is faster and precision slower than cruise", () => {
  const cruise = groundSpeed(fly({ forward: 1 }, 4));
  assert.ok(groundSpeed(fly({ forward: 1, boost: true }, 4)) > 2.5 * cruise);
  assert.ok(groundSpeed(fly({ forward: 1, precise: true }, 4)) < 0.3 * cruise);
});

test("descending stops at the minimum clearance above the ground", () => {
  const s = fly({ lift: -1 }, 60);
  assert.ok(s.altitude >= 1500 + DRONE.minClearance * 0.4);
  assert.ok(
    Math.abs(s.altitude - (1500 + DRONE.minClearance)) < 2,
    `altitude ${s.altitude}`,
  );
});

test("rising terrain pushes the drone up", () => {
  const low = fly({ lift: -1 }, 30);
  const s = fly({}, 3, 1800, low);
  assert.ok(s.altitude > 1800 + DRONE.minClearance * 0.4);
});

test("look clamps pitch and wraps heading", () => {
  const s = look(start(), -30, 500);
  assert.equal(s.heading, 330);
  assert.equal(s.pitch, DRONE.maxPitch);
});

test("bounds stop the drone at the edge", () => {
  let s = start();
  for (let i = 0; i < 600; i++) {
    s = step(s, { ...NO_INPUT, forward: 1, boost: true }, 1 / 60, {
      groundBelow: 1500,
      bounds: [51, 35, 52, 35.8],
    });
  }
  assert.equal(s.position[1], 35.8);
});

test("the edge of the map slows the drone to a smooth stop, never a snap", () => {
  // A wall 6 km north of the start; the drone flies at it flat out.
  const metresPerDegree = (6371008.8 * Math.PI) / 180;
  const wall = 35.79 + 6000 / metresPerDegree;
  const edgeAt = (s: ReturnType<typeof start>) => ({
    remaining: (wall - s.position[1]) * metresPerDegree,
    outward: [0, 1] as [number, number],
  });
  let s = start();
  let biggestDrop = 0;
  let fastest = 0;
  for (let i = 0; i < 60 * 40; i++) {
    const before = groundSpeed(s);
    s = step(s, { ...NO_INPUT, forward: 1, boost: true }, 1 / 60, {
      groundBelow: 1500,
      edge: edgeAt(s),
    });
    fastest = Math.max(fastest, before);
    biggestDrop = Math.max(biggestDrop, before - groundSpeed(s));
  }
  assert.ok(fastest > 400, `reached speed first (${fastest})`);
  assert.ok(
    biggestDrop < fastest * 0.03,
    `no sudden stop: lost ${biggestDrop} m/s in one frame`,
  );
  assert.ok(s.position[1] < wall, "never crosses the edge");
  assert.ok(
    edgeAt(s).remaining < 5,
    `settles at the edge (${edgeAt(s).remaining} m left)`,
  );
  assert.ok(groundSpeed(s) < 5);

  // Flying along the edge or away from it is not held back.
  const along = fly({ strafe: 1 }, 3, 1500, { ...s, velocity: [0, 0, 0] });
  assert.ok(groundSpeed(along) > 100);
  let away = s;
  for (let i = 0; i < 180; i++)
    away = step(away, { ...NO_INPUT, forward: -1 }, 1 / 60, {
      groundBelow: 1500,
      edge: edgeAt(away),
    });
  assert.ok(away.position[1] < s.position[1] && groundSpeed(away) > 100);
});

test("flying into the edge at an angle stops too, instead of sliding along it", () => {
  const metresPerDegree = (6371008.8 * Math.PI) / 180;
  const wall = 35.79 + 6000 / metresPerDegree;
  let s = { ...start(), heading: 45 };
  let biggestDrop = 0;
  for (let i = 0; i < 60 * 40; i++) {
    const before = groundSpeed(s);
    s = step(s, { ...NO_INPUT, forward: 1, boost: true }, 1 / 60, {
      groundBelow: 1500,
      edge: {
        remaining: (wall - s.position[1]) * metresPerDegree,
        outward: [0, 1],
      },
    });
    biggestDrop = Math.max(biggestDrop, before - groundSpeed(s));
  }
  assert.ok(groundSpeed(s) < 5, `stopped (${groundSpeed(s)} m/s)`);
  assert.ok(s.position[1] < wall);
  assert.ok(
    biggestDrop < 1800 * 0.03,
    `no sudden stop: lost ${biggestDrop} m/s in one frame`,
  );
});

test("a drone past the edge is carried back inside", () => {
  let s = start();
  let remaining = -500;
  for (let i = 0; i < 60 * 30; i++) {
    const before = s.position[1];
    s = step(s, NO_INPUT, 1 / 60, {
      groundBelow: 1500,
      edge: { remaining, outward: [0, 1] },
    });
    remaining += (before - s.position[1]) * ((6371008.8 * Math.PI) / 180);
  }
  assert.ok(remaining > -5, `back at the edge (${remaining})`);
});

test("turning banks the drone, and noRoll keeps it level", () => {
  assert.ok(Math.abs(fly({ turn: 1 }, 2).roll) > 3);
  let s = start();
  for (let i = 0; i < 120; i++)
    s = step(s, { ...NO_INPUT, turn: 1 }, 1 / 60, {
      groundBelow: 1500,
      noRoll: true,
    });
  assert.equal(s.roll, 0);
});

test("maxSpeed caps cruise however high the drone flies, and boost multiplies the cap", () => {
  const capped = (boost: boolean) => {
    let s = start();
    for (let i = 0; i < 6 * 60; i++)
      s = step(s, { ...NO_INPUT, forward: 1, boost }, 1 / 60, {
        groundBelow: 1500,
        maxSpeed: 40,
      });
    return groundSpeed(s);
  };
  assert.ok(Math.abs(capped(false) - 40) < 0.5);
  assert.ok(Math.abs(capped(true) - 40 * DRONE.boost) < 2);
});
