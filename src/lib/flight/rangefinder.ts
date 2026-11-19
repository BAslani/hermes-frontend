/**
 * A laser rangefinder over terrain: where a ray from the camera first meets
 * the ground. Marches out in steps that grow with distance, then narrows the
 * crossing down by bisection. Ground that is unknown (NaN, tiles not loaded)
 * is passed over, never hit.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import type { GroundFn } from "./contact.ts";
import type { Vec3 } from "./vec.ts";

export interface RangeReturn {
  /** Distance along the ray, metres. */
  range: number;
  /** Where it hit, local metres. */
  point: Vec3;
}

/** Above this nothing can be hit (Damavand is 5,610 m): a ray climbing past it has missed. */
const CEILING = 6000;

/** `forward` must be a unit vector. Null when nothing is hit within `max` metres. */
export function rangefinder(
  from: Vec3,
  forward: Vec3,
  ground: GroundFn,
  max = 15_000,
): RangeReturn | null {
  const at = (d: number): Vec3 => [
    from[0] + forward[0] * d,
    from[1] + forward[1] * d,
    from[2] + forward[2] * d,
  ];
  const below = (d: number) => {
    const p = at(d);
    return ground(p[0], p[1]) >= p[2];
  };
  if (below(0)) return { range: 0, point: at(0) };
  let near = 0;
  let d = 2;
  while (d <= max) {
    if (below(d)) {
      let far = d;
      for (let i = 0; i < 14; i++) {
        const mid = (near + far) / 2;
        if (below(mid)) far = mid;
        else near = mid;
      }
      return { range: far, point: at(far) };
    }
    if (forward[2] >= 0 && from[2] + forward[2] * d > CEILING) return null;
    near = d;
    d += Math.max(4, d * 0.025);
  }
  return null;
}
