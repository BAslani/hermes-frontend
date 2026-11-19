/**
 * Flies the jet's takeoff the way a player does, with assists on (full power,
 * flaps one step, pull the stick back at about 145 kt, gear up once
 * climbing), for a few stick positions and two habits: easing the stick back
 * to centre two seconds after lift-off, or leaving it where it is. Prints
 * what happens.
 *
 *   node --no-warnings scripts/jet-takeoff-diag.mts
 */
import {
  assist,
  CALM,
  type Environment,
  flightData,
  JET_AIRFRAME,
  parkedAirplane,
  stepAirplane,
} from "../src/lib/flight/airplane.ts";
import { STEP } from "../src/lib/flight/rigid-body.ts";
import { DEG, toAttitude } from "../src/lib/flight/vec.ts";

const FLAT: Environment = { ground: () => 0, wind: CALM };

for (const habit of ["centre", "hold"] as const) {
  for (const stick of [0.2, 0.35, 0.5, 0.7]) {
    const plane = parkedAirplane(0, 0, 0, 0, JET_AIRFRAME);
    let pulled = false;
    let liftoff: number | null = null;
    let rollM = 0;
    let maxAlpha = 0;
    let maxPitch = 0;
    let lowAfter = Infinity;
    let t = 0;
    for (; t < 45 && !plane.crashed; t += STEP) {
      const d = flightData(plane, FLAT);
      if (!pulled && d.ias > 75) pulled = true;
      if (d.onGround) rollM = plane.body.position[1];
      if (liftoff === null && !d.onGround && plane.body.position[2] > 4)
        liftoff = t;
      if (liftoff !== null) {
        lowAfter = Math.min(lowAfter, d.agl);
        if (plane.gearCommand && d.climb > 3 && d.agl > 20)
          plane.gearCommand = false;
      }
      maxAlpha = Math.max(maxAlpha, plane.alpha * DEG);
      maxPitch = Math.max(maxPitch, toAttitude(plane.body.orientation).pitch);
      const centred = habit === "centre" && liftoff !== null && t > liftoff + 2;
      const pitch = !pulled ? 0 : centred ? 0 : stick;
      stepAirplane(
        plane,
        assist(
          { pitch, roll: 0, yaw: 0, throttle: 1, flaps: 1, trim: 0, brake: 0 },
          plane,
        ),
        FLAT,
        STEP,
      );
    }
    const d = flightData(plane, FLAT);
    console.log(
      `${habit} ${stick}: roll ${rollM.toFixed(0)} m, liftoff ${liftoff?.toFixed(1) ?? "-"} s, max α ${maxAlpha.toFixed(1)}°, max pitch ${maxPitch.toFixed(0)}°,`,
      `lowest after liftoff ${lowAfter === Infinity ? "-" : lowAfter.toFixed(1)} m →`,
      plane.crashed
        ? `CRASHED (${plane.crashed.part ?? plane.crashed.cause}) at ${t.toFixed(1)} s`
        : `ok: ${d.agl.toFixed(0)} m up, ${(d.ias / 0.5144).toFixed(0)} kt, pitch ${d.pitch.toFixed(0)}°`,
    );
  }
}
