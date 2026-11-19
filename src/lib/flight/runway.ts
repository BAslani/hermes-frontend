/**
 * Finds a runway in the basemap's own data. The OpenMapTiles `aeroway` layer
 * carries runway centrelines as line strings (class "runway"), but vector
 * tiles cut them at tile edges, so one runway arrives as several pieces. This
 * picks the piece nearest the airport, then gathers every piece lying along
 * the same straight line.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import { type LngLat, toLngLat, toLocal } from "./frame.ts";

export interface Runway {
  /** Both ends of the centreline. */
  ends: [LngLat, LngLat];
  /** Metres. */
  length: number;
  /** Degrees from north, from ends[0] to ends[1]. */
  heading: number;
  /** e.g. "11L/29R", when the data has it. */
  ref?: string;
}

export interface RunwayLine {
  points: LngLat[];
  ref?: string;
}

/** Pieces within this distance of the seed's line belong to the same runway, metres. */
const LATERAL = 25;
/** ...and their direction within this many degrees of it. */
const ANGLE = 4;
const MIN_LENGTH = 500;

/**
 * The runway closest to `near` among the line pieces, or null if none is at
 * least 500 m long within `maxDistance` metres.
 */
export function findRunway(
  lines: RunwayLine[],
  near: LngLat,
  maxDistance = 8000,
): Runway | null {
  type Segment = { a: [number, number]; b: [number, number]; ref?: string };
  const segments: Segment[] = [];
  for (const line of lines) {
    const local = line.points.map((p) => toLocal(near, p));
    for (let i = 1; i < local.length; i++)
      segments.push({ a: local[i - 1], b: local[i], ref: line.ref });
  }
  const usable = segments.filter(
    (s) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) > 1,
  );
  if (!usable.length) return null;

  const distanceTo = (s: Segment) => {
    const dx = s.b[0] - s.a[0];
    const dy = s.b[1] - s.a[1];
    const t = Math.min(
      1,
      Math.max(0, -(s.a[0] * dx + s.a[1] * dy) / (dx * dx + dy * dy)),
    );
    return Math.hypot(s.a[0] + t * dx, s.a[1] + t * dy);
  };

  const candidates = [...usable].sort((p, q) => distanceTo(p) - distanceTo(q));
  for (const seed of candidates) {
    if (distanceTo(seed) > maxDistance) break;
    const len = Math.hypot(seed.b[0] - seed.a[0], seed.b[1] - seed.a[1]);
    const ux = (seed.b[0] - seed.a[0]) / len;
    const uy = (seed.b[1] - seed.a[1]) / len;
    const along = (p: [number, number]) =>
      (p[0] - seed.a[0]) * ux + (p[1] - seed.a[1]) * uy;
    const across = (p: [number, number]) =>
      Math.abs(-(p[0] - seed.a[0]) * uy + (p[1] - seed.a[1]) * ux);

    // Every piece on the seed's line, as intervals along it.
    const intervals: [number, number][] = [];
    for (const s of usable) {
      const sl = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      const cos = Math.abs(
        ((s.b[0] - s.a[0]) * ux + (s.b[1] - s.a[1]) * uy) / sl,
      );
      if (
        cos < Math.cos((ANGLE * Math.PI) / 180) ||
        across(s.a) > LATERAL ||
        across(s.b) > LATERAL
      )
        continue;
      intervals.push([
        Math.min(along(s.a), along(s.b)),
        Math.max(along(s.a), along(s.b)),
      ]);
    }
    // Grow from the seed through pieces that touch (tile cuts leave no gap; allow 30 m).
    let lo = 0;
    let hi = len;
    for (let grew = true; grew; ) {
      grew = false;
      for (const [a, b] of intervals) {
        if (a <= hi + 30 && b >= lo - 30 && (a < lo - 1e-6 || b > hi + 1e-6)) {
          lo = Math.min(lo, a);
          hi = Math.max(hi, b);
          grew = true;
        }
      }
    }
    if (hi - lo < MIN_LENGTH) continue;
    const start: [number, number] = [seed.a[0] + ux * lo, seed.a[1] + uy * lo];
    const end: [number, number] = [seed.a[0] + ux * hi, seed.a[1] + uy * hi];
    return {
      ends: [
        toLngLat(near, start[0], start[1]),
        toLngLat(near, end[0], end[1]),
      ],
      length: hi - lo,
      heading: ((Math.atan2(ux, uy) * 180) / Math.PI + 360) % 360,
      ref: seed.ref,
    };
  }
  return null;
}

export interface RunwayStart {
  position: LngLat;
  /** Degrees from north. */
  heading: number;
}

/**
 * Where to line up: a little in from one end, pointing down the runway. Takes
 * off into the wind when there is one; otherwise towards the west, the usual
 * way at Tehran Mehrabad.
 */
export function lineUp(
  runway: Runway,
  windFrom?: number,
  windSpeed = 0,
  inset = 60,
): RunwayStart {
  const forward = runway.heading;
  const backward = (forward + 180) % 360;
  const headwind = (heading: number) =>
    Math.cos(((heading - (windFrom ?? 0)) * Math.PI) / 180);
  const useForward =
    windSpeed > 0.5 && windFrom !== undefined
      ? headwind(forward) >= headwind(backward)
      : forward >= 180;
  const from = useForward ? runway.ends[0] : runway.ends[1];
  const heading = useForward ? forward : backward;
  const h = (heading * Math.PI) / 180;
  return {
    position: toLngLat(from, Math.sin(h) * inset, Math.cos(h) * inset),
    heading,
  };
}
