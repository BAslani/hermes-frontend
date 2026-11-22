import type { TerrainSpecification } from "maplibre-gl";
import { type Course, courseBounds } from "@/config/courses";
import { FLIGHT_SCENES } from "@/config/flights";
import {
  type Airport,
  PLACE_MIN_HEIGHT,
  PLACES,
  type Place,
} from "@/config/playground";
import { STRIKES, type StrikeScenario } from "@/config/strikes";
import type { CoopSession } from "@/lib/coop/client";
import { coast } from "@/lib/coop/match";
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
  ARCADE_TIME_SCALE,
  type ArcadeInput,
  arcadeThrottle,
  stepArcade,
  toArcade,
} from "@/lib/flight/arcade";
import {
  type ArcadeCameraRig,
  type ArcadeCameraState,
  arcadeCamera,
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
import { type Partner, standInDrone } from "@/lib/flight/partner";
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
import {
  addMissile,
  addRound,
  arcadeStrike,
  DECOY_REVEAL,
  FIRE_INTERVAL,
  GUN,
  LAUNCHER,
  LOCK,
  type Lock,
  type LockRules,
  launcherPosition,
  newLock,
  newStrike,
  type StrikeEvent,
  type StrikeGame,
  type StrikeSpec,
  scoreStrike,
  stepLock,
  stepStrike,
  switchLock,
  threatsLeft,
  totalThreats,
} from "@/lib/flight/strike";
import { Trail } from "@/lib/flight/trail";
import {
  add,
  clamp,
  cross,
  dot,
  length,
  normalize,
  rotate,
  scale,
  sub,
  type Vec3,
} from "@/lib/flight/vec";
import type { FlightAudio, RaceCue } from "../flight-audio";
import type { PanelBridge } from "../InstrumentPanel";
import type { RaceBridge, RaceStatus } from "../RaceHud";
import { loadRecord, type RaceRecord, saveRecord } from "../race-records";
import {
  MAX_BOXES,
  type StrikeBridge,
  type StrikeFrame,
  type StrikeStatus,
} from "../StrikeHud";
import type { FlightSettings } from "../settings";
import {
  createAircraftLayer,
  type GateLook,
  MAX_BOOST_PUFFS,
  MAX_FLAME_PUFFS,
  MAX_PUFFS,
  type WorldView,
} from "../three/aircraft-layer";
import { PuffBuffer } from "../three/eye-space";
import { JET_EYE } from "../three/jet-model";
import { RACER_EYE } from "../three/racer-model";
import { createStrikeLayer } from "../three/strike-layer";
import { applyLook, LOOKS } from "../time-of-day";
import { createCoopLink } from "./coop-link";
import { PLACE_KEYS } from "./drone-sim";
import { createStrikeEffects } from "./strike-effects";
import { elevationGrid, reach, strikeSpec } from "./strike-sim";
import { Journeys, type Sim, type SimHost, setNearFar } from "./types";

export interface AirplaneSim extends Sim {
  /** Line up on the runway at an airport. */
  startAt(airport: Airport): void;
  /** Start a race: airborne before the first gate, after a countdown. */
  startRace(course: Course): void;
  /** Fly the F-14 against a scenario's drone launchers. */
  startStrike(scenario: StrikeScenario): void;
}

type Spawn =
  | { airport: Airport }
  | { place: Place }
  | { course: Course }
  | { strike: StrikeScenario };

/**
 * An F-14 strike: the drone-defence game played from the jet. Its positions
 * are metres from the scenario's site, which stays put while the airplane's
 * local frame moves under the aircraft.
 */
interface JetStrike {
  scenario: StrikeScenario;
  jet: NonNullable<StrikeScenario["jet"]>;
  game: StrikeGame;
  /** Ground over the whole battle area, sampled while it was all in view. */
  grid: (east: number, north: number) => number;
  lock: Lock;
  /** The interceptor drone in co-op (a stand-in for now). */
  partner: Partner | null;
  /** Arcade, flown alone: the harder rules (arcadeStrike), hunters after the F-14 itself. */
  hard: boolean;
  missiles: number;
  /** Missiles it started with. */
  magazine: number;
  rounds: number;
  cooldown: number;
  gunCooldown: number;
  status: StrikeStatus;
}

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
  "Space",
  "KeyE",
  "KeyQ",
]);
/** Where the race plane's smoke comes out, body frame. */
const SMOKE_NOZZLE: Vec3 = [-4.85, 0, -0.02];
/** Throttle from which the jet counts as at full power (in arcade, boost sets it to 1). */
const FULL_THROTTLE = 0.98;
/** Seconds for the wings to swing all the way back or forward. */
const SWEEP_TIME = 1.6;
/** The jet's two engine nozzles, just aft of the exits (measured off the model), body frame. */
const JET_NOZZLES: Vec3[] = [
  [-7.6, 1.29, -0.29],
  [-7.6, -1.29, -0.29],
];
/** Seconds a gate burst lasts. */
const BURST_TIME = 0.7;
const STRIKE_LAYER = "flight-strike";
/** The F-14 locks on to a launcher or a drone this far away, metres. */
const JET_LOCK_RANGE = 9000;
/** Arcade alone: hunters closer than this set off the warning, metres. */
const JET_HUNTER_WARNING = 2500;
/** Lock ids for launchers are below zero (−1 for launcher 0), so they never meet a drone's id. */
const launcherLockId = (index: number) => -1 - index;
const lockedLauncher = (id: number) => -1 - id;
/** The F-14's seeker: realistic, and arcade's wider, quicker one. */
const JET_LOCK: Record<FlightSettings["gameplay"], LockRules> = {
  realistic: { ...LOCK, range: JET_LOCK_RANGE },
  arcade: {
    cone: 10 * (Math.PI / 180),
    keep: 22 * (Math.PI / 180),
    time: 0.8,
    range: JET_LOCK_RANGE,
  },
};
/** Where its missiles leave and its gun fires from, body frame (forward, left, up). */
const JET_PYLON: Vec3 = [1, 0, -1.4];
const JET_GUN: Vec3 = [7.5, 0.7, 0];
/**
 * Arcade pointer: radians it moves per pixel of mouse movement, and how far
 * ahead of the nose it may run (the aircraft is always catching up to it).
 */
const AIM_SENSITIVITY = 0.001;
const AIM_REACH = 35 * (Math.PI / 180);
/** Where the arcade camera sits behind each aircraft, metres. */
const ARCADE_RIG: Record<Airframe["id"], ArcadeCameraRig> = {
  jet: { back: 35, up: 6.5, lead: 45 },
  racer: { back: 15, up: 3.5, lead: 25 },
  trainer: { back: 17, up: 4, lead: 25 },
};

/** The light airplane: fixed-step physics, cameras, runway starts, instruments and sound. */
export function createAirplaneSim(
  host: SimHost,
  deps: {
    panel: PanelBridge;
    race: RaceBridge;
    strike: StrikeBridge;
    audio: FlightAudio;
    settings: () => FlightSettings;
    airport: Airport;
    locale: "en";
    /** Online co-op: the room, this browser's role, and whether it runs the game. */
    coop?: CoopSession;
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
  const strikeLayer = createStrikeLayer(STRIKE_LAYER);
  map.addLayer(strikeLayer.layer);

  /**
   * The transform the map renders with. MapLibre 6 keeps it on the map's
   * camera; there is no public way to move the near plane, hence the reach in.
   */
  const transform = () => map._camera.transform;

  let origin: LngLat = deps.airport.center;
  let plane: Airplane | null = null;
  let previous: RigidBody | null = null;
  let pilot: PilotState = newPilot();
  const coopScenario = deps.coop
    ? STRIKES.find((s) => s.id === deps.coop?.scenario && s.jet)
    : undefined;
  let spawn: Spawn = coopScenario
    ? { strike: coopScenario }
    : { airport: deps.airport };
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
  /** The jet at full throttle: thick exhaust smoke, and a short afterburner flame, per nozzle. */
  const boostTrails = [new Trail(4, 0.02, 300), new Trail(4, 0.02, 300)];
  const flameTrails = [new Trail(0.2, 0.01, 60), new Trail(0.2, 0.01, 60)];
  const allTrails = () => [...trails, ...boostTrails, ...flameTrails];
  const boostPuffs = new PuffBuffer(MAX_BOOST_PUFFS);
  const flamePuffs = new PuffBuffer(MAX_FLAME_PUFFS);
  /** The jet's wing sweep: 0 spread, 1 fully swept back at full throttle. */
  let wingSweep = 0;
  const smokeOffsets = new Float32Array(MAX_PUFFS * 3);
  const smokeAges = new Float32Array(MAX_PUFFS);
  /** Gates flashing just now: index, when, missed or passed. */
  let bursts: { index: number; at: number; missed: boolean }[] = [];
  /** The countdown second last beeped. */
  let lastBeep = 0;
  let mission: JetStrike | null = null;
  /** Fireballs, wreckage, smoke and trails of the strike. */
  const fx = createStrikeEffects();
  /** A missile asked for (click or E), fired on the next frame. */
  let wantFire = false;
  /** A lock switch asked for (Q or the middle button), done on the next frame. */
  let wantSwitch = false;
  /** The arcade camera trailing the aircraft's attitude. */
  const arcadeCam: ArcadeCameraState = { orientation: null };
  /** Arcade: the pointer, a world direction the aircraft flies to (east-north-up). */
  let aim: Vec3 = [0, 1, 0];
  let bannerSeq = 0;
  /** Where the camera was last frame: the seeker looks where the screen does. */
  let lastCamera: CameraPose | null = null;
  /** Online co-op: the partner's drone comes over the relay instead of the stand-in. */
  const link = deps.coop
    ? createCoopLink(deps.coop, {
        game: () => mission?.game ?? null,
        onEvents: (events) => {
          if (mission && plane)
            onStrikeEvents(
              events,
              sub(plane.body.position, siteOffset(mission)),
            );
        },
        onStart: () => {
          // The host started over: so does this side, back at the start.
          if (mission && !journeys.active) place(spawn);
        },
      })
    : null;
  /** A started match restarts on the next start (co-op tells the guest which). */
  let begun = false;

  const cue = (name: RaceCue, volume = 1) => {
    if (deps.settings().sound) deps.audio.cue(name, volume);
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

  /** The strike's site in the current local frame: game position = local position − this. */
  const siteOffset = (m: JetStrike): Vec3 => {
    const [east, north] = toLocal(origin, m.scenario.site.position);
    return [east, north, 0];
  };
  /** Ground in the strike's frame: loaded tiles, else the grid sampled at the start. */
  const strikeGround: GroundFn = (east, north) => {
    if (!mission) return 0;
    const live = map.queryTerrainElevation(
      toLngLat(mission.scenario.site.position, east, north),
    );
    return live ?? mission.grid(east, north);
  };

  /** Strike read-outs that change on events only. */
  const publishStrike = (patch: Partial<StrikeStatus>) => {
    if (!mission) return;
    mission.status = { ...mission.status, ...patch };
    deps.strike.setStatus(mission.status);
  };

  const onStrikeEvents = (events: StrikeEvent[], camera: Vec3) => {
    if (!mission || events.length === 0) return;
    const { game } = mission;
    fx.onEvents(events, game.time, strikeGround);
    const volumeAt = (at: Vec3) =>
      clamp(1 - length(sub(at, camera)) / 9000, 0.08, 1);
    for (const e of events) {
      switch (e.kind) {
        case "wave":
          publishStrike({
            phase: "wave",
            wave: e.index,
            banner: { kind: "wave", n: e.index, seq: ++bannerSeq },
          });
          break;
        case "wave-clear":
          if (game.phase === "break")
            publishStrike({
              phase: "break",
              banner: { kind: "clear", n: e.index, seq: ++bannerSeq },
            });
          break;
        case "kill":
          publishStrike({
            kills: game.kills,
            banner: { kind: "kill", n: e.points, seq: ++bannerSeq },
          });
          cue("boom", volumeAt(e.at));
          break;
        case "burst":
          cue("boom", volumeAt(e.at) * 0.6);
          break;
        case "player-hit":
          publishStrike({
            armourLeft: e.hitsLeft,
            banner: { kind: "damage", n: e.hitsLeft, seq: ++bannerSeq },
          });
          cue("boom", 1);
          cue("alarm");
          break;
        case "site-hit":
          publishStrike({
            hitsLeft: e.hitsLeft,
            banner: { kind: "hit", n: e.hitsLeft, seq: ++bannerSeq },
          });
          cue("alarm");
          break;
        case "launcher-down": {
          const left = game.launchers.filter((l) => l.alive).length;
          publishStrike({
            launchers: { left, total: game.launchers.length },
            banner: { kind: "launcher", n: left, seq: ++bannerSeq },
          });
          cue("boom", 1);
          cue("gate");
          break;
        }
        case "won":
        case "lost":
          publishStrike({
            phase: e.kind,
            lostBy: game.lostBy,
            kills: game.kills,
            result: { score: scoreStrike(game), medal: null, newBest: false },
          });
          cue(e.kind === "won" ? "finish" : "missed");
          break;
      }
    }
  };

  const arcade = () => deps.settings().gameplay === "arcade";
  const lockRules = () => JET_LOCK[deps.settings().gameplay];
  /** What the F-14's seeker can lock on to: the launchers, then the drones in the air. */
  const lockTargets = (m: JetStrike) => [
    ...m.game.launchers.map((l, i) => ({
      id: launcherLockId(i),
      position: launcherPosition(m.game, i, strikeGround),
      alive: l.alive,
    })),
    ...m.game.threats,
  ];

  /** The F-14's weapons and seeker, once a frame. */
  const strikeWeapons = (m: JetStrike, body: RigidBody, dt: number) => {
    const { game } = m;
    if (game.phase === "won" || game.phase === "lost") return;
    const d = siteOffset(m);
    const toGame = (p: Vec3) => sub(p, d);
    // The seeker looks where the screen centre does (the circle on the HUD).
    if (lastCamera) {
      const wasLocked = m.lock.locked;
      const eye = toGame(lastCamera.position);
      if (
        wantSwitch &&
        switchLock(
          m.lock,
          eye,
          lastCamera.forward,
          lockTargets(m),
          strikeGround,
          lockRules(),
        )
      )
        cue("count", 0.5);
      stepLock(
        m.lock,
        eye,
        lastCamera.forward,
        lockTargets(m),
        dt,
        strikeGround,
        lockRules(),
      );
      if (m.lock.locked && !wasLocked) cue("lock");
    }
    wantSwitch = false;
    m.cooldown = Math.max(0, m.cooldown - dt);
    m.gunCooldown = Math.max(0, m.gunCooldown - dt);
    const nose = rotate(body.orientation, [1, 0, 0]);
    const at = (mount: Vec3) =>
      toGame(add(body.position, rotate(body.orientation, mount)));
    const guest = link !== null && !link.host;
    if (host.keys.has("Space") && m.rounds > 0 && m.gunCooldown <= 0) {
      if (guest)
        link?.fire({
          weapon: "gun",
          position: at(JET_GUN),
          velocity: body.velocity,
          forward: nose,
        });
      else addRound(game, at(JET_GUN), body.velocity, nose);
      m.rounds -= 1;
      m.gunCooldown = 1 / GUN.rate;
      cue("gun", 0.7);
    }
    if (wantFire) {
      wantFire = false;
      if (m.missiles > 0 && m.cooldown <= 0) {
        // Locked on a launcher, it steers for that; on a drone, for the drone.
        // Its warhead destroys a launcher in one burst (the drone's takes two).
        const target = m.lock.locked ? m.lock.target : null;
        const threat = target !== null && target >= 0 ? target : null;
        const launcher =
          target !== null && target < 0 ? lockedLauncher(target) : undefined;
        if (guest)
          link?.fire({
            weapon: "missile",
            position: at(JET_PYLON),
            velocity: body.velocity,
            forward: nose,
            target: threat,
            launcher,
          });
        else
          addMissile(
            game,
            at(JET_PYLON),
            body.velocity,
            nose,
            threat,
            launcher,
            LAUNCHER.health,
          );
        m.missiles -= 1;
        m.cooldown = FIRE_INTERVAL;
        cue("launch");
      }
    }
  };

  /** Draw the strike and fill in the HUD, from the camera this frame. */
  const presentStrike = (
    m: JetStrike,
    eye: ReturnType<typeof eyeMatrix>,
    camera: CameraPose,
    pixelsPerMeter: number,
  ) => {
    const { game, lock } = m;
    const cameraGame = sub(camera.position, siteOffset(m));
    const rel = (p: Vec3) => sub(p, cameraGame);
    const ally = link ? link.partner() : (m.partner?.state() ?? null);
    const fov = map.getVerticalFieldOfView();
    strikeLayer.show({
      eye,
      fov,
      pixelsPerMeter,
      light: LOOKS[m.scenario.look].light,
      ...fx.view(game, cameraGame, strikeGround),
      partner: ally && {
        offset: rel(ally.position),
        forward: rotate(ally.orientation, [1, 0, 0]),
      },
      thermal: false,
      navLights: m.scenario.look === "night",
      time: game.time,
    });
    const canvas = map.getCanvas();
    const aspect = canvas.width / canvas.height;
    const playing = game.phase === "wave" || game.phase === "break";
    const boxes: StrikeFrame["boxes"] = [];
    // Launchers first (the targets), then the drones in the air.
    let nearest: ReturnType<typeof screenPoint> | null = null;
    game.launchers.forEach((l, i) => {
      if (!l.alive) return;
      const p = screenPoint(
        eye,
        rel(launcherPosition(game, i, strikeGround)),
        fov,
        aspect,
      );
      if (!nearest || p.distance < nearest.distance) nearest = p;
      if (p.visible && boxes.length < MAX_BOXES)
        boxes.push({
          x: p.x,
          y: p.y,
          distance: p.distance,
          state:
            lock.target === launcherLockId(i)
              ? lock.locked
                ? "locked"
                : "locking"
              : "none",
          tag: "launcher",
        });
    });
    let closest: number | null = null;
    /** The nearest hunter, for the warning (arcade alone, where they come for the F-14). */
    let hunterNear = Infinity;
    for (const t of game.threats) {
      const toSite = length(sub(t.position, game.spec.site));
      closest = Math.min(closest ?? Infinity, toSite);
      const p = screenPoint(eye, rel(t.position), fov, aspect);
      if (t.kind === "hunter") hunterNear = Math.min(hunterNear, p.distance);
      if (p.visible && boxes.length < MAX_BOXES)
        boxes.push({
          x: p.x,
          y: p.y,
          distance: p.distance,
          state:
            lock.target === t.id
              ? lock.locked
                ? "locked"
                : "locking"
              : "none",
          // What each drone is shows on its box; decoys only once they are close.
          tag:
            t.kind === "jet"
              ? "jet"
              : t.kind === "hunter"
                ? "hunter"
                : t.kind === "decoy" && p.distance < DECOY_REVEAL
                  ? "decoy"
                  : null,
        });
    }
    // The partner's box, so it can be found (and not shot at).
    if (ally && boxes.length < MAX_BOXES) {
      const p = screenPoint(eye, rel(ally.position), fov, aspect);
      if (p.visible)
        boxes.push({
          x: p.x,
          y: p.y,
          distance: p.distance,
          state: "none",
          tag: "ally",
        });
    }
    const arrow = nearest as ReturnType<typeof screenPoint> | null;
    deps.strike.push({
      magazine: m.missiles,
      magazineSize: m.magazine,
      threatsLeft: threatsLeft(game),
      breakLeft: game.phase === "break" ? Math.max(0, game.breakLeft) : null,
      lock: {
        progress: lock.progress,
        locked: lock.locked,
        hunting: lock.target !== null,
      },
      cone:
        (Math.tan(lockRules().cone) / Math.tan((fov * Math.PI) / 360)) * 0.5,
      boxes,
      // To the nearest launcher still standing, when it is off screen.
      arrow:
        playing && arrow && !arrow.visible
          ? { angle: arrow.angle, distance: arrow.distance }
          : null,
      closest: playing ? closest : null,
      hunter:
        m.hard && playing && hunterNear < JET_HUNTER_WARNING
          ? hunterNear
          : null,
      shake: 0,
      ammo: m.rounds,
      ammoSize: m.jet.rounds,
      pipper: null,
      jet: true,
    });
  };

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

  /**
   * Arcade controls: the mouse moves the pointer and the aircraft eases round
   * to follow it; A/D yaw, W boost, S air brake, both together a high-G turn.
   */
  const arcadeInput = (): ArcadeInput => ({
    aim,
    pitch: 0,
    roll: 0,
    yaw: pilot.rudder,
    boost: host.keys.has("KeyW"),
    brake: host.keys.has("KeyS"),
  });

  /** Keep the pointer within AIM_REACH of the nose, so it never runs away from the aircraft. */
  const reinAim = (nose: Vec3) => {
    const c = clamp(dot(aim, nose), -1, 1);
    if (c >= Math.cos(AIM_REACH)) return;
    const across = sub(aim, scale(nose, c));
    const side =
      length(across) > 1e-6
        ? normalize(across)
        : normalize(cross(nose, [0, 0, 1]));
    aim = add(
      scale(nose, Math.cos(AIM_REACH)),
      scale(side, Math.sin(AIM_REACH)),
    );
  };

  /** Mouse moved by (dx, dy) pixels: the pointer moves that way across the screen. */
  const moveAim = (dx: number, dy: number) => {
    if (!lastCamera || !plane) return;
    const right = normalize(cross(lastCamera.forward, lastCamera.up));
    const up = normalize(cross(right, lastCamera.forward));
    aim = normalize(
      add(
        aim,
        add(
          scale(right, dx * AIM_SENSITIVITY),
          scale(up, -dy * AIM_SENSITIVITY),
        ),
      ),
    );
    reinAim(rotate(plane.body.orientation, [1, 0, 0]));
  };

  /** The pointer's circle and the gun cross where the nose points, arcade only. */
  const marks = (() => {
    const make = (css: string) => {
      const el = document.createElement("div");
      el.setAttribute("aria-hidden", "true");
      el.style.cssText = `position:absolute;left:0;top:0;pointer-events:none;z-index:5;display:none;transform:translate(-50%,-50%);${css}`;
      map.getContainer().appendChild(el);
      return el;
    };
    const pointer = make(
      "width:30px;height:30px;border:2px solid rgba(110,255,170,.85);border-radius:50%;box-shadow:0 0 5px rgba(0,0,0,.45);",
    );
    const nose = make(
      "width:16px;height:16px;background:linear-gradient(rgba(110,255,170,.9),rgba(110,255,170,.9)) center/100% 2px no-repeat,linear-gradient(rgba(110,255,170,.9),rgba(110,255,170,.9)) center/2px 100% no-repeat;",
    );
    const place = (el: HTMLDivElement, p: ReturnType<typeof screenPoint>) => {
      if (!p.visible) {
        el.style.display = "none";
        return;
      }
      const { clientWidth: w, clientHeight: h } = map.getContainer();
      el.style.display = "block";
      el.style.left = `${((p.x + 1) / 2) * w}px`;
      el.style.top = `${((1 - p.y) / 2) * h}px`;
    };
    return {
      show(
        view: {
          eye: ReturnType<typeof eyeMatrix>;
          camera: Vec3;
          aircraft: Vec3;
          nose: Vec3;
        } | null,
      ) {
        if (!view) {
          pointer.style.display = "none";
          nose.style.display = "none";
          return;
        }
        const fov = map.getVerticalFieldOfView();
        const canvas = map.getCanvas();
        const aspect = canvas.width / canvas.height;
        const far = (from: Vec3, dir: Vec3) =>
          sub(
            add(from, [dir[0] * 3000, dir[1] * 3000, dir[2] * 3000]),
            view.camera,
          );
        place(
          pointer,
          screenPoint(view.eye, far(view.aircraft, aim), fov, aspect),
        );
        place(
          nose,
          screenPoint(view.eye, far(view.aircraft, view.nose), fov, aspect),
        );
      },
      remove() {
        pointer.remove();
        nose.remove();
      },
    };
  })();

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
    else if (arcade())
      camera = arcadeCamera(
        arcadeCam,
        pose.position,
        pose.orientation,
        dt,
        ARCADE_RIG[plane.frame.id],
        ground,
      );
    else
      camera = chaseCamera(chase, pose.position, pose.orientation, dt, ground);

    lastCamera = camera;
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
    setNearFar(map, height);

    const eye = eyeMatrix(angles);
    marks.show(
      arcade() && !plane.crashed
        ? {
            eye,
            camera: camera.position,
            aircraft: pose.position,
            nose: rotate(pose.orientation, [1, 0, 0]),
          }
        : null,
    );
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
    /** The newest puffs of some trails into a buffer, camera-relative. */
    const pack = (from: Trail[], buffer: PuffBuffer) => {
      buffer.clear();
      const live = from.flatMap((t) => t.live(now));
      for (const p of live.slice(-buffer.max))
        buffer.put(sub(p.position, camera.position), p.age);
      return buffer.data();
    };
    const boostSmoke = pack(boostTrails, boostPuffs);
    const afterburner = pack(flameTrails, flamePuffs);
    let world: WorldView | undefined =
      smoke || boostSmoke || afterburner
        ? {
            gates: [],
            ghost: null,
            time: now,
            bursts: [],
            smoke,
            boostSmoke,
            afterburner,
          }
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
      wingSweep,
      light: active
        ? LOOKS[active.course.look].light
        : mission
          ? LOOKS[mission.scenario.look].light
          : undefined,
      world,
    });
    if (mission) presentStrike(mission, eye, camera, scale);
    else strikeLayer.show(null);
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
    mission = null;
    endLook();
    for (const t of allTrails()) t.clear();
    wingSweep = 0;
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
    } else if ("strike" in to) {
      const scenario = to.strike;
      const jet = scenario.jet!;
      startAirborne(
        jet.start.position,
        jet.start.height,
        jet.start.heading,
        undefined,
        JET_AIRFRAME,
      );
      restoreLook = applyLook(map, scenario.look);
      const site = scenario.site.position;
      const siteGround = map.queryTerrainElevation(site) ?? 0;
      const grid = elevationGrid(
        (east, north) => map.queryTerrainElevation(toLngLat(site, east, north)),
        reach(scenario) + 1500,
        siteGround,
      );
      // Online, both players play one game under drone-defence rules (the
      // drone defends the site); alone, the F-14's strike with its own.
      const seed = Math.floor(Math.random() * 1e9);
      // Arcade alone: the harder rules; online, both players keep the shared ones.
      const hard = !link && arcade();
      const soloSpec: StrikeSpec = {
        site: [0, 0, siteGround + scenario.site.aim],
        siteRadius: scenario.site.radius,
        spawnDistance: scenario.spawnDistance,
        launchers: scenario.launchers?.map((at) => toLocal(site, at)),
        waves: scenario.waves,
        hitsAllowed: jet.hitsAllowed,
        magazine: 0,
        rounds: 0,
        firstBreak: scenario.firstBreak,
        breakTime: scenario.breakTime,
      };
      // Arcade: one missile a launcher and one spare; the gun does the rest.
      const magazine = hard
        ? Math.min(jet.missiles, (scenario.launchers?.length ?? 0) + 1)
        : jet.missiles;
      const game = newStrike(
        link
          ? strikeSpec(scenario, siteGround)
          : hard
            ? arcadeStrike(soloSpec)
            : soloSpec,
        seed,
      );
      link?.started(seed, begun);
      begun = true;
      fx.clear();
      wantFire = false;
      // Co-op: the partner's interceptor hovers where drone defence starts it.
      const [startEast, startNorth] = toLocal(site, scenario.start.position);
      const startGround =
        map.queryTerrainElevation(scenario.start.position) ??
        grid(startEast, startNorth);
      const m: JetStrike = {
        scenario,
        jet,
        game,
        grid,
        lock: newLock(),
        partner:
          !link && settings.partner
            ? standInDrone(
                [startEast, startNorth, startGround + scenario.start.height],
                scenario.start.heading,
              )
            : null,
        hard,
        missiles: magazine,
        magazine,
        rounds: jet.rounds,
        cooldown: 0,
        gunCooldown: 0,
        status: {
          name: scenario.name[deps.locale],
          site: scenario.site.name[deps.locale],
          phase: "break",
          wave: -1,
          waveCount: scenario.waves.length,
          hitsLeft: game.spec.hitsAllowed,
          hitsAllowed: game.spec.hitsAllowed,
          armourLeft: hard ? (game.spec.playerHits ?? 0) : 0,
          armour: hard ? (game.spec.playerHits ?? 0) : 0,
          hunters: hard,
          lostBy: null,
          kills: 0,
          total: totalThreats(game.spec),
          banner: null,
          result: null,
          launchers: {
            left: game.launchers.length,
            total: game.launchers.length,
          },
        },
      };
      mission = m;
      deps.strike.setStatus(m.status);
    } else if ("airport" in to) {
      const runway = findRunway(runwayLines(), to.airport.center);
      if (runway && arcade()) {
        // Arcade flies from the air: over the runway, along it, already at speed.
        const start = lineUp(
          runway,
          settings.windFrom,
          settings.windKnots * KNOT,
        );
        startAirborne(start.position, 450, start.heading);
      } else if (runway) {
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
    if (!mission) {
      deps.strike.setStatus(null);
      strikeLayer.show(null);
    }
    if (plane && arcade()) {
      toArcade(plane);
      arcadeCam.orientation = null;
      aim = rotate(plane.body.orientation, [1, 0, 0]);
    }
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
    marks.show(null);
    strikeLayer.show(null);
    plane = null;
    active = null;
    mission = null;
    deps.race.setStatus(null);
    deps.strike.setStatus(null);
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
        if ("strike" in to) {
          // The whole battle area and the jet's start from above, so the terrain under all of it loads.
          const site = to.strike.site.position;
          const r = reach(to.strike) + 1500;
          const start = to.strike.jet!.start.position;
          const [sw, ne] = [toLngLat(site, -r, -r), toLngLat(site, r, r)];
          const fit = map.cameraForBounds(
            [
              [Math.min(sw[0], start[0]), Math.min(sw[1], start[1])],
              [Math.max(ne[0], start[0]), Math.max(ne[1], start[1])],
            ],
            { padding: 40, maxZoom: 12 },
          );
          map.jumpTo({
            center: fit?.center ?? site,
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
    frame(_now, frameDt) {
      if (!plane || !previous || journeys.active) return false;
      const flying = host.isFlying() && !plane.crashed;
      const arcadeMode = arcade();
      // Arcade runs the whole game, the strike included, a little faster than real time.
      // Not online: both sides of a co-op match keep one clock.
      const dt = arcadeMode && !link ? frameDt * ARCADE_TIME_SCALE : frameDt;
      let alpha = 1;
      if (flying) {
        const settings = deps.settings();
        env.wind = windVector(settings.windFrom, settings.windKnots * KNOT);
        const keys = held();
        const current = plane;
        const gates = localGates();
        const strikeEvents: StrikeEvent[] = [];
        const steps = !link || link.host;
        if (mission && steps) link?.applyShots(mission.game);
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
          const [east, north, up] = current.body.position;
          const below = ground(east, north);
          env.ground = up - below > CONTACT_HEIGHT ? () => below : ground;
          if (arcadeMode) {
            const input = arcadeInput();
            pilot.throttle = arcadeThrottle(input);
            stepArcade(current, input, env.ground, h);
          } else {
            const controls = controlsFrom(pilot, keys);
            stepAirplane(
              current,
              settings.assists ? assist(controls, current) : controls,
              env,
              h,
            );
          }
          if (mission && steps && !current.crashed) {
            // Hunters go for the partner's interceptor (without one, the site);
            // in arcade alone, for the F-14 itself.
            mission.partner?.step(h);
            strikeEvents.push(
              ...stepStrike(
                mission.game,
                strikeGround,
                h,
                mission.hard
                  ? sub(current.body.position, siteOffset(mission))
                  : (link?.partner() ?? mission.partner?.state())?.position,
              ),
            );
          }
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
        // The jet at full throttle: thick smoke and afterburner flame as well,
        // and the wings sweep back (forward again when it throttles back).
        const jet = plane.frame.id === "jet";
        const full = jet && !plane.crashed && pilot.throttle >= FULL_THROTTLE;
        wingSweep = jet
          ? wingSweep +
            clamp((full ? 1 : 0) - wingSweep, -dt / SWEEP_TIME, dt / SWEEP_TIME)
          : 0;
        if (smokeOn && !plane.crashed && plane.wheelsDown === 0) {
          const { position, orientation } = plane.body;
          const now = performance.now() / 1000;
          nozzles.forEach((nozzle, i) => {
            const at = add(position, rotate(orientation, nozzle));
            trails[i].emit(now, at, env.wind);
            if (full) {
              boostTrails[i].emit(now, at, env.wind);
              flameTrails[i].emit(now, at, [0, 0, 0]);
            }
          });
          if (!full) for (const t of [...boostTrails, ...flameTrails]) t.cut();
        } else {
          for (const t of allTrails()) t.cut();
        }
        env.ground = ground;
        // The pointer never falls more than its reach behind (a stall, say, drops the nose away from it).
        if (arcadeMode) reinAim(rotate(plane.body.orientation, [1, 0, 0]));
        if (plane.crashed) host.setCrash(plane.crashed);
        if (mission) {
          if (!steps) coast(mission.game, dt);
          link?.sendEvents(strikeEvents);
          link?.tick(dt, {
            position: sub(plane.body.position, siteOffset(mission)),
            velocity: plane.body.velocity,
            orientation: plane.body.orientation,
          });
          if (!plane.crashed) strikeWeapons(mission, plane.body, dt);
          fx.step(dt, mission.game.time, strikeGround);
          onStrikeEvents(
            strikeEvents,
            sub(plane.body.position, siteOffset(mission)),
          );
        }

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
          for (const t of allTrails()) t.shift(east, north);
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
          !arcade() &&
          plane?.frame.retractable &&
          plane.wheelsDown === 0
        ) {
          // Gear lever; not while sitting on the wheels.
          plane.gearCommand = !plane.gearCommand;
        } else if (event.code === "KeyE") {
          wantFire = true;
        } else if (event.code === "KeyQ") {
          wantSwitch = true;
        } else if (event.code === "KeyX") {
          smokeOn = !smokeOn;
          for (const t of allTrails()) t.cut();
        } else if (event.code === "KeyC") {
          mode =
            CAMERA_MODES[
              (CAMERA_MODES.indexOf(mode) + 1) % CAMERA_MODES.length
            ];
          chase.ready = false;
          arcadeCam.orientation = null;
        }
      }
      host.wake();
    },

    keyUp() {
      host.wake();
    },

    mouseDown(button) {
      // In a strike, a left click fires a missile.
      if (button === 0 && mission) {
        wantFire = true;
        host.wake();
      }
      // The middle button moves the lock to the next target in range.
      if (button === 1 && mission) {
        wantSwitch = true;
        host.wake();
      }
    },

    mouseMove(dx, dy, buttons) {
      // Right drag orbits in the orbit view; otherwise arcade moves the pointer, realistic the yoke.
      if (mode === "orbit" && buttons & 2) dragOrbit(orbit, dx, dy);
      else if (arcade()) moveAim(dx, dy);
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

    startStrike(scenario) {
      travel({ strike: scenario });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      journeys.cancel();
      link?.dispose();
      deps.audio.silence();
      aircraft.show(null);
      marks.remove();
      host.setCrash(null);
      host.setTravelling(null);
      active = null;
      mission = null;
      deps.race.setStatus(null);
      deps.strike.setStatus(null);
      endLook();
      try {
        if (map.getLayer(AIRCRAFT_LAYER)) map.removeLayer(AIRCRAFT_LAYER);
        if (map.getLayer(STRIKE_LAYER)) map.removeLayer(STRIKE_LAYER);
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
