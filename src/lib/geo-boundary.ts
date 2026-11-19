/**
 * Where the playground's flyable area ends: point-in-polygon and
 * distance-to-boundary maths over an outline of open [lng, lat] rings. Pure
 * functions, unit-tested in geo-boundary.test.mts.
 *
 * Distances use a flat projection centred on the queried point. That is exact
 * enough near the point, which is the only place the distance matters (the
 * drone brakes over the last few kilometres).
 *
 * Keep this file import-free (types only): Node runs the tests on it directly.
 */
import type { Ring } from "../config/iran-outline.ts";

type Point = [number, number];

const EARTH_RADIUS = 6371008.8;
const RAD = Math.PI / 180;

/** Even-odd ray casting; the ring's last point joins its first. */
export function pointInRing([x, y]: Point, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/** Inside any ring: the rings are separate pieces of land, not holes. */
export const pointInOutline = (p: Point, rings: Ring[]) =>
  rings.some((ring) => pointInRing(p, ring));

export interface BoundaryReading {
  /** Metres to the outline: positive inside it, negative outside. */
  signedDistance: number;
  /** Closest point on the outline. */
  nearest: Point;
  /** Unit vector [east, north] along which the signed distance falls fastest. */
  outward: Point;
}

export function readBoundary(p: Point, rings: Ring[]): BoundaryReading {
  const kx = EARTH_RADIUS * RAD * Math.cos(p[1] * RAD);
  const ky = EARTH_RADIUS * RAD;
  let best = Infinity;
  let bx = 0;
  let by = 0;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      // Segment a→b in metres east/north of p; closest point to the origin.
      const ax = (ring[j][0] - p[0]) * kx;
      const ay = (ring[j][1] - p[1]) * ky;
      const dx = (ring[i][0] - p[0]) * kx - ax;
      const dy = (ring[i][1] - p[1]) * ky - ay;
      const len2 = dx * dx + dy * dy;
      const t =
        len2 === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2));
      const cx = ax + t * dx;
      const cy = ay + t * dy;
      const d2 = cx * cx + cy * cy;
      if (d2 < best) {
        best = d2;
        bx = cx;
        by = cy;
      }
    }
  }
  const distance = Math.sqrt(best);
  const inside = pointInOutline(p, rings);
  const sign = inside ? 1 : -1;
  return {
    signedDistance: sign * distance,
    nearest: [p[0] + bx / kx, p[1] + by / ky],
    // Inside, the way out is towards the nearest point; outside, away from it.
    outward:
      distance > 1e-6
        ? [(sign * bx) / distance, (sign * by) / distance]
        : [0, 0],
  };
}

export interface FlightLimit {
  /** Metres left before the limit; negative once past it. */
  remaining: number;
  /** Unit vector [east, north] pointing out of the flyable area. */
  outward: Point;
}

/**
 * The flyable area is the outline grown by `margin` metres, cut to `bounds`
 * ([west, south, east, north]) when given. Whichever limit is closer wins.
 */
export function flightLimit(
  p: Point,
  rings: Ring[],
  margin: number,
  bounds?: [number, number, number, number],
): FlightLimit {
  const reading = readBoundary(p, rings);
  let limit: FlightLimit = {
    remaining: reading.signedDistance + margin,
    outward: reading.outward,
  };
  if (bounds) {
    const kx = EARTH_RADIUS * RAD * Math.cos(p[1] * RAD);
    const ky = EARTH_RADIUS * RAD;
    const sides: FlightLimit[] = [
      { remaining: (p[0] - bounds[0]) * kx, outward: [-1, 0] },
      { remaining: (p[1] - bounds[1]) * ky, outward: [0, -1] },
      { remaining: (bounds[2] - p[0]) * kx, outward: [1, 0] },
      { remaining: (bounds[3] - p[1]) * ky, outward: [0, 1] },
    ];
    for (const side of sides)
      if (side.remaining < limit.remaining) limit = side;
  }
  return limit;
}

export type EdgeState = "clear" | "near" | "edge";

/** Which notice to show for the distance left to the limit. */
export function edgeState(
  remaining: number,
  warnAt: number,
  edgeAt: number,
): EdgeState {
  return remaining <= edgeAt ? "edge" : remaining <= warnAt ? "near" : "clear";
}
