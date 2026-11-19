/** pnpm test — Node's built-in runner, no extra dependencies. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FLIGHT_SCENES } from "../config/flights.ts";
import {
  cameraFromView,
  distanceMetres,
  parseViewerHash,
  planAltitude,
  planFlight,
} from "./drone-flight.ts";

const turnarounds = FLIGHT_SCENES.filter((s) => s.kind === "turnaround");
const desert = turnarounds[0];
const start = {
  position: [54.45, 33.92] as [number, number],
  altitude: 4200,
  bearing: -128,
  pitch: 65,
};

test("parses the saved viewer positions", () => {
  assert.deepEqual(parseViewerHash(desert.viewerUrl), {
    center: [54.47485, 33.93604],
    zoom: 14.68,
    bearing: -128,
    pitch: 65,
  });
  for (const scene of FLIGHT_SCENES)
    assert.doesNotThrow(() => parseViewerHash(scene.viewerUrl));
  assert.throws(() =>
    parseViewerHash("https://map.141.ir/styles/satellite-terrain/"),
  );
});

test("start camera sits behind the view centre at the right height", () => {
  const view = parseViewerHash(desert.viewerUrl);
  const cam = cameraFromView(view, {
    height: 700,
    fov: 36.87,
    centerElevation: 2560,
  });
  const horizontal = distanceMetres(cam.position, view.center);
  // Same relation verified against MapLibre: horizontal = height above centre × tan(pitch).
  const expected = (cam.altitude - 2560) * Math.tan((65 * Math.PI) / 180);
  assert.ok(
    Math.abs(horizontal - expected) < 2,
    `${horizontal} vs ${expected}`,
  );
  assert.ok(cam.altitude - 2560 > 500 && cam.altitude - 2560 < 2000);
});

test("turnaround flights: 8 s out, 5 s turn, 7 s back, 25 s total", () => {
  assert.equal(turnarounds.length, 2);
  for (const scene of turnarounds) {
    const path = planFlight(start, 1000, scene.legs);
    assert.equal(path.legs[1].duration, 8);
    assert.equal(path.legs[2].duration, 5);
    assert.equal(path.legs[3].duration, 7);
    assert.equal(path.duration, 25);
    const afterTurn = path.sampleAt(path.legs[3].startTime);
    assert.ok(Math.abs(afterTurn.bearing - (-128 + 180)) < 1e-6);
  }
});

test("speed is continuous and never reverses", () => {
  for (const scene of FLIGHT_SCENES) {
    const path = planFlight(start, 1000, scene.legs);
    let last = path.sampleAt(0);
    for (let t = 1 / 120; t <= path.duration; t += 1 / 120) {
      const s = path.sampleAt(t);
      assert.ok(
        s.speed >= -1e-6,
        `${scene.id}: negative speed at ${t.toFixed(2)}s`,
      );
      assert.ok(
        s.distance >= last.distance - 1e-6,
        `${scene.id}: moved backwards at ${t.toFixed(2)}s`,
      );
      assert.ok(
        Math.abs(s.speed - last.speed) < 6,
        `${scene.id}: speed jump at ${t.toFixed(2)}s`,
      );
      last = s;
    }
  }
});

test("yaw rate stays below 75°/s and the turn eases in and out", () => {
  for (const scene of turnarounds) {
    const path = planFlight(start, 1000, scene.legs);
    const dt = 1 / 60;
    let max = 0;
    for (let t = dt; t <= path.duration; t += dt) {
      max = Math.max(
        max,
        Math.abs(path.sampleAt(t).bearing - path.sampleAt(t - dt).bearing) / dt,
      );
    }
    assert.ok(max < 75, `max yaw rate ${max.toFixed(1)}°/s`);
    const turn = path.legs[2];
    const entry =
      Math.abs(
        path.sampleAt(turn.startTime + 0.05).bearing -
          path.sampleAt(turn.startTime).bearing,
      ) / 0.05;
    assert.ok(entry < 5, `turn entry rate ${entry.toFixed(1)}°/s`);
  }
});

test("the return leg passes back near the outbound route", () => {
  const path = planFlight(start, 1000, desert.legs);
  const out = path.sampleAt(path.legs[1].startTime + 4).position;
  let nearest = Infinity;
  for (
    let t = path.legs[3].startTime;
    t <= path.legs[3].startTime + path.legs[3].duration;
    t += 0.05
  ) {
    nearest = Math.min(nearest, distanceMetres(out, path.sampleAt(t).position));
  }
  assert.ok(
    nearest < 600,
    `return track ${nearest.toFixed(0)} m from the outbound one`,
  );
});

test("terrain bumps add no tremor, and the camera clears a ridge", () => {
  const path = planFlight(start, 1000, desert.legs);
  // A 900 m ridge 1.5 km out; the second terrain adds ±40 m bumps every few metres.
  const ridge = (p: [number, number]) => {
    const d = distanceMetres(start.position, p);
    return 2550 + 900 * Math.exp(-(((d - 1500) / 250) ** 2));
  };
  const bumpy = (p: [number, number]) =>
    ridge(p) + 40 * Math.sin(distanceMetres(start.position, p) / 7);
  const residual = (ground: (p: [number, number]) => number) => {
    const altitudeAt = planAltitude(path, ground, desert.minClearance);
    const alts: number[] = [];
    let worst = Infinity;
    for (let t = 0; t <= path.duration; t += 1 / 60) {
      const s = path.sampleAt(t);
      alts.push(altitudeAt(s.distance, s.height));
      worst = Math.min(worst, alts.at(-1)! - ground(s.position));
    }
    // What is left after a 0.5 s moving average = high-frequency motion.
    const out: number[] = [];
    for (let i = 15; i < alts.length - 15; i++) {
      let sum = 0;
      for (let j = i - 15; j <= i + 15; j++) sum += alts[j];
      out.push(alts[i] - sum / 31);
    }
    return { worst, out };
  };
  const clean = residual(ridge);
  const rough = residual(bumpy);
  assert.ok(
    rough.worst >= desert.minClearance * 0.8,
    `lowest clearance ${rough.worst.toFixed(0)} m`,
  );
  const added = Math.max(
    ...rough.out.map((v, i) => Math.abs(v - clean.out[i])),
  );
  // ±40 m of bumps may leave < 2 m of slow wobble — invisible from hundreds of metres up.
  assert.ok(added < 2, `bumps added ${added.toFixed(2)} m of tremor`);
});
