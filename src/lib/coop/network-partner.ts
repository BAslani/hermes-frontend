/**
 * The other player's aircraft, from the `state` reports it sends about 15
 * times a second. Between reports it carries on along its last velocity; a new
 * report that disagrees with where it was drawn is blended in over a moment
 * instead of snapping, so the partner never jumps.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import type { Partner, PartnerState } from "../flight/partner.ts";
import { add, scale, sub, type Vec3 } from "../flight/vec.ts";
import type { AircraftReport, Role } from "./protocol.ts";

/** How fast a correction fades, 1/s: most of it gone in about a third of a second. */
const BLEND_RATE = 8;
/** Stop carrying on after this long without a report, s (a stalled connection). */
const MAX_EXTRAPOLATION = 0.5;

export interface NetworkPartner extends Partner {
  report(report: AircraftReport): void;
  /** Whether any report has arrived yet. */
  readonly heard: boolean;
}

export function networkPartner(
  role: Role,
  start: PartnerState,
): NetworkPartner {
  let clock = 0;
  let latest = { ...start, at: 0 };
  let correction: Vec3 = [0, 0, 0];
  let heard = false;

  /** Where the last report puts it now, before any correction. */
  const projected = (): Vec3 =>
    add(
      latest.position,
      scale(latest.velocity, Math.min(clock - latest.at, MAX_EXTRAPOLATION)),
    );

  return {
    get heard() {
      return heard;
    },
    step(dt) {
      clock += dt;
      correction = scale(correction, Math.exp(-BLEND_RATE * dt));
    },
    report(r) {
      const drawn = add(projected(), correction);
      latest = {
        role,
        position: r.position,
        velocity: r.velocity,
        orientation: r.orientation,
        at: clock,
      };
      // The first report places it outright; later ones blend in from where it was drawn.
      correction = heard ? sub(drawn, projected()) : [0, 0, 0];
      heard = true;
    },
    state() {
      return {
        role,
        position: add(projected(), correction),
        velocity: latest.velocity,
        orientation: latest.orientation,
      };
    },
  };
}
