/**
 * Finding somewhere to land: the flattest disc near a point, judged by the
 * plane best fitting the ground under it (its slope) and how far the ground
 * strays from that plane (rocks, ditches). Used to put landing zones next to
 * villages picked from the map data at run time, the same test
 * scripts/design-missions.mts uses on the DEM.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import type { GroundFn } from "./contact.ts";

/** Steeper than this (tan) is no place to set a helicopter down: about 8°. */
export const MAX_LZ_SLOPE = 0.14;
/** Ground straying further than this from flat under the disc, metres. */
export const MAX_LZ_ROUGHNESS = 2.5;

export interface Flatness {
  /** Rise over run of the best-fitting plane. */
  slope: number;
  /** Largest departure from that plane, metres. */
  rough: number;
  /** Mean ground elevation, metres. */
  ground: number;
}

export function flatness(
  ground: GroundFn,
  east: number,
  north: number,
  radius: number,
): Flatness {
  const pts: [number, number, number][] = [];
  const step = radius / 3;
  for (let e = -radius; e <= radius + 1e-9; e += step) {
    for (let n = -radius; n <= radius + 1e-9; n += step) {
      if (Math.hypot(e, n) > radius + 1e-9) continue;
      pts.push([e, n, ground(east + e, north + n)]);
    }
  }
  const mean = pts.reduce((s, p) => s + p[2], 0) / pts.length;
  let see = 0;
  let snn = 0;
  let sez = 0;
  let snz = 0;
  for (const [e, n, z] of pts) {
    see += e * e;
    snn += n * n;
    sez += e * (z - mean);
    snz += n * (z - mean);
  }
  const a = sez / see;
  const b = snz / snn;
  let rough = 0;
  for (const [e, n, z] of pts)
    rough = Math.max(rough, Math.abs(z - (mean + a * e + b * n)));
  return { slope: Math.hypot(a, b), rough, ground: mean };
}

export interface LandingZone extends Flatness {
  east: number;
  north: number;
}

/**
 * The flattest disc of `radius` within `search` metres of a point, preferring
 * nearer ones a little; null if nowhere is flat enough.
 */
export function findLandingZone(
  ground: GroundFn,
  east: number,
  north: number,
  search: number,
  radius: number,
  step = 20,
): LandingZone | null {
  let best: (LandingZone & { score: number }) | null = null;
  for (let e = -search; e <= search; e += step) {
    for (let n = -search; n <= search; n += step) {
      if (Math.hypot(e, n) > search) continue;
      const f = flatness(ground, east + e, north + n, radius);
      // Written so that unknown ground (NaN, tiles not loaded) never passes.
      if (!(f.slope <= MAX_LZ_SLOPE) || !(f.rough <= MAX_LZ_ROUGHNESS))
        continue;
      const score = f.slope + f.rough / 20 + Math.hypot(e, n) / 20_000;
      if (!best || score < best.score)
        best = { east: east + e, north: north + n, ...f, score };
    }
  }
  if (!best) return null;
  const { score: _score, ...zone } = best;
  void _score;
  return zone;
}
