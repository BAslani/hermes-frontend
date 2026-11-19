import type { TerrainSpecification } from "maplibre-gl";
import { type Course, courseBounds } from "@/config/courses";
import { FLIGHT_SCENES } from "@/config/flights";
import {
  type Airport,
  PLACE_MIN_HEIGHT,
  PLACES,
  type Place,
} from "@/config/playground";
import { parseViewerHash } from "@/lib/drone-flight";
import {
  type Airframe,
  type Airplane,
  airborneAirplane,
  assist,
  type Environment,
  flightData,
  JET_AIRFRAME,
  parkedAirplane,
  RACER_AIRFRAME,
  stepAirplane,
  TRAINER_AIRFRAME,
  windVector,
} from "@/lib/flight/airplane";
import {
  CAMERA_MODES,
  type CameraMode,
  type CameraPose,
  type ChaseState,
  chaseCamera,
  cockpitCamera,
  dragOrbit,
  eyeMatrix,
  mapAngles,
  newOrbit,
  orbitCamera,
} from "@/lib/flight/camera";
import type { GroundFn } from "@/lib/flight/contact";
import { KNOT } from "@/lib/flight/fixed-wing";
import {
  type LngLat,
  needsRebase,
  toLngLat,
  toLocal,
} from "@/lib/flight/frame";
import {
  controlsFrom,
  type HeldKeys,
  moveStick,
  newPilot,
  type PilotState,
  stepFlaps,
  updatePilot,
} from "@/lib/flight/pilot";
import {
  type Gate,
  GhostRecorder,
  headingVector,
  medalFor,
  newRace,
  type Race,
  type RaceEvent,
  sampleGhost,
  screenPoint,
  splitTimes,
  stepRace,
} from "@/lib/flight/race";
import {
  cloneBody,
  FixedStep,
  interpolatePose,
  type RigidBody,
} from "@/lib/flight/rigid-body";
import { findRunway, lineUp, type RunwayLine } from "@/lib/flight/runway";
import { Trail } from "@/lib/flight/trail";
import { add, clamp, rotate, sub, type Vec3 } from "@/lib/flight/vec";
import type { FlightAudio, RaceCue } from "../flight-audio";
import type { PanelBridge } from "../InstrumentPanel";
import type { RaceBridge, RaceStatus } from "../RaceHud";
import { loadRecord, type RaceRecord, saveRecord } from "../race-records";
import type { FlightSettings } from "../settings";
import {
  createAircraftLayer,
  type GateLook,
  MAX_PUFFS,
  type WorldView,
} from "../three/aircraft-layer";
import { JET_EYE } from "../three/jet-model";
import { RACER_EYE } from "../three/racer-model";
import { applyLook, LOOKS } from "../time-of-day";
import { PLACE_KEYS } from "./drone-sim";
import { Journeys, type Sim, type SimHost } from "./types";

export interface AirplaneSim extends Sim {
  /** Line up on the runway at an airport. */
  startAt(airport: Airport): void;
  /** Start a race: airborne before the first gate, after a countdown. */
  startRace(course: Course): void;
}

type Spawn = { airport: Airport } | { place: Place } | { course: Course };

/** A race in progress: gates fixed on the map, the clock, the recording, the best run to beat. */
interface ActiveRace {
  course: Course;
  /** Ring centres on the map with real altitudes, resolved once the terrain there has loaded. */
  gates: { at: LngLat; altitude: number; normal: Vec3; radius: number }[];
  race: Race;
  recorder: GhostRecorder;
  best: RaceRecord | null;
  status: RaceStatus;
}

const AEROWAY_LAYER = "flight-aeroway";
const AIRCRAFT_LAYER = "flight-aircraft";
/** Above this height the gear cannot reach the ground: one elevation sample per step is enough. */
const CONTACT_HEIGHT = 40;
/** Keys the airplane uses, so the page does not scroll or type on them. */
const USED_KEYS = new Set([
  "KeyW",
  "KeyS",
  "KeyA",
  "KeyD",
  "KeyF",
  "KeyV",
  "KeyB",
  "KeyC",
  "KeyR",
  "KeyX",
  "KeyG",
  "BracketLeft",
  "BracketRight",
]);
/** Where the race plane's smoke comes out, body frame. */
const SMOKE_NOZZLE: Vec3 = [-4.85, 0, -0.02];
/** The jet's two engine nozzles, just aft of the exits (measured off the model), body frame. */
const JET_NOZZLES: Vec3[] = [
  [-7.6, 1.29, -0.29],
  [-7.6, -1.29, -0.29],
];
/** Seconds a gate burst lasts. */
const BURST_TIME = 0.7;
/** MapLibre's near plane is brought in to at most this, metres, so a gate or ghost close by is not cut away. */
const MAX_NEAR = 20;

/** The light airplane: fixed-step physics, cameras, runway starts, instruments and sound. */
export function createAirplaneSim(
  host: SimHost,
  deps: {
    panel: PanelBridge;
    race: RaceBridge;
    audio: FlightAudio;
    settings: () => FlightSettings;
    airport: Airport;
    locale: "en";
  },
): AirplaneSim {
  const { map } = host;
  const journeys = new Journeys(map);
  const fixed = new FixedStep();
  const aircraft = createAircraftLayer(AIRCRAFT_LAYER);

  // The physics is in real metres, so the rendered world must be too: no
  // terrain exaggeration while an aircraft is selected. Restored on dispose.
  const terrain: TerrainSpecification | null = map.getTerrain();
  if (terrain && (terrain.exaggeration ?? 1) !== 1)
    map.setTerrain({ ...terrain, exaggeration: 1 });
  const maxZoom = map.getMaxZoom();
  const maxPitch = map.getMaxPitch();
  // A camera a few metres off the runway is a very high zoom; a climbing cockpit looks above the horizon.
  map.setMaxZoom(25);
  map.setMaxPitch(180);
  // The camera goes exactly where the simulation puts it, not wherever the ground under the view centre is.
  map.setCenterClampedToGround(false);

  // Runways come from the basemap's aeroway layer. A source only loads tiles
  // while a visible layer uses it, so add one that draws nothing.
  const sources = map.getStyle().sources;
  const basemap = Object.keys(sources).find((id) => {
    const source = sources[id];
    return (
      source.type === "vector" &&
      "url" in source &&
      typeof source.url === "string" &&
      source.url.includes("/data/141")
    );
  });
  if (basemap && !map.getLayer(AEROWAY_LAYER)) {
    map.addLayer({
      id: AEROWAY_LAYER,
      type: "line",
      source: basemap,
      "source-layer": "aeroway",
      paint: { "line-opacity": 0 },
    });
  }
  map.addLayer(aircraft.layer);

  /**
   * The transform the map renders with. MapLibre 6 keeps it on the map's
   * camera; there is no public way to move the near plane, hence the reach in.
   */
  const transform = () => map._camera.transform;

  let origin: LngLat = deps.airport.center;
  let plane: Airplane | null = null;
  let previous: RigidBody | null = null;
  let pilot: PilotState = newPilot();
  let spawn: Spawn = { airport: deps.airport };
  let mode: CameraMode = "chase";
  let chase: ChaseState = { position: [0, 0, 0], ready: false };
  const orbit = newOrbit();
  let lastGround = 0;
  let disposed = false;
  let active: ActiveRace | null = null;
  /** Puts the map's sky and imagery back after a race's time of day. */
  let restoreLook: (() => void) | null = null;
  /** The race plane's smoke: on by default, X toggles it. */
  let smokeOn = true;
  /** One trail per nozzle: the race plane uses the first, the jet both. */
  const trails = [new Trail(), new Trail()];
  const smokeOffsets = new Float32Array(MAX_PUFFS * 3);
  const smokeAges = new Float32Array(MAX_PUFFS);
  /** Gates flashing just now: index, when, missed or passed. */
  let bursts: { index: number; at: number; missed: boolean }[] = [];
  /** The countdown second last beeped. */
  let lastBeep = 0;

  const cue = (name: RaceCue) => {
    if (deps.settings().sound) deps.audio.cue(name);
  };
  const endLook = () => {
    restoreLook?.();
    restoreLook = null;
  };

  /** The aircraft picked for free flight (races always use the race plane). */
  const freeAirframe = (): Airframe =>
    deps.settings().aircraft === "jet" ? JET_AIRFRAME : TRAINER_AIRFRAME;

  /** Real ground elevation; a tile that has not loaded yet reuses the last value. */
  const elevation = (at: LngLat) => {
    const value = map.queryTerrainElevation(at);
    if (value === null) return lastGround;
    lastGround = value / (map.getTerrain()?.exaggeration ?? 1);
    return lastGround;
  };
  const ground: GroundFn = (east, north) =>
    elevation(toLngLat(origin, east, north));
  const env: Environment = { ground, wind: [0, 0, 0] };

  /** The race gates in the current local frame (the origin moves, the gates do not). */
  const localGates = (): Gate[] =>
    active
      ? active.gates.map((g) => {
          const [east, north] = toLocal(origin, g.at);
          return {
            center: [east, north, g.altitude],
            normal: g.normal,
            radius: g.radius,
          };
        })
      : [];

  /** Race read-outs that change on events only. */
  const publish = (patch: Partial<RaceStatus>) => {
    if (!active) return;
    active.status = { ...active.status, ...patch };
    deps.race.setStatus(active.status);
  };

  const onRaceEvents = (events: RaceEvent[]) => {
    if (!active || events.length === 0) return;
    const { race, best, course } = active;
    for (const event of events) {
      if (event.type === "start") {
        publish({ phase: "racing", countdown: 0 });
        cue("go");
      } else if (event.type === "gate") {
        bursts = [
          ...bursts,
          { index: event.index, at: performance.now() / 1000, missed: false },
        ].slice(-3);
        if (event.index < course.gates.length - 1) cue("gate");
        const bestSplit = best?.splits[event.index];
        publish({
          done: race.next,
          split: {
            index: event.index,
            time: event.time,
            delta:
              typeof bestSplit === "number" ? event.time - bestSplit : null,
          },
        });
      } else if (event.type === "missed") {
        bursts = [
          ...bursts,
          { index: event.index, at: performance.now() / 1000, missed: true },
        ].slice(-3);
        cue("missed");
        publish({ done: race.next, missed: active.status.missed + 1 });
      } else if (event.type === "finish") {
        const newBest = !best || event.total < best.total;
        cue(newBest ? "best" : "finish");
        if (newBest)
          saveRecord(course.id, {
            total: event.total,
            splits: splitTimes(race),
            ghost: active.recorder.frames,
          });
        publish({
          phase: "finished",
          done: course.gates.length,
          finish: {
            time: race.time,
            penalty: race.penalty,
            total: event.total,
            medal: medalFor(event.total, course.medals),
            newBest,
            previousBest: best ? best.total : null,
          },
        });
      }
    }
  };

  const held = (): HeldKeys => ({
    throttleUp: host.keys.has("KeyW"),
    throttleDown: host.keys.has("KeyS"),
    rudderLeft: host.keys.has("KeyA"),
    rudderRight: host.keys.has("KeyD"),
    trimUp: host.keys.has("BracketRight"),
    trimDown: host.keys.has("BracketLeft"),
    brake: host.keys.has("KeyB"),
  });

  /** Point the map camera and the three.js layer at the aircraft, and refresh the read-outs. */
  const present = (dt: number, alpha: number) => {
    if (!plane || !previous) return;
    const pose = interpolatePose(previous, plane.body, alpha);
    let camera: CameraPose;
    const eyePoint =
      plane.frame.id === "racer"
        ? RACER_EYE
        : plane.frame.id === "jet"
          ? JET_EYE
          : undefined;
    if (mode === "cockpit")
      camera = cockpitCamera(pose.position, pose.orientation, eyePoint);
    else if (mode === "orbit")
      camera = orbitCamera(orbit, pose.position, ground);
    else
      camera = chaseCamera(chase, pose.position, pose.orientation, dt, ground);

    const angles = mapAngles(camera.forward, camera.up);
    map.jumpTo(
      map.calculateCameraOptionsFromCameraLngLatAltRotation(
        toLngLat(origin, camera.position[0], camera.position[1]),
        camera.position[2],
        angles.bearing,
        angles.pitch,
        angles.roll,
      ),
    );
    // MapLibre's own near plane sits 1/75 of the way to the view centre: over
    // 100 m when looking at the horizon, which would cut away the runway under
    // a taxiing aircraft. Bring it in when the camera is low.
    const height = Math.max(
      0,
      camera.position[2] - ground(camera.position[0], camera.position[1]),
    );
    const scale = transform().pixelsPerMeter;
    transform().overrideNearFarZ(
      clamp(height * 0.25, 0.4, MAX_NEAR) * scale,
      clamp(4500 * Math.sqrt(Math.max(height, 4)), 30_000, 350_000) * scale,
    );

    const eye = eyeMatrix(angles);
    const now = performance.now() / 1000;
    // Smoke, camera-relative, newest last within each trail; at most MAX_PUFFS over all trails.
    const puffs = trails.flatMap((t) => t.live(now));
    const count = Math.min(puffs.length, MAX_PUFFS);
    const first = puffs.length - count;
    for (let i = 0; i < count; i++) {
      const { position, age } = puffs[first + i];
      smokeOffsets[i * 3] = position[0] - camera.position[0];
      smokeOffsets[i * 3 + 1] = position[1] - camera.position[1];
      smokeOffsets[i * 3 + 2] = position[2] - camera.position[2];
      smokeAges[i] = age;
    }
    const smoke =
      count > 0 ? { offsets: smokeOffsets, ages: smokeAges, count } : null;
    let world: WorldView | undefined = smoke
      ? { gates: [], ghost: null, time: now, bursts: [], smoke }
      : undefined;
    if (active) {
      const { race } = active;
      const finished = race.phase === "finished";
      const gates = localGates();
      const look = (i: number): GateLook =>
        finished || i < race.next
          ? "hidden"
          : i === race.next
            ? "next"
            : i === race.next + 1
              ? "after"
              : "later";
      bursts = bursts.filter((b) => now - b.at < BURST_TIME);
      world = {
        gates: gates.map((g, i) => ({
          offset: sub(g.center, camera.position),
          normal: g.normal,
          radius: g.radius,
          look: look(i),
        })),
        ghost: null,
        time: now,
        bursts: bursts.map((b) => {
          const g = gates[b.index];
          return {
            offset: sub(g.center, camera.position),
            normal: g.normal,
            radius: g.radius,
            age: (now - b.at) / BURST_TIME,
            missed: b.missed,
          };
        }),
        smoke,
      };
      const frames = active.best?.ghost;
      const ghost =
        frames && !finished
          ? sampleGhost(frames, Math.max(0, race.time))
          : null;
      if (ghost) {
        const [east, north] = toLocal(origin, [ghost.lng, ghost.lat]);
        world.ghost = {
          offset: sub([east, north, ghost.altitude], camera.position),
          orientation: ghost.orientation,
        };
      }
      const next = gates[race.next];
      const canvas = map.getCanvas();
      deps.race.push({
        time: race.time,
        penalty: race.penalty,
        arrow:
          next && !finished
            ? screenPoint(
                eye,
                sub(next.center, camera.position),
                map.getVerticalFieldOfView(),
                canvas.width / canvas.height,
              )
            : null,
      });
    }

    aircraft.show({
      eye,
      offset: sub(pose.position, camera.position),
      orientation: pose.orientation,
      fov: map.getVerticalFieldOfView(),
      cockpit: mode === "cockpit",
      surfaces: plane.surfaces,
      flaps: plane.flapAngle,
      rpm: plane.rpm,
      dt,
      pixelsPerMeter: scale,
      model: plane.frame.id,
      gearDown: plane.gearDown,
      light: active ? LOOKS[active.course.look].light : undefined,
      world,
    });
    map.triggerRepaint();

    const data = flightData(plane, env);
    const keys = held();
    deps.panel.push({
      ias: data.ias,
      altitude: data.altitude,
      climb: data.climb,
      heading: data.heading,
      pitch: data.pitch,
      roll: data.roll,
      rpm: data.rpm,
      flaps: data.flaps,
      trim: pilot.trim,
      throttle: pilot.throttle,
      stickX: pilot.stickX,
      stickY: pilot.stickY,
      stall: data.stallWarning,
      brake: keys.brake,
      parkingBrake: pilot.parkingBrake,
    });
    if (deps.settings().sound && host.isFlying() && !plane.crashed) {
      deps.audio.update({
        rpm: plane.rpm,
        throttle: pilot.throttle,
        airspeed: plane.airspeed,
        stall: data.stallWarning,
        jet: plane.frame.id === "jet",
      });
    } else {
      deps.audio.silence();
    }
  };

  /** Runway centrelines among the basemap tiles loaded right now. */
  const runwayLines = (): RunwayLine[] => {
    if (!basemap) return [];
    const lines: RunwayLine[] = [];
    for (const feature of map.querySourceFeatures(basemap, {
      sourceLayer: "aeroway",
    })) {
      if (feature.properties?.class !== "runway") continue;
      const ref =
        typeof feature.properties.ref === "string"
          ? feature.properties.ref
          : undefined;
      const { geometry } = feature;
      if (geometry.type === "LineString")
        lines.push({ points: geometry.coordinates as LngLat[], ref });
      else if (geometry.type === "MultiLineString") {
        for (const part of geometry.coordinates)
          lines.push({ points: part as LngLat[], ref });
      }
    }
    return lines;
  };

  /** In trimmed level flight over a point. */
  const startAirborne = (
    over: LngLat,
    heightAbove: number,
    heading: number,
    speed?: number,
    frame: Airframe = freeAirframe(),
  ) => {
    const settings = deps.settings();
    const wind = windVector(settings.windFrom, settings.windKnots * KNOT);
    origin = over;
    const { airplane, trim } = airborneAirplane(
      [0, 0, elevation(over) + heightAbove],
      heading,
      speed ?? frame.cruise,
      wind,
      frame,
    );
    plane = airplane;
    // Trimmed hands-off: the trim wheel holds the elevator, the yoke is centred.
    pilot = newPilot({
      parkingBrake: false,
      throttle: trim.throttle,
      trim: clamp(trim.elevator / frame.params.trimAuthority, -1, 1),
    });
  };

  const place = (to: Spawn) => {
    const settings = deps.settings();
    active = null;
    endLook();
    for (const t of trails) t.clear();
    bursts = [];
    lastBeep = 0;
    if ("course" in to) {
      const { course } = to;
      // Races are flown in the race plane, in the course's light.
      startAirborne(
        course.start.position,
        course.start.height,
        course.start.heading,
        course.start.speed,
        RACER_AIRFRAME,
      );
      restoreLook = applyLook(map, course.look);
      const best = loadRecord(course.id, course.gates.length);
      const race = newRace(course.gates.length);
      active = {
        course,
        gates: course.gates.map((g) => ({
          at: g.position,
          altitude: elevation(g.position) + g.height,
          normal: headingVector(g.heading),
          radius: g.radius,
        })),
        race,
        recorder: new GhostRecorder(),
        best,
        status: {
          courseName: course.name[deps.locale],
          phase: "countdown",
          countdown: Math.ceil(-race.time),
          done: 0,
          gateCount: course.gates.length,
          split: null,
          missed: 0,
          finish: null,
          hasGhost: (best?.ghost.length ?? 0) > 0,
        },
      };
      deps.race.setStatus(active.status);
    } else if ("airport" in to) {
      const runway = findRunway(runwayLines(), to.airport.center);
      if (runway) {
        const start = lineUp(
          runway,
          settings.windFrom,
          settings.windKnots * KNOT,
        );
        origin = start.position;
        plane = parkedAirplane(
          0,
          0,
          elevation(start.position),
          start.heading,
          freeAirframe(),
        );
        pilot = newPilot();
      } else {
        // No runway in the loaded tiles (the basemap did not arrive): start overhead instead.
        startAirborne(to.airport.center, 600, 270);
      }
    } else {
      const view = to.place.view;
      if ("scene" in view) {
        const saved = parseViewerHash(
          FLIGHT_SCENES.find((s) => s.id === view.scene)!.viewerUrl,
        );
        startAirborne(saved.center, 600, ((saved.bearing % 360) + 360) % 360);
      } else {
        startAirborne(
          view.position,
          Math.max(view.height, PLACE_MIN_HEIGHT),
          view.heading,
        );
      }
    }
    if (!active) deps.race.setStatus(null);
    previous = plane ? cloneBody(plane.body) : null;
    chase = { position: [0, 0, 0], ready: false };
    fixed.reset();
    map.setCenterClampedToGround(false);
    present(0, 1);
  };

  const travel = (to: Spawn) => {
    spawn = to;
    host.keys.clear();
    host.setCrash(null);
    host.setTravelling(to);
    deps.audio.silence();
    aircraft.show(null);
    plane = null;
    active = null;
    deps.race.setStatus(null);
    journeys.start({
      look() {
        // Straight down at the destination, so its elevation, imagery and
        // (for an airport, at zoom 14) its runway geometry load.
        transform().clearNearFarZOverride();
        map.setCenterClampedToGround(true);
        if ("course" in to) {
          // The whole course from above, so the terrain under every gate loads.
          const [west, south, east, north] = courseBounds(to.course);
          const fit = map.cameraForBounds(
            [
              [west, south],
              [east, north],
            ],
            { padding: 80, maxZoom: 13 },
          );
          map.jumpTo({
            center: fit?.center ?? to.course.start.position,
            zoom: fit?.zoom ?? 12,
            bearing: 0,
            pitch: 0,
            roll: 0,
          });
          return;
        }
        const view = "place" in to ? to.place.view : null;
        const center =
          "airport" in to
            ? to.airport.center
            : view && "scene" in view
              ? parseViewerHash(
                  FLIGHT_SCENES.find((s) => s.id === view.scene)!.viewerUrl,
                ).center
              : (view as { position: LngLat }).position;
        map.jumpTo({
          center,
          zoom: "airport" in to ? 14 : 12.5,
          bearing: 0,
          pitch: 0,
          roll: 0,
        });
      },
      place: () => place(to),
      finish() {
        host.setTravelling(null);
        host.ready();
        host.wake();
      },
    });
  };

  travel(spawn);

  return {
    frame(_now, dt) {
      if (!plane || !previous || journeys.active) return false;
      const flying = host.isFlying() && !plane.crashed;
      let alpha = 1;
      if (flying) {
        const settings = deps.settings();
        env.wind = windVector(settings.windFrom, settings.windKnots * KNOT);
        const keys = held();
        const current = plane;
        const gates = localGates();
        alpha = fixed.advance(dt, (h) => {
          previous = cloneBody(current.body);
          if (active?.race.phase === "countdown") {
            // Held still in the air until the start.
            onRaceEvents(
              stepRace(
                active.race,
                gates,
                current.body.position,
                current.body.position,
                h,
              ),
            );
            return;
          }
          updatePilot(pilot, keys, h, settings.selfCentring);
          const controls = controlsFrom(pilot, keys);
          const [east, north, up] = current.body.position;
          const below = ground(east, north);
          env.ground = up - below > CONTACT_HEIGHT ? () => below : ground;
          stepAirplane(
            current,
            settings.assists ? assist(controls, current) : controls,
            env,
            h,
          );
          if (active && !current.crashed) {
            onRaceEvents(
              stepRace(
                active.race,
                gates,
                previous.position,
                current.body.position,
                h,
              ),
            );
          }
        });
        if (active) {
          const { race } = active;
          if (race.phase === "countdown") {
            const countdown = Math.ceil(-race.time);
            if (countdown !== active.status.countdown) publish({ countdown });
            if (countdown !== lastBeep && countdown > 0) cue("count");
            lastBeep = countdown;
          } else if (race.phase === "racing") {
            const { position, orientation } = plane.body;
            const [lng, lat] = toLngLat(origin, position[0], position[1]);
            active.recorder.sample(race.time, {
              lng,
              lat,
              altitude: position[2],
              orientation,
            });
          }
        }
        // Smoke: the race plane's oil smoke in races (after the countdown), the jet's exhaust trails always.
        const nozzles =
          plane.frame.id === "jet"
            ? JET_NOZZLES
            : plane.frame.id === "racer" &&
                active &&
                active.race.phase !== "countdown"
              ? [SMOKE_NOZZLE]
              : [];
        if (smokeOn && !plane.crashed && plane.wheelsDown === 0) {
          const { position, orientation } = plane.body;
          const now = performance.now() / 1000;
          nozzles.forEach((nozzle, i) =>
            trails[i].emit(
              now,
              add(position, rotate(orientation, nozzle)),
              env.wind,
            ),
          );
        } else {
          for (const t of trails) t.cut();
        }
        env.ground = ground;
        if (plane.crashed) host.setCrash(plane.crashed);

        // Keep the numbers small: move the origin under the aircraft now and then.
        const [east, north] = plane.body.position;
        if (needsRebase(east, north)) {
          origin = toLngLat(origin, east, north);
          for (const body of [plane.body, previous])
            body.position = [
              body.position[0] - east,
              body.position[1] - north,
              body.position[2],
            ];
          chase.position = [
            chase.position[0] - east,
            chase.position[1] - north,
            chase.position[2],
          ];
          for (const t of trails) t.shift(east, north);
        }
      }
      present(flying ? dt : 0, alpha);
      return flying;
    },

    keyDown(event) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (USED_KEYS.has(event.code)) event.preventDefault();
      if (!event.repeat) {
        const index = PLACE_KEYS.indexOf(event.code);
        if (index >= 0 && PLACES[index]) this.visit(PLACES[index]);
        else if (event.code === "KeyR") this.reset();
        else if (event.code === "KeyF") stepFlaps(pilot, 1);
        else if (event.code === "KeyV") stepFlaps(pilot, -1);
        else if (event.code === "KeyB" && event.shiftKey)
          pilot.parkingBrake = !pilot.parkingBrake;
        else if (
          event.code === "KeyG" &&
          plane?.frame.retractable &&
          plane.wheelsDown === 0
        ) {
          // Gear lever; not while sitting on the wheels.
          plane.gearCommand = !plane.gearCommand;
        } else if (event.code === "KeyX") {
          smokeOn = !smokeOn;
          for (const t of trails) t.cut();
        } else if (event.code === "KeyC") {
          mode =
            CAMERA_MODES[
              (CAMERA_MODES.indexOf(mode) + 1) % CAMERA_MODES.length
            ];
          chase.ready = false;
        }
      }
      host.wake();
    },

    keyUp() {
      host.wake();
    },

    mouseMove(dx, dy, buttons) {
      // Right drag orbits in the orbit view; everything else is the yoke.
      if (mode === "orbit" && buttons & 2) dragOrbit(orbit, dx, dy);
      else moveStick(pilot, dx, dy);
      host.wake();
    },

    reset() {
      travel(spawn);
    },

    visit(to) {
      travel({ place: to });
    },

    startAt(airport) {
      travel({ airport });
    },

    startRace(course) {
      travel({ course });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      journeys.cancel();
      deps.audio.silence();
      aircraft.show(null);
      host.setCrash(null);
      host.setTravelling(null);
      active = null;
      deps.race.setStatus(null);
      endLook();
      try {
        if (map.getLayer(AIRCRAFT_LAYER)) map.removeLayer(AIRCRAFT_LAYER);
        if (map.getLayer(AEROWAY_LAYER)) map.removeLayer(AEROWAY_LAYER);
        transform().clearNearFarZOverride();
        map.setCenterClampedToGround(true);
        map.setMaxPitch(maxPitch);
        map.setMaxZoom(maxZoom);
        if (terrain) map.setTerrain(terrain);
      } catch {
        /* the map was removed first: nothing left to restore */
      }
    },
  };
}
