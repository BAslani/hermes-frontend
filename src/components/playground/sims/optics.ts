import type { Map as MapLibreMap } from "maplibre-gl";
import { type DroneState, groundSpeed } from "@/lib/drone-controls";
import { toLngLat } from "@/lib/flight/frame";
import { rangefinder } from "@/lib/flight/rangefinder";
import { normalize, type Vec3 } from "@/lib/flight/vec";
import type { OpticsFrame } from "../DroneOptics";

const RAD = Math.PI / 180;

/**
 * The camera read-outs for a drone: attitude, speeds, heights and the
 * rangefinder's return under the crosshair. The drone flies in rendered
 * (possibly exaggerated) terrain metres; everything shown is real metres.
 * The ray is cast along the rendered view and squashed into real space,
 * so it meets the same ground the crosshair is on and its length is the
 * real slant range.
 */
export function droneOptics(
  map: MapLibreMap,
  state: DroneState,
  groundBelow: number,
  mode: OpticsFrame["mode"],
): OpticsFrame {
  const exaggeration = map.getTerrain()?.exaggeration ?? 1;
  const b = state.heading * RAD;
  const p = state.pitch * RAD;
  const view: Vec3 = [
    Math.sin(b) * Math.sin(p),
    Math.cos(b) * Math.sin(p),
    -Math.cos(p),
  ];
  const ground = (east: number, north: number) => {
    const value = map.queryTerrainElevation(
      toLngLat(state.position, east, north),
    );
    return value === null ? Number.NaN : value / exaggeration;
  };
  const hit = rangefinder(
    [0, 0, state.altitude / exaggeration],
    normalize([view[0], view[1], view[2] / exaggeration]),
    ground,
  );
  let target: OpticsFrame["target"] = null;
  if (hit) {
    const [lng, lat] = toLngLat(state.position, hit.point[0], hit.point[1]);
    target = {
      range: hit.range,
      lat,
      lng,
      elevation: hit.point[2],
      bearing: (Math.atan2(hit.point[0], hit.point[1]) / RAD + 360) % 360,
    };
  }
  return {
    heading: ((state.heading % 360) + 360) % 360,
    pitch: state.pitch - 90,
    roll: state.roll,
    fov: map.getVerticalFieldOfView(),
    speed: groundSpeed(state),
    climb: state.velocity[2] / exaggeration,
    agl: Math.max(0, (state.altitude - groundBelow) / exaggeration),
    msl: state.altitude / exaggeration,
    lat: state.position[1],
    lng: state.position[0],
    target,
    mode,
  };
}
