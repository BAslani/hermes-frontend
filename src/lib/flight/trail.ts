/**
 * A smoke trail: puffs left behind at a steady rate, drifting with the air,
 * rising a little and spreading as they age, gone after `lifetime` seconds.
 * Puffs live in the simulation's local frame; `shift` follows the origin when
 * it moves.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import type { Vec3 } from "./vec.ts";

interface Puff {
  at: Vec3;
  /** Air-mass velocity it drifts with, m/s. */
  drift: Vec3;
  born: number;
}

export interface LivePuff {
  position: Vec3;
  /** 0 when emitted, 1 when it vanishes. */
  age: number;
}

/** How fast smoke rises, m/s: warm oil smoke lifts slowly. */
const RISE = 0.6;

export class Trail {
  private puffs: Puff[] = [];
  private last = -Infinity;
  private lastAt: Vec3 | null = null;

  readonly lifetime: number;
  /** Seconds between puffs. */
  readonly interval: number;
  readonly max: number;

  // Plain fields, not parameter properties: Node's type stripping runs this file as is.
  constructor(lifetime = 7, interval = 0.03, max = 320) {
    this.lifetime = lifetime;
    this.interval = interval;
    this.max = max;
  }

  /**
   * Leave puffs behind a nozzle now at `at`. Gaps since the last emission are
   * filled along the straight line, so a fast aircraft still leaves an
   * unbroken trail at a low frame rate.
   */
  emit(time: number, at: Vec3, drift: Vec3) {
    if (this.lastAt && time - this.last < this.interval) return;
    const from = this.lastAt;
    const steps = from
      ? Math.min(8, Math.max(1, Math.round((time - this.last) / this.interval)))
      : 1;
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const p: Vec3 = from
        ? [
            from[0] + (at[0] - from[0]) * f,
            from[1] + (at[1] - from[1]) * f,
            from[2] + (at[2] - from[2]) * f,
          ]
        : [...at];
      this.puffs.push({
        at: p,
        drift: [...drift],
        born: this.last + (time - this.last) * f,
      });
    }
    if (!from) this.puffs[this.puffs.length - 1].born = time;
    if (this.puffs.length > this.max)
      this.puffs.splice(0, this.puffs.length - this.max);
    this.last = time;
    this.lastAt = [...at];
  }

  /** Stop the current line: the next emit starts a new one instead of joining up. */
  cut() {
    this.lastAt = null;
  }

  /** Puffs still alive at `time`, oldest first. */
  live(time: number): LivePuff[] {
    while (this.puffs.length && time - this.puffs[0].born > this.lifetime)
      this.puffs.shift();
    return this.puffs.map((puff) => {
      const t = Math.max(0, time - puff.born);
      return {
        position: [
          puff.at[0] + puff.drift[0] * t,
          puff.at[1] + puff.drift[1] * t,
          puff.at[2] + puff.drift[2] * t + RISE * t,
        ],
        age: Math.min(1, t / this.lifetime),
      };
    });
  }

  /** The local frame's origin moved by (east, north). */
  shift(east: number, north: number) {
    for (const puff of this.puffs) {
      puff.at[0] -= east;
      puff.at[1] -= north;
    }
    if (this.lastAt) {
      this.lastAt[0] -= east;
      this.lastAt[1] -= north;
    }
  }

  clear() {
    this.puffs = [];
    this.lastAt = null;
  }
}
