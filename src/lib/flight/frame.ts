/**
 * The local frame the flight models integrate in: metres east, north and up
 * from an origin on the map. Positions stay small numbers near the origin, so
 * float64 keeps sub-millimetre precision; the origin moves with the aircraft.
 *
 * The mapping is an equirectangular projection about the origin. Its axes
 * point true east and north everywhere, so moving the origin needs no
 * rotation, and over the 20 km the origin may lag it stretches east-west
 * distances by at most about 0.3 %.
 *
 * Keep this file import-free: Node runs the tests on it directly.
 */

export type LngLat = [number, number];

const EARTH_RADIUS = 6371008.8;
const RAD = Math.PI / 180;

/** Move the origin once the aircraft is this far from it, metres. */
export const REBASE_DISTANCE = 20_000;

export function toLngLat(origin: LngLat, east: number, north: number): LngLat {
  return [
    origin[0] + east / (EARTH_RADIUS * RAD * Math.cos(origin[1] * RAD)),
    origin[1] + north / (EARTH_RADIUS * RAD),
  ];
}

export function toLocal(origin: LngLat, [lng, lat]: LngLat): [number, number] {
  return [
    (lng - origin[0]) * EARTH_RADIUS * RAD * Math.cos(origin[1] * RAD),
    (lat - origin[1]) * EARTH_RADIUS * RAD,
  ];
}

export const needsRebase = (east: number, north: number) =>
  Math.hypot(east, north) > REBASE_DISTANCE;

/** Great-circle-free distance and bearing between two nearby points (metres, degrees from north). */
export function rangeAndBearing(
  from: LngLat,
  to: LngLat,
): { distance: number; bearing: number } {
  const [east, north] = toLocal(from, to);
  return {
    distance: Math.hypot(east, north),
    bearing: (Math.atan2(east, north) / RAD + 360) % 360,
  };
}
