import type { TerrainSpecification } from "maplibre-gl";
import { FLIGHT_SCENES } from "@/config/flights";
import { MISSIONS, type MissionConfig, missionBounds } from "@/config/missions";
import { type Airport, PLACES, type Place } from "@/config/playground";
import { parseViewerHash } from "@/lib/drone-flight";
import { windVector } from "@/lib/flight/airplane";
import {
  type Avalanche,
  moving,
  overruns,
  releaseAvalanche,
  shiftAvalanche,
  stepAvalanche,
} from "@/lib/flight/avalanche";
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
  HELI,
  type Helicopter,
  type HeliEnvironment,
  heliAssist,
  heliData,
  hoveringHelicopter,
  parkedHelicopter,
  stepHelicopter,
} from "@/lib/flight/helicopter";
import { findLandingZone } from "@/lib/flight/landing-zone";
import {
  failMission,
  HOIST_DRIFT,
  HOIST_MAX,
  HOIST_MIN,
  type MissionEvent,
  type MissionSpec,
  type MissionState,
  missionMedal,
  newMission,
  relation,
  scoreMission,
  stepMission,
  stepProgress,
} from "@/lib/flight/mission";
import {
  type HeldKeys,
  moveStick,
  newPilot,
  type PilotState,
  shaped,
  updatePilot,
} from "@/lib/flight/pilot";
import { screenPoint } from "@/lib/flight/race";
import {
  cloneBody,
  FixedStep,
  interpolatePose,
  type RigidBody,
} from "@/lib/flight/rigid-body";
import { Trail } from "@/lib/flight/trail";
import { add, clamp, rotate, sub, type Vec3 } from "@/lib/flight/vec";
import { type StormSpec, stormStrength, stormWind } from "@/lib/flight/weather";
import type { FlightAudio, RaceCue } from "../flight-audio";
import type { PanelBridge } from "../InstrumentPanel";
import type { HoistHint, MissionBridge, MissionStatus } from "../MissionHud";
import {
  loadMissionRecord,
  type MissionRecord,
  saveMissionRecord,
} from "../mission-records";
import type { FlightSettings } from "../settings";
import {
  createAircraftLayer,
  MAX_AVALANCHE_PUFFS,
  MAX_MARKER_PUFFS,
  type WorldView,
} from "../three/aircraft-layer";
import { HELI_EYE } from "../three/heli-model";
import { stormLook } from "../time-of-day";
import { PLACE_KEYS } from "./drone-sim";
import { Journeys, type Sim, type SimHost, setNearFar } from "./types";

export interface HeliSim extends Sim {
  /** Stand on the ground at an airfield. */
  startAt(airport: Airport): void;
  /** Start a rescue or delivery mission at its base. */
  startMission(mission: MissionConfig): void;
}

type Spawn =
  | { airport: Airport }
  | { place: Place }
  | { mission: MissionConfig };

/** A mission in progress. Sites stay on the map; their local positions follow the origin. */
interface ActiveMission {
  config: MissionConfig;
  state: MissionState;
  /** Ground elevation under each step's site, refined as closer tiles load. */
  grounds: number[];
  best: MissionRecord | null;
  status: MissionStatus;
  /** People already delivered, standing by a pad: map position and ground. */
  delivered: { at: LngLat; ground: number }[];
  /** The storm's grip on the map's sky and imagery, while there is one. */
  look: ReturnType<typeof stormLook> | null;
  /** When the avalanche's step started being worked (mission time), and the avalanche once released. */
  avalancheArmed: number | null;
  avalanche: Avalanche | null;
}

/** The hoist hangs from the cabin roof on the right, body frame. */
const HOIST_ARM: Vec3 = [0.9, -1.3, 0.95];
/** Seconds between marker smoke puffs. */
const MARKER_INTERVAL = 0.08;
/** A touchdown harder than this flashes a notice, m/s. */
const HARD_TOUCHDOWN = 1.5;
/** Lumps in an avalanche. */
const AVALANCHE_LUMPS = 40;
/** The avalanche takes the patient if a moving lump comes this close to them, metres. */
const AVALANCHE_REACH = 25;
/** A helicopter lower than this over the ground, this close to a moving lump, is swept away, metres. */
const AVALANCHE_HEIGHT = 12;
const AVALANCHE_HIT = 18;
/** Generated missions: villages this far from the base, metres. */
const VILLAGE_MIN = 5000;
const VILLAGE_MAX = 22_000;
/** The basemap's places, kept loaded by a layer that draws nothing. */
const PLACE_LAYER = "flight-places";

const LAYER = "flight-helicopter";
/** Keys the helicopter uses, so the page does not scroll or type on them. */
const USED_KEYS = new Set(["KeyW", "KeyS", "KeyA", "KeyD", "KeyC", "KeyR"]);
/** Above this the skids cannot reach the ground: one elevation sample per step is enough. */
const CONTACT_HEIGHT = 30;
/** Jumping to a place this high starts in a hover rather than on the ground, metres. */
const HOVER_ABOVE = 1200;

/**
 * The helicopter: fixed-step physics, cameras, starts on the ground (at an
 * airfield or a place), instruments and sound. Collective on W/S (with
 * assists: a climb-rate lever, middle = hover), cyclic on the mouse, pedals
 * on A/D.
 */
export function createHeliSim(
  host: SimHost,
  deps: {
    panel: PanelBridge;
    mission: MissionBridge;
    audio: FlightAudio;
    settings: () => FlightSettings;
    airport: Airport;
    locale: "en";
  },
): HeliSim {
  const { map } = host;
  const journeys = new Journeys(map);
  const fixed = new FixedStep();
  const aircraft = createAircraftLayer(LAYER);

  // Real metres in the rendered world too (see airplane-sim).
  const terrain: TerrainSpecification | null = map.getTerrain();
  if (terrain && (terrain.exaggeration ?? 1) !== 1)
    map.setTerrain({ ...terrain, exaggeration: 1 });
  const maxZoom = map.getMaxZoom();
  const maxPitch = map.getMaxPitch();
  map.setMaxZoom(25);
  map.setMaxPitch(180);
  map.setCenterClampedToGround(false);
  map.addLayer(aircraft.layer);
  // Villages come from the basemap's place layer. A source only loads tiles
  // while a visible layer uses it, so add one that draws nothing.
  const styleSources = map.getStyle().sources;
  const basemap = Object.keys(styleSources).find((id) => {
    const source = styleSources[id];
    return (
      source.type === "vector" &&
      "url" in source &&
      typeof source.url === "string" &&
      source.url.includes("/data/141")
    );
  });
  if (basemap && !map.getLayer(PLACE_LAYER)) {
    map.addLayer({
      id: PLACE_LAYER,
      type: "circle",
      source: basemap,
      "source-layer": "place",
      paint: { "circle-opacity": 0, "circle-radius": 1 },
    });
  }
  const transform = () => map._camera.transform;

  let origin: LngLat = deps.airport.center;
  let heli: Helicopter | null = null;
  let previous: RigidBody | null = null;
  let pilot: PilotState = newPilot();
  let spawn: Spawn = { airport: deps.airport };
  let mode: CameraMode = "chase";
  let chase: ChaseState = { position: [0, 0, 0], ready: false };
  const orbit = newOrbit();
  let lastGround = 0;
  /** The ground height the helicopter was set on, to re-seat it once closer tiles load. */
  let placedGround = 0;
  let disposed = false;
  let active: ActiveMission | null = null;
  const marker = new Trail(9, MARKER_INTERVAL, MAX_MARKER_PUFFS);
  const avalancheOffsets = new Float32Array(MAX_AVALANCHE_PUFFS * 3);
  const avalancheAges = new Float32Array(MAX_AVALANCHE_PUFFS);
  const endMission = () => {
    active?.look?.restore();
    active = null;
  };

  /**
   * A call-out built from the map: a village from the basemap's place layer
   * 5–22 km from the base (among the tiles loaded now), a landing zone on the
   * terrain beside it, supplies or a patient, sometimes a storm. Null when no
   * village with flat ground nearby is found.
   */
  const generateMission = (template: MissionConfig): MissionConfig | null => {
    if (!basemap) return null;
    const base = template.base.position;
    const seen = new Set<string>();
    const villages: { at: LngLat; name: { en: string }; distance: number }[] =
      [];
    for (const feature of map.querySourceFeatures(basemap, {
      sourceLayer: "place",
    })) {
      const props = feature.properties ?? {};
      if (!["village", "hamlet"].includes(String(props.class))) continue;
      if (feature.geometry.type !== "Point") continue;
      const at = feature.geometry.coordinates as LngLat;
      const local = String(props.name ?? "");
      const en = String(
        props["name:en"] ?? props["name:latin"] ?? props.name_en ?? local,
      );
      const key = `${local}|${at[0].toFixed(3)}|${at[1].toFixed(3)}`;
      if (!en || seen.has(key)) continue;
      seen.add(key);
      const [e, n] = toLocal(base, at);
      const distance = Math.hypot(e, n);
      if (distance >= VILLAGE_MIN && distance <= VILLAGE_MAX)
        villages.push({ at, name: { en }, distance });
    }
    // Shuffle, then take the first with flat ground beside it.
    for (let i = villages.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [villages[i], villages[j]] = [villages[j], villages[i]];
    }
    // Only ground whose tiles have loaded: NaN elsewhere, which the finder rejects.
    const groundAt: (e: number, n: number) => number = (e, n) =>
      loadedElevation(toLngLat(base, e, n)) ?? Number.NaN;
    for (const village of villages.slice(0, 12)) {
      const [e, n] = toLocal(base, village.at);
      const zone = findLandingZone(groundAt, e, n, 600, 22, 40);
      if (!zone) continue;
      const lz = toLngLat(base, zone.east, zone.north);
      const patient = Math.random() < 0.5;
      const flight = village.distance * (patient ? 2 : 1);
      const storm: StormSpec | undefined =
        Math.random() < 0.5
          ? {
              startWind: 3,
              fullWind: 11,
              from: 270 + Math.random() * 60,
              veer: 30,
              buildUp: 240,
              gustiness: 0.3,
              seed: Math.floor(Math.random() * 1e6),
            }
          : undefined;
      const name = {
        en: (patient ? "Patient at {v}" : "Supplies for {v}").replace(
          "{v}",
          village.name.en,
        ),
      };
      const site = { position: lz, radius: 22, name: village.name };
      return {
        ...template,
        name,
        base: {
          ...template.base,
          heading: Math.round(((Math.atan2(e, n) * 180) / Math.PI + 360) % 360),
        },
        startsWithCargo: !patient,
        steps: patient
          ? [
              { kind: "land", role: "pick-patient", hold: 8, ...site },
              {
                kind: "land",
                role: "drop-patient",
                hold: 4,
                position: base,
                radius: template.base.radius,
                name: template.base.name,
              },
            ]
          : [{ kind: "land", role: "drop-cargo", hold: 6, ...site }],
        par: Math.round(flight / 55 + 90),
        patientDeadline: patient
          ? Math.round(village.distance / 50 + 150)
          : undefined,
        storm,
      };
    }
    return null;
  };
  const markerOffsets = new Float32Array(MAX_MARKER_PUFFS * 3);
  const markerAges = new Float32Array(MAX_MARKER_PUFFS);

  const cue = (name: RaceCue) => {
    if (deps.settings().sound) deps.audio.cue(name);
  };
  /** Ground elevation where tiles have loaded; null otherwise (never a stale guess). */
  const loadedElevation = (at: LngLat) => {
    const value = map.queryTerrainElevation(at);
    return value === null
      ? null
      : value / (map.getTerrain()?.exaggeration ?? 1);
  };

  /** The mission's steps in today's local frame. */
  const missionSpec = (): MissionSpec | null => {
    if (!active) return null;
    const { config, grounds } = active;
    return {
      fuel: config.fuel,
      par: config.par,
      patientDeadline: config.patientDeadline,
      steps: config.steps.map((step, i) => {
        const [east, north] = toLocal(origin, step.position);
        return {
          kind: step.kind,
          role: step.role,
          at: [east, north, grounds[i]] as Vec3,
          radius: step.radius,
          hold: step.hold,
        };
      }),
    };
  };

  const publish = (patch: Partial<MissionStatus>) => {
    if (!active) return;
    active.status = { ...active.status, ...patch };
    deps.mission.setStatus(active.status);
  };

  /** The status line for the current step. */
  const stepStatus = (): Partial<MissionStatus> => {
    if (!active) return {};
    const step = active.config.steps[active.state.step];
    return {
      stepIndex: Math.min(active.state.step, active.config.steps.length - 1),
      role: step?.role ?? null,
      place: step ? step.name[deps.locale] : "",
      kind: step?.kind ?? null,
      patientOnBoard: active.state.patientOnBoard,
      cargoOnBoard: active.state.cargoOnBoard,
      patientLate: active.state.patientLate,
      phase: active.state.phase,
      failure: active.state.failure,
    };
  };

  const onMissionEvents = (events: MissionEvent[]) => {
    if (!active || events.length === 0) return;
    const { config, state } = active;
    for (const event of events) {
      if (event.type === "step") {
        cue("gate");
        const step = config.steps[event.index];
        if (step.role === "drop-patient")
          active.delivered.push({
            at: step.position,
            ground: active.grounds[event.index],
          });
        publish(stepStatus());
      } else if (event.type === "touchdown") {
        if (event.sink > HARD_TOUCHDOWN)
          publish({ hardTouchdowns: active.status.hardTouchdowns + 1 });
      } else if (event.type === "patient-late") {
        publish({ patientLate: true });
      } else if (event.type === "failed") {
        cue("missed");
        publish(stepStatus());
      } else if (event.type === "done") {
        const spec = missionSpec()!;
        const score = scoreMission(state, spec);
        const best = active.best;
        const newBest = !best || score.total > best.score;
        if (newBest)
          saveMissionRecord(config.id, {
            score: score.total,
            time: state.time,
          });
        cue(newBest ? "best" : "finish");
        publish({
          ...stepStatus(),
          result: {
            score,
            time: state.time,
            medal: missionMedal(score.total, config.medals),
            newBest,
            previousBest: best ? best.score : null,
          },
        });
      }
    }
  };

  const elevation = (at: LngLat) => {
    const value = map.queryTerrainElevation(at);
    if (value === null) return lastGround;
    lastGround = value / (map.getTerrain()?.exaggeration ?? 1);
    return lastGround;
  };
  const ground: GroundFn = (east, north) =>
    elevation(toLngLat(origin, east, north));
  const env: HeliEnvironment = { ground, wind: [0, 0, 0] };

  const held = (): HeldKeys => ({
    throttleUp: host.keys.has("KeyW"),
    throttleDown: host.keys.has("KeyS"),
    rudderLeft: host.keys.has("KeyA"),
    rudderRight: host.keys.has("KeyD"),
    trimUp: false,
    trimDown: false,
    brake: false,
  });

  /** Markers, people, hoist cable and smoke for the mission, and the HUD's per-frame read-outs. */
  const missionWorld = (
    eye: ReturnType<typeof eyeMatrix>,
    camera: CameraPose,
    at: Vec3,
    orientation: [number, number, number, number],
  ): WorldView | undefined => {
    if (!active || !heli) return undefined;
    const spec = missionSpec()!;
    const { state, config } = active;
    const rel = (p: Vec3) => sub(p, camera.position);
    const step = spec.steps[state.step];
    const flying = state.phase === "flying";
    const now = performance.now() / 1000;

    // Pads for every landing step and the base; the current one highlighted.
    const pads: NonNullable<WorldView["pads"]> = spec.steps
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.kind === "land")
      .map(({ s, i }) => ({
        offset: rel(s.at),
        radius: s.radius,
        active: flying && i === state.step,
      }));

    // Orange smoke over the current target, drifting with the wind.
    if (flying && step)
      marker.emit(
        now,
        [step.at[0], step.at[1], step.at[2] + 1],
        add(env.wind, [0, 0, 0.4]),
      );
    else marker.cut();
    const puffs = marker.live(now);
    puffs.forEach(({ position, age }, i) => {
      const o = rel(position);
      markerOffsets.set(o, i * 3);
      markerAges[i] = age;
    });

    // People: the patient waiting at their step (beside a landing zone, or on
    // the hoist spot), riding the hoist, and those delivered.
    const people: Vec3[] = [];
    let cable: WorldView["cable"] = null;
    const progress = stepProgress(state, spec);
    const arm = add(at, rotate(orientation, HOIST_ARM));
    const waiting = spec.steps.findIndex(
      (s, i) => i >= state.step && s.role === "pick-patient",
    );
    if (flying && waiting >= 0) {
      const s = spec.steps[waiting];
      const feet: Vec3 =
        s.kind === "hoist"
          ? s.at
          : [s.at[0] + s.radius * 0.6, s.at[1], s.at[2]];
      if (
        waiting === state.step &&
        s.kind === "hoist" &&
        (progress > 0 || relation(craft(), s).distance <= s.radius)
      ) {
        // Lower (0–40 %), hook on (40–60 %), raise (60–100 %).
        const drop = Math.max(0, arm[2] - s.at[2]);
        const out =
          progress < 0.4
            ? progress / 0.4
            : progress < 0.6
              ? 1
              : 1 - (progress - 0.6) / 0.4;
        const hook: Vec3 = [arm[0], arm[1], arm[2] - drop * out];
        cable = { from: rel(arm), to: rel(hook) };
        people.push(
          rel(progress < 0.6 ? feet : [hook[0], hook[1], hook[2] - 1.7]),
        );
      } else {
        people.push(rel(feet));
      }
    }
    for (const d of active.delivered) {
      const [east, north] = toLocal(origin, d.at);
      people.push(rel([east + 8, north + 4, d.ground]));
    }

    // The HUD.
    if (step) {
      const c = craft();
      const r = relation(c, step);
      const groundSpeed = Math.hypot(
        heli.body.velocity[0],
        heli.body.velocity[1],
      );
      const canvas = map.getCanvas();
      let hint: HoistHint = null;
      if (flying && step.kind === "hoist" && r.distance <= step.radius * 3) {
        hint =
          r.distance > step.radius
            ? "not-over"
            : r.height < HOIST_MIN
              ? "too-low"
              : r.height > HOIST_MAX
                ? "too-high"
                : r.drift > HOIST_DRIFT
                  ? "drifting"
                  : "ready";
      } else if (
        flying &&
        step.kind === "land" &&
        heli.skidsDown >= 3 &&
        r.distance <= step.radius
      ) {
        hint = "landed";
      }
      deps.mission.push({
        time: state.time,
        fuel: state.fuel / config.fuel,
        fuelKg: state.fuel,
        wind: config.storm ? Math.hypot(env.wind[0], env.wind[1]) : null,
        distance: r.distance,
        eta: groundSpeed > 5 ? r.distance / groundSpeed : null,
        progress,
        hint,
        arrow: flying
          ? screenPoint(
              eye,
              rel([step.at[0], step.at[1], step.at[2] + 10]),
              map.getVerticalFieldOfView(),
              canvas.width / canvas.height,
            )
          : null,
      });
    }

    return {
      gates: [],
      ghost: null,
      time: now,
      bursts: [],
      smoke: null,
      pads,
      beacon: flying && step ? rel(step.at) : null,
      people,
      cable,
      markerSmoke: puffs.length
        ? { offsets: markerOffsets, ages: markerAges, count: puffs.length }
        : null,
      snow: config.storm
        ? {
            intensity: stormStrength(config.storm as StormSpec, state.time),
            wind: env.wind,
            camera: camera.position,
            time: now,
          }
        : null,
      avalanche: avalanchePuffs(rel),
    };
  };

  /**
   * The avalanche drawn as big puffs: each moving lump billows (a puff on it
   * and two trailing behind along its track), lumps at rest settle and fade.
   */
  const avalanchePuffs = (rel: (p: Vec3) => Vec3): WorldView["avalanche"] => {
    const av = active?.avalanche;
    if (!av) return null;
    let count = 0;
    const put = (p: Vec3, age: number) => {
      if (count >= MAX_AVALANCHE_PUFFS) return;
      avalancheOffsets.set(rel(p), count * 3);
      avalancheAges[count] = Math.min(1, Math.max(0, age));
      count++;
    };
    for (const lump of av.lumps) {
      const [x, y, z] = lump.position;
      if (lump.resting >= 0) {
        if (lump.resting < 8) put([x, y, z + 3], 0.4 + lump.resting / 12);
        continue;
      }
      const [vx, vy] = lump.velocity;
      put([x, y, z + 4], 0.15);
      put([x - vx * 0.35, y - vy * 0.35, z + 7], 0.4);
      put([x - vx * 0.8, y - vy * 0.8, z + 10], 0.65);
    }
    return count
      ? { offsets: avalancheOffsets, ages: avalancheAges, count }
      : null;
  };

  /**
   * The avalanche: armed when work starts at its step, released `delay`
   * seconds later from `above` metres up the fall line, then run on the
   * terrain. It takes the patient if it reaches them first, and sweeps away a
   * helicopter hovering low in its path.
   */
  const runAvalanche = (dt: number) => {
    if (!active || !heli) return;
    const spec = active.config.avalanche;
    const plan = missionSpec();
    if (!spec || !plan) return;
    const { state } = active;
    const site = plan.steps[spec.step];
    if (!active.avalanche) {
      if (state.phase !== "flying" || state.step !== spec.step) return;
      if (active.avalancheArmed === null && stepProgress(state, plan) > 0)
        active.avalancheArmed = state.time;
      if (
        active.avalancheArmed === null ||
        state.time - active.avalancheArmed < spec.delay
      )
        return;
      // Walk up the fall line from the site to the crown.
      let [x, y] = [site.at[0], site.at[1]];
      for (let d = 0; d < spec.above; d += 10) {
        const gx = ground(x + 6, y) - ground(x - 6, y);
        const gy = ground(x, y + 6) - ground(x, y - 6);
        const len = Math.hypot(gx, gy) || 1;
        x += (gx / len) * 10;
        y += (gy / len) * 10;
      }
      active.avalanche = releaseAvalanche(
        [x, y, ground(x, y)],
        ground,
        spec.width,
        AVALANCHE_LUMPS,
        Math.floor(state.time * 1000),
      );
      cue("missed");
      publish({ avalanche: true });
      return;
    }
    const av = active.avalanche;
    if (moving(av) === 0) return;
    stepAvalanche(av, ground, Math.min(dt, 0.05));
    if (
      state.phase === "flying" &&
      !state.patientOnBoard &&
      state.step <= spec.step &&
      overruns(av, site.at, AVALANCHE_REACH)
    ) {
      onMissionEvents(failMission(state, "avalanche"));
    }
    const [hx, hy, hz] = heli.body.position;
    if (
      hz - ground(hx, hy) < AVALANCHE_HEIGHT &&
      overruns(av, [hx, hy, hz], AVALANCHE_HIT)
    ) {
      heli.crashed = { cause: "structure", part: "avalanche" };
    }
  };

  /** What the mission rules need about the helicopter. */
  const craft = () => ({
    position: heli!.body.position,
    velocity: heli!.body.velocity,
    skidsDown: heli!.skidsDown,
    sinkRate: heli!.sinkRate,
    power: heli!.power,
    crashed: heli!.crashed !== null,
  });

  const present = (dt: number, alpha: number) => {
    if (!heli || !previous) return;
    const pose = interpolatePose(previous, heli.body, alpha);
    let camera: CameraPose;
    if (mode === "cockpit")
      camera = cockpitCamera(pose.position, pose.orientation, HELI_EYE);
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
    const height = Math.max(
      0,
      camera.position[2] - ground(camera.position[0], camera.position[1]),
    );
    const scale = transform().pixelsPerMeter;
    setNearFar(map, height);

    const eye = eyeMatrix(angles);
    let world: WorldView | undefined;
    if (active)
      world = missionWorld(eye, camera, pose.position, pose.orientation);

    aircraft.show({
      eye,
      offset: sub(pose.position, camera.position),
      orientation: pose.orientation,
      fov: map.getVerticalFieldOfView(),
      cockpit: mode === "cockpit",
      surfaces: { elevator: 0, aileron: 0, rudder: 0 },
      flaps: 0,
      rpm: (heli.rotorSpeed / HELI.rotor.omega) * 100,
      dt,
      pixelsPerMeter: scale,
      model: "heli",
      gearDown: 1,
      world,
    });
    map.triggerRepaint();

    const data = heliData(heli, env);
    deps.panel.push({
      ias: data.ias,
      altitude: data.altitude,
      climb: data.climb,
      heading: data.heading,
      pitch: data.pitch,
      roll: data.roll,
      // The panel's engine dial reads rotor %, its flap marker torque %.
      rpm: data.rotor,
      flaps: clamp(data.torque, 0, 100) * 0.3,
      trim: 0,
      throttle: pilot.throttle,
      stickX: pilot.stickX,
      stickY: pilot.stickY,
      stall: data.lowRotor,
      brake: data.vortexRing,
      parkingBrake: false,
    });
    if (deps.settings().sound && host.isFlying() && !heli.crashed) {
      deps.audio.update({
        rpm: data.rotor,
        throttle: clamp(data.torque / 100, 0, 1),
        airspeed: heli.airspeed,
        stall: data.lowRotor,
        heli: true,
      });
    } else {
      deps.audio.silence();
    }
  };

  /** On the ground at a point, collective down. */
  const standAt = (at: LngLat, heading: number) => {
    origin = at;
    heli = parkedHelicopter(0, 0, elevation(at), heading);
    pilot = newPilot({ parkingBrake: false, throttle: 0 });
  };

  /** In a hover, lever at its middle (with assists that holds the hover). */
  const hoverAt = (at: LngLat, heightAbove: number, heading: number) => {
    origin = at;
    const start = hoveringHelicopter(
      [0, 0, elevation(at) + heightAbove],
      heading,
    );
    heli = start.heli;
    pilot = newPilot({
      parkingBrake: false,
      throttle: deps.settings().assists ? 0.5 : start.collective,
    });
  };

  const place = (to: Spawn) => {
    endMission();
    marker.clear();
    if ("mission" in to) {
      // A generated call-out with no village found among the loaded tiles falls back to the first mission.
      const config = to.mission.generated
        ? (generateMission(to.mission) ?? MISSIONS[0])
        : to.mission;
      standAt(config.base.position, config.base.heading);
      const state = newMission(
        {
          fuel: config.fuel,
          par: config.par,
          patientDeadline: config.patientDeadline,
          steps: [],
        },
        config.startsWithCargo,
      );
      active = {
        config,
        state,
        grounds: config.steps.map(
          (s) => loadedElevation(s.position) ?? elevation(s.position),
        ),
        best: loadMissionRecord(config.id),
        delivered: [],
        look: config.storm ? stormLook(map) : null,
        avalancheArmed: null,
        avalanche: null,
        status: {
          name: config.name[deps.locale],
          role: null,
          place: "",
          stepIndex: 0,
          stepCount: config.steps.length,
          kind: null,
          phase: "flying",
          failure: null,
          patientOnBoard: false,
          cargoOnBoard: Boolean(config.startsWithCargo),
          patientLate: false,
          hardTouchdowns: 0,
          avalanche: false,
          result: null,
        },
      };
      active.status = { ...active.status, ...stepStatus() };
      deps.mission.setStatus(active.status);
    } else if ("airport" in to) {
      standAt(to.airport.center, 0);
    } else {
      const view = to.place.view;
      const [at, heading] =
        "scene" in view
          ? (() => {
              const saved = parseViewerHash(
                FLIGHT_SCENES.find((s) => s.id === view.scene)!.viewerUrl,
              );
              return [
                saved.center,
                ((saved.bearing % 360) + 360) % 360,
              ] as const;
            })()
          : ([view.position, view.heading] as const);
      // Places whose view is high above the ground (a peak seen from afar) start in a hover there.
      const height = "scene" in view ? 0 : view.height;
      if (height > HOVER_ABOVE) hoverAt(at, 150, heading);
      else standAt(at, heading);
    }
    if (!active) deps.mission.setStatus(null);
    placedGround = elevation(origin);
    previous = heli ? cloneBody(heli.body) : null;
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
    heli = null;
    endMission();
    deps.mission.setStatus(null);
    journeys.start({
      look() {
        transform().clearNearFarZOverride();
        map.setCenterClampedToGround(true);
        if ("mission" in to && to.mission.generated) {
          // The country around the base, so its villages and terrain load.
          map.jumpTo({
            center: to.mission.base.position,
            zoom: 10.4,
            bearing: 0,
            pitch: 0,
            roll: 0,
          });
          return;
        }
        if ("mission" in to) {
          // The whole mission area from above, so the terrain at every site loads.
          const [west, south, east, north] = missionBounds(to.mission);
          const fit = map.cameraForBounds(
            [
              [west, south],
              [east, north],
            ],
            { padding: 80, maxZoom: 12.5 },
          );
          map.jumpTo({
            center: fit?.center ?? to.mission.base.position,
            zoom: fit?.zoom ?? 11,
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
        map.jumpTo({ center, zoom: 13.5, bearing: 0, pitch: 0, roll: 0 });
      },
      place: () => place(to),
      finish() {
        // Placed from the overview's coarse terrain; the close tiles loaded since
        // can put the ground metres higher (skids underground, an instant crash).
        if (heli && previous) {
          const rise = elevation(origin) - placedGround;
          heli.body.position = [
            heli.body.position[0],
            heli.body.position[1],
            heli.body.position[2] + rise,
          ];
          previous = cloneBody(heli.body);
          present(0, 1);
        }
        host.setTravelling(null);
        host.ready();
        host.wake();
      },
    });
  };

  travel(spawn);

  return {
    frame(_now, dt) {
      if (!heli || !previous || journeys.active) return false;
      const flying = host.isFlying() && !heli.crashed;
      let alpha = 1;
      if (flying) {
        const settings = deps.settings();
        const storm = active?.config.storm as StormSpec | undefined;
        env.wind =
          storm && active
            ? stormWind(storm, active.state.time)
            : windVector(settings.windFrom, settings.windKnots * KNOT);
        if (storm && active)
          active.look?.set(stormStrength(storm, active.state.time));
        const keys = held();
        const current = heli;
        if (active) {
          // Sites get their ground height from the closest tiles once those have loaded.
          active.config.steps.forEach((s, i) => {
            const z = loadedElevation(s.position);
            if (z !== null) active!.grounds[i] = z;
          });
        }
        const spec = missionSpec();
        alpha = fixed.advance(dt, (h) => {
          previous = cloneBody(current.body);
          updatePilot(pilot, keys, h, settings.selfCentring);
          const raw = {
            collective: pilot.throttle,
            roll: shaped(pilot.stickX),
            pitch: shaped(pilot.stickY),
            pedal: pilot.rudder,
          };
          const [east, north, up] = current.body.position;
          const below = ground(east, north);
          const local: HeliEnvironment = {
            ground: up - below > CONTACT_HEIGHT ? () => below : ground,
            wind: env.wind,
          };
          stepHelicopter(
            current,
            settings.assists ? heliAssist(raw, current, local, h) : raw,
            local,
            h,
          );
          if (active && spec)
            onMissionEvents(stepMission(active.state, spec, craft(), h));
        });
        if (active) runAvalanche(dt);
        if (heli.crashed) host.setCrash(heli.crashed);

        const [east, north] = heli.body.position;
        if (needsRebase(east, north)) {
          origin = toLngLat(origin, east, north);
          for (const body of [heli.body, previous])
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
          marker.shift(east, north);
          if (active?.avalanche) shiftAvalanche(active.avalanche, east, north);
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
        else if (event.code === "KeyC") {
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

    startMission(mission) {
      travel({ mission });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      journeys.cancel();
      deps.audio.silence();
      aircraft.show(null);
      host.setCrash(null);
      host.setTravelling(null);
      endMission();
      deps.mission.setStatus(null);
      try {
        if (map.getLayer(LAYER)) map.removeLayer(LAYER);
        if (map.getLayer(PLACE_LAYER)) map.removeLayer(PLACE_LAYER);
        transform().clearNearFarZOverride();
        map.setCenterClampedToGround(true);
        map.setMaxPitch(maxPitch);
        map.setMaxZoom(maxZoom);
        if (terrain) map.setTerrain(terrain);
      } catch {
        /* the map was removed first */
      }
    },
  };
}
