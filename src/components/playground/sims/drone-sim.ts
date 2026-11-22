import { FLIGHT_SCENES } from "@/config/flights";
import { IRAN_OUTLINE } from "@/config/iran-outline";
import { START_CAMERA } from "@/config/map";
import {
  EDGE_REACHED_M,
  EDGE_WARNING_KM,
  FLIGHT_BOUNDS,
  FLIGHT_MARGIN_KM,
  PLACES,
  type Place,
} from "@/config/playground";
import {
  createDrone,
  DRONE,
  type DroneInput,
  type DroneState,
  groundSpeed,
  look,
  NO_INPUT,
  step,
} from "@/lib/drone-controls";
import {
  cameraFromView,
  distanceMetres,
  parseViewerHash,
  type ViewerView,
} from "@/lib/drone-flight";
import { ARCADE_TIME_SCALE } from "@/lib/flight/arcade";
import { edgeState, type FlightLimit, flightLimit } from "@/lib/geo-boundary";
import type { OpticsBridge } from "../DroneOptics";
import type { HudStore } from "../hud-store";
import { getSettings } from "../settings";
import { droneOptics } from "./optics";
import { Journeys, type Sim, type SimHost } from "./types";

/** Degrees per pixel of mouse movement. */
const MOUSE_SENSITIVITY = 0.12;
const HUD_INTERVAL_MS = 100;
/** Returning to a start further away than this waits for its tiles, like a jump to a place. */
const NEARBY_M = 30_000;
const START = START_CAMERA;
/** A little flatter than the hero shot: looking ahead, not down. */
const START_VIEW: ViewerView = {
  center: START.center,
  zoom: START.zoom,
  bearing: START.bearing,
  pitch: 72,
};

/** Keys by KeyboardEvent.code, so they work on any keyboard layout (e.g. Persian). */
export const FLIGHT_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "KeyQ",
  "KeyE",
  "KeyC",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
]);
/** 1–9, then 0, jump to the places in menu order. */
export const PLACE_KEYS = [
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "Digit0",
];

export function readInput(keys: Set<string>): DroneInput {
  const axis = (pos: string[], neg: string[]) =>
    (pos.some((k) => keys.has(k)) ? 1 : 0) -
    (neg.some((k) => keys.has(k)) ? 1 : 0);
  return {
    forward: axis(["KeyW"], ["KeyS"]),
    strafe: axis(["KeyD"], ["KeyA"]),
    lift: axis(["Space", "KeyE"], ["KeyC", "KeyQ"]),
    turn: axis(["ArrowRight"], ["ArrowLeft"]),
    tilt: axis(["ArrowUp"], ["ArrowDown"]),
    boost: keys.has("ShiftLeft") || keys.has("ShiftRight"),
    precise: keys.has("AltLeft") || keys.has("AltRight"),
  };
}

const steering = (input: DroneInput) =>
  input.forward !== 0 ||
  input.strafe !== 0 ||
  input.lift !== 0 ||
  input.turn !== 0 ||
  input.tilt !== 0;
const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

type Destination =
  | { place: Place }
  | { state: DroneState }
  | { view: ViewerView };

/** The free-flight drone: today's playground mode. */
export function createDroneSim(
  host: SimHost,
  hud: HudStore,
  optics?: OpticsBridge,
): Sim {
  const { map, container } = host;
  const journeys = new Journeys(map);
  let drone: DroneState | null = null;
  let start: DroneState | null = null;
  /** Set when the view changed outside step() (mouse look, reset). */
  let dirty = true;
  let lastHud = 0;
  let lastGround = 0;

  const cameraFor = (state: DroneState) =>
    map.calculateCameraOptionsFromCameraLngLatAltRotation(
      state.position,
      state.altitude,
      state.heading,
      state.pitch,
      state.roll,
    );

  const publishHud = (
    state: DroneState,
    input: DroneInput,
    limit: FlightLimit,
  ) => {
    // Physics runs in rendered (exaggerated) metres; the readout is real metres.
    const exaggeration = map.getTerrain()?.exaggeration ?? 1;
    hud.set({
      speed: Math.round(groundSpeed(state) * 3.6),
      height: Math.round((state.altitude - lastGround) / exaggeration),
      heading: Math.round(state.heading) % 360,
      ground: Math.round(lastGround / exaggeration),
      lat: round4(state.position[1]),
      lng: round4(state.position[0]),
      mode: input.boost ? "boost" : input.precise ? "precise" : "cruise",
      tilesLoading: !map.areTilesLoaded(),
      edge: edgeState(limit.remaining, EDGE_WARNING_KM * 1000, EDGE_REACHED_M),
    });
  };

  const fromView = (view: ViewerView): DroneState => {
    const pose = cameraFromView(view, {
      height: container.clientHeight,
      fov: map.getVerticalFieldOfView(),
      centerElevation: map.getCenterElevation(),
    });
    const ground =
      map.queryTerrainElevation(pose.position) ?? map.getCenterElevation();
    return createDrone({
      position: pose.position,
      altitude: Math.max(pose.altitude, ground + DRONE.minClearance),
      heading: ((pose.bearing % 360) + 360) % 360,
      pitch: pose.pitch,
      ground,
    });
  };

  /** Jump to a place, a saved view or back to a known state, once the destination has loaded. */
  const travel = (to: Destination, done?: (state: DroneState) => void) => {
    host.keys.clear();
    host.setTravelling("place" in to ? { place: to.place } : {});
    const placeView = "place" in to ? to.place.view : null;
    const view: ViewerView | null =
      "view" in to
        ? to.view
        : placeView && "scene" in placeView
          ? parseViewerHash(
              FLIGHT_SCENES.find((s) => s.id === placeView.scene)!.viewerUrl,
            )
          : null;
    const camera = placeView && "position" in placeView ? placeView : null;

    const place = () => {
      let state: DroneState;
      if ("state" in to) {
        state = to.state;
      } else if (view) {
        state = fromView(view);
      } else {
        const ground =
          map.queryTerrainElevation(camera!.position) ??
          map.getCenterElevation();
        const exaggeration = map.getTerrain()?.exaggeration ?? 1;
        state = createDrone({
          position: camera!.position,
          altitude:
            ground +
            Math.max(camera!.height * exaggeration, DRONE.minClearance),
          heading: ((camera!.heading % 360) + 360) % 360,
          pitch: camera!.pitch,
          ground,
        });
      }
      drone = state;
      lastGround = state.ground;
      dirty = false;
      // From here the camera goes exactly where the drone is. Clamped, MapLibre
      // would move it with the ground under the view centre: the camera bobs
      // over ridges and lurches when looking above the horizon.
      map.setCenterClampedToGround(false);
      map.jumpTo(cameraFor(state));
    };

    journeys.start({
      // First look: the saved view, straight down at a place, or the known state itself.
      look() {
        // Clamped while loading, so a view's centre sits on the real ground and
        // fromView() reads the right elevation.
        map.setCenterClampedToGround(true);
        if ("state" in to) place();
        else if (view) map.jumpTo(view);
        else
          map.jumpTo({
            center: camera!.position,
            zoom: 13,
            bearing: camera!.heading,
            pitch: 0,
          });
      },
      place() {
        if (!("state" in to)) place();
      },
      finish() {
        host.setTravelling(null);
        dirty = true;
        if (drone) done?.(drone);
        host.wake();
      },
    });
  };

  // Take off from the start view. On first load the map is already there and
  // loaded; coming back from another vehicle it has to travel.
  travel({ view: START_VIEW }, (state) => {
    start = state;
    host.ready();
  });

  return {
    frame(now, frameDt) {
      // Arcade flies the drone a little faster than real time.
      const dt =
        getSettings().gameplay === "arcade"
          ? frameDt * ARCADE_TIME_SCALE
          : frameDt;
      // A jump in progress owns the camera; it wakes the loop when it lands.
      if (!drone || journeys.active) return false;
      const current = drone;
      const flying = host.isFlying();
      const input = flying ? readInput(host.keys) : NO_INPUT;
      const e = map.queryTerrainElevation(current.position);
      if (e !== null) lastGround = e;
      const limit = flightLimit(
        current.position,
        IRAN_OUTLINE,
        FLIGHT_MARGIN_KM * 1000,
        FLIGHT_BOUNDS,
      );
      const next = step(current, input, dt, {
        groundBelow: lastGround,
        edge: limit,
        noRoll: host.reducedMotion,
      });
      drone = next;

      // Only move the camera when something changed, so an idle map stops rendering.
      const moving =
        groundSpeed(next) > 0.01 ||
        Math.abs(next.velocity[2]) > 0.01 ||
        Math.abs(next.altitude - current.altitude) > 0.01 ||
        Math.abs(next.ground - current.ground) > 0.01 ||
        Math.abs(next.roll - current.roll) > 0.01 ||
        next.heading !== current.heading ||
        next.pitch !== current.pitch;
      if (moving || dirty) {
        dirty = false;
        map.jumpTo(cameraFor(next));
      }
      optics?.push(
        droneOptics(
          map,
          next,
          lastGround,
          input.boost ? "boost" : input.precise ? "precise" : "cruise",
        ),
      );

      // Keep going while something moves, a key is held, or (in flight) tiles
      // are still arriving: new elevation can change the ground under the drone.
      const busy =
        moving || (flying && (steering(input) || !map.areTilesLoaded()));
      if (!busy || now - lastHud > HUD_INTERVAL_MS) {
        lastHud = now;
        publishHud(next, input, limit);
      }
      return busy;
    },

    keyDown(event) {
      if (
        event.code === "KeyR" &&
        !event.repeat &&
        !event.ctrlKey &&
        !event.metaKey
      )
        this.reset();
      const place = PLACES[PLACE_KEYS.indexOf(event.code)];
      if (
        place &&
        !event.repeat &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      )
        this.visit(place);
      if (FLIGHT_KEYS.has(event.code)) {
        // Arrows and Space would scroll; Alt would open the browser menu.
        event.preventDefault();
        host.wake();
      }
    },

    keyUp(event) {
      if (event.code.startsWith("Alt")) event.preventDefault();
      // One more frame, so the readout drops Boost / Precise.
      host.wake();
    },

    mouseMove(dx, dy) {
      if (!drone) return;
      drone = look(drone, dx * MOUSE_SENSITIVITY, -dy * MOUSE_SENSITIVITY);
      dirty = true;
      host.wake();
    },

    /** R: always the original start point, however far the drone has flown. */
    reset() {
      if (!start || !drone) return;
      if (distanceMetres(drone.position, start.position) > NEARBY_M) {
        travel({ state: start });
        return;
      }
      drone = start;
      dirty = true;
      host.wake();
    },

    visit(place) {
      if (drone) travel({ place });
    },

    dispose() {
      journeys.cancel();
      map.setCenterClampedToGround(true);
      hud.set(null);
      host.setTravelling(null);
    },
  };
}
