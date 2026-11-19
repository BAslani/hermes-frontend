/**
 * A mountain storm that builds while a mission is flown: the wind rises
 * from a breeze to a gale over the storm's build-up, veers, and gusts (a sum
 * of a few slow waves with fixed random phases, so it is repeatable and
 * smooth); visibility falls as it thickens.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import { clamp, RAD, type Vec3 } from "./vec.ts";

export interface StormSpec {
  /** Mean wind at the start and at full strength, m/s. */
  startWind: number;
  fullWind: number;
  /** Direction the wind blows from at the start, degrees, and how far it veers by full strength. */
  from: number;
  veer: number;
  /** Seconds to build to full strength. */
  buildUp: number;
  /** Gusts at full strength, as a share of the mean wind (0.4 = ±40 %). */
  gustiness: number;
  /** Seed for the gust pattern. */
  seed: number;
}

/** 0–1: how far the storm has built after `time` seconds (smooth start and finish). */
export function stormStrength(storm: StormSpec, time: number) {
  const x = clamp(time / storm.buildUp, 0, 1);
  return x * x * (3 - 2 * x);
}

/** A small, fast, deterministic random number generator (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const waves = new Map<number, { period: number; phase: number }[]>();
function gustWaves(seed: number) {
  let found = waves.get(seed);
  if (!found) {
    const next = random(seed);
    // Periods from a few seconds to about half a minute.
    found = [3.1, 5.3, 8.7, 13.9, 27].map((base) => ({
      period: base * (0.8 + 0.4 * next()),
      phase: next() * 2 * Math.PI,
    }));
    waves.set(seed, found);
  }
  return found;
}

/** Gust factor around 1 at a time: mean 1, within ±gustiness at full strength. */
export function gust(storm: StormSpec, time: number) {
  const w = gustWaves(storm.seed);
  let sum = 0;
  for (const { period, phase } of w)
    sum += Math.sin((2 * Math.PI * time) / period + phase);
  return (
    1 + (sum / w.length) * 2 * storm.gustiness * stormStrength(storm, time)
  );
}

/** The air mass's velocity at a time, east-north-up, m/s. */
export function stormWind(storm: StormSpec, time: number): Vec3 {
  const s = stormStrength(storm, time);
  const speed = Math.max(
    0,
    (storm.startWind + (storm.fullWind - storm.startWind) * s) *
      gust(storm, time),
  );
  const from = (storm.from + storm.veer * s) * RAD;
  return [-Math.sin(from) * speed, -Math.cos(from) * speed, 0];
}

/** How far you can see, metres: clear to driving snow. */
export function visibility(storm: StormSpec, time: number) {
  const s = stormStrength(storm, time);
  return 30_000 * (1 - s) + 600 * s;
}
