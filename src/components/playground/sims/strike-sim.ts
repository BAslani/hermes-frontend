import type { TerrainSpecification } from "maplibre-gl";
import type { StrikeScenario } from "@/config/strikes";
import type { CoopSession } from "@/lib/coop/client";
import { coast } from "@/lib/coop/match";
import {
  createDrone,
  DRONE,
  type DroneState,
  groundSpeed,
  look,
  step,
} from "@/lib/drone-controls";
import { ARCADE_TIME_SCALE } from "@/lib/flight/arcade";
import { eyeMatrix } from "@/lib/flight/camera";
import { type LngLat, toLngLat, toLocal } from "@/lib/flight/frame";
import { type Partner, standInJet } from "@/lib/flight/partner";
import { screenPoint } from "@/lib/flight/race";
import {
  DECOY_REVEAL,
  FIRE_INTERVAL,
  fire,
  GUN,
  LOCK,
  type Lock,
  leadPoint,
  newLock,
  newStrike,
  PLAYER_HITS,
  type StrikeEvent,
  type StrikeGame,
  type StrikeSpec,
  scoreStrike,
  shoot,
  stepLock,
  stepStrike,
  strikeMedal,
  switchLock,
  threatsLeft,
  totalThreats,
} from "@/lib/flight/strike";
import { clamp, fromAttitude, length, sub, type Vec3 } from "@/lib/flight/vec";
import type { OpticsBridge, OpticsFrame, OpticsMode } from "../DroneOptics";
import type { FlightAudio, RaceCue } from "../flight-audio";
import type { HudStore } from "../hud-store";
import {
  MAX_BOXES,
  type StrikeBridge,
  type StrikeFrame,
  type StrikeStatus,
} from "../StrikeHud";
import type { FlightSettings } from "../settings";
import { loadStrikeRecord, saveStrikeRecord } from "../strike-records";
import { createAircraftLayer } from "../three/aircraft-layer";
import { createStrikeLayer } from "../three/strike-layer";
import { applyLook, LOOKS } from "../time-of-day";
import { createCoopLink } from "./coop-link";
import { FLIGHT_KEYS, readInput } from "./drone-sim";
import { droneOptics } from "./optics";
import { createStrikeEffects } from "./strike-effects";
import { Journeys, type Sim, type SimHost, setNearFar } from "./types";

export interface StrikeSim extends Sim {
  /** Start (or restart) a drone-defence scenario. */
  startStrike(scenario: StrikeScenario): void;
}

const LAYER = "flight-strike";
/** The co-op partner's F-14, drawn by the airplane game's aircraft layer. */
const PARTNER_LAYER = "flight-partner";
/** The interceptor's cruise speed limit, m/s (boost triples it). */
const COMBAT_SPEED = 45;
/** It may look this far up: drones come over the ridges. Map pitch, degrees (90 = horizon). */
const MAX_LOOK_PITCH = 125;
/** Degrees per pixel of mouse movement. */
const MOUSE_SENSITIVITY = 0.12;
/** Spacing of the elevation grid sampled at the start, metres. */
const GRID_STEP = 120;
const HUD_INTERVAL_MS = 100;
/** Missiles leave the rails this far ahead of and below the camera, metres. */
const LAUNCH_AHEAD = 4;
const LAUNCH_BELOW = 1.5;

/** Seconds the screen shakes when a hunter hits the interceptor, and how hard, degrees. */
const SHAKE_TIME = 0.7;
const SHAKE = 2.5;
/** Hunters closer than this set off the warning, metres. */
const HUNTER_WARNING = 1500;
/** The gun's pipper shows for a drone this close, metres. */
const GUN_RANGE = 1500;

/**
 * A scenario's game, under drone-defence rules: the same for drone defence
 * and for an online co-op match (whichever aircraft hosts), so both players'
 * games agree. Positions are metres from the site; `siteGround` is its height.
 */
export const strikeSpec = (
  s: StrikeScenario,
  siteGround: number,
): StrikeSpec => ({
  site: [0, 0, siteGround + s.site.aim],
  siteRadius: s.site.radius,
  spawnDistance: s.spawnDistance,
  launchers: s.launchers?.map((at) => toLocal(s.site.position, at)),
  waves: s.waves,
  hitsAllowed: s.hitsAllowed,
  magazine: s.magazine,
  firstBreak: s.firstBreak,
  breakTime: s.breakTime,
  playerHits: s.playerHits ?? PLAYER_HITS,
  rounds: s.rounds,
});

/** How far from the site the battle reaches: the spawn ring or the furthest launcher, metres. */
export const reach = (s: StrikeScenario) =>
  Math.max(
    s.spawnDistance,
    ...(s.launchers ?? []).map((at) => {
      const [e, n] = toLocal(s.site.position, at);
      return Math.hypot(e, n);
    }),
  );

/** Ground heights over the whole battle area, sampled once while it is all in view. */
export function elevationGrid(
  sample: (east: number, north: number) => number | null,
  radius: number,
  fallback: number,
) {
  const n = Math.ceil((2 * radius) / GRID_STEP) + 1;
  const grid = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++)
      grid[j * n + i] =
        sample(-radius + i * GRID_STEP, -radius + j * GRID_STEP) ?? fallback;
  }
  return (east: number, north: number) => {
    const x = clamp((east + radius) / GRID_STEP, 0, n - 1.001);
    const y = clamp((north + radius) / GRID_STEP, 0, n - 1.001);
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const g = (a: number, b: number) => grid[b * n + a];
    return (
      g(i, j) * (1 - fx) * (1 - fy) +
      g(i + 1, j) * fx * (1 - fy) +
      g(i, j + 1) * (1 - fx) * fy +
      g(i + 1, j + 1) * fx * fy
    );
  };
}

/**
 * Drone defence: the playground drone as an interceptor. Waves of attack
 * drones fly at a site over the real terrain; hold one in the seeker circle
 * to lock on, click (or F) to fire a guided missile. Rules in
 * src/lib/flight/strike.ts; drawing in three/strike-layer.ts.
 */
export function createStrikeSim(
  host: SimHost,
  deps: {
    hud: HudStore;
    optics: OpticsBridge;
    /** The camera's image mode: thermal makes what is hot glow. */
    opticsMode: () => OpticsMode;
    strike: StrikeBridge;
    audio: FlightAudio;
    settings: () => FlightSettings;
    scenario: StrikeScenario;
    locale: "en";
    /** Online co-op: the room, this browser's role, and whether it runs the game. */
    coop?: CoopSession;
  },
): StrikeSim {
  const { map } = host;
  const journeys = new Journeys(map);
  const layer = createStrikeLayer(LAYER);
  const transform = () => map._camera.transform;

  // Real metres: the rules and the drawing share the terrain's heights.
  const terrain: TerrainSpecification | null = map.getTerrain();
  if (terrain && (terrain.exaggeration ?? 1) !== 1)
    map.setTerrain({ ...terrain, exaggeration: 1 });
  const maxZoom = map.getMaxZoom();
  const maxPitch = map.getMaxPitch();
  map.setMaxZoom(25);
  map.setMaxPitch(180);
  map.addLayer(layer.layer);
  const partnerLayer = createAircraftLayer(PARTNER_LAYER);
  map.addLayer(partnerLayer.layer);
  /** The F-14 in a co-op launch-site mission, flown by the stand-in. */
  let partner: Partner | null = null;
  /** Online co-op: the partner's F-14 comes over the relay instead. */
  const link = deps.coop
    ? createCoopLink(deps.coop, {
        game: () => game,
        onEvents: (events) => {
          if (drone) onEvents(events, cameraLocal(drone));
        },
        onStart: () => {
          if (!grid || journeys.active) return;
          begin();
          present();
          host.wake();
        },
      })
    : null;
  /** A started match restarts on the next begin (co-op tells the guest which). */
  let begun = false;
  /** Guest: its own launcher cycle and gun rate, the host's game keeps the count. */
  let guestCooldown = 0;
  let guestGunCooldown = 0;

  let scenario = deps.scenario;
  let origin: LngLat = scenario.site.position;
  let drone: DroneState | null = null;
  let game: StrikeGame | null = null;
  let lock: Lock = newLock();
  let status: StrikeStatus | null = null;
  let grid: ((east: number, north: number) => number) | null = null;
  let siteGround = 0;
  let restoreLook: (() => void) | null = null;
  let wantFire = false;
  /** A lock switch asked for (T or the middle button), done on the next frame. */
  let wantSwitch = false;
  let lastHud = 0;
  let lastGround = 0;
  let bannerSeq = 0;
  let flightMode: OpticsFrame["mode"] = "cruise";
  /** Mission time until which the view shakes from a hit. */
  let shakeUntil = -1;
  let warnedHunter = false;
  /** The gun's trigger: the right mouse button, or G. */
  let triggerHeld = false;
  let disposed = false;
  /** Fireballs, wreckage, smoke and trails. */
  const fx = createStrikeEffects();

  /** Ground height: the closest tiles where they have loaded, the start-up grid elsewhere. */
  const ground = (east: number, north: number) => {
    const live = map.queryTerrainElevation(toLngLat(origin, east, north));
    if (live !== null) return live;
    return grid ? grid(east, north) : lastGround;
  };

  const cue = (name: RaceCue, volume = 1) => {
    if (deps.settings().sound) deps.audio.cue(name, volume);
  };

  const cameraLocal = (state: DroneState): Vec3 => {
    const [east, north] = toLocal(origin, state.position);
    return [east, north, state.altitude];
  };
  const angles = (state: DroneState) => ({
    bearing: state.heading,
    pitch: state.pitch,
    roll: state.roll,
  });
  /** Where the camera looks, east-north-up (roll does not change it). */
  const forwardOf = (state: DroneState): Vec3 => {
    const b = (state.heading * Math.PI) / 180;
    const p = (state.pitch * Math.PI) / 180;
    return [Math.sin(b) * Math.sin(p), Math.cos(b) * Math.sin(p), -Math.cos(p)];
  };

  const spec = (s: StrikeScenario) => strikeSpec(s, siteGround);

  const publish = (patch: Partial<StrikeStatus>) => {
    if (!status) return;
    status = { ...status, ...patch };
    deps.strike.setStatus(status);
  };

  /** Everything back to the start of the scenario: the drone in its hover, the game before wave 1. */
  const begin = () => {
    const s = scenario;
    const [se, sn] = toLocal(origin, s.start.position);
    const startGround = ground(se, sn);
    drone = createDrone({
      position: s.start.position,
      altitude: startGround + s.start.height,
      heading: s.start.heading,
      pitch: 88,
      ground: startGround,
    });
    lastGround = startGround;
    const seed = Math.floor(Math.random() * 1e9);
    game = newStrike(spec(s), seed);
    partner =
      !link && deps.settings().partner && s.jet
        ? standInJet(game.spec.site, ground)
        : null;
    link?.started(seed, begun);
    begun = true;
    lock = newLock();
    fx.clear();
    shakeUntil = -1;
    warnedHunter = false;
    triggerHeld = false;
    wantFire = false;
    status = {
      name: s.name[deps.locale],
      site: s.site.name[deps.locale],
      phase: "break",
      wave: -1,
      waveCount: s.waves.length,
      hitsLeft: s.hitsAllowed,
      hitsAllowed: s.hitsAllowed,
      armourLeft: game.spec.playerHits ?? PLAYER_HITS,
      armour: game.spec.playerHits ?? PLAYER_HITS,
      hunters: s.waves.some((w) => w.groups.some((g) => g.kind === "hunter")),
      lostBy: null,
      kills: 0,
      total: totalThreats(game.spec),
      banner: null,
      result: null,
      // In co-op the partner's F-14 is after the launchers: show how many stand.
      launchers: link
        ? { left: game.launchers.length, total: game.launchers.length }
        : undefined,
    };
    deps.strike.setStatus(status);
  };

  const travel = (to: StrikeScenario) => {
    scenario = to;
    host.keys.clear();
    host.setTravelling({ strike: to });
    deps.audio.silence();
    layer.show(null);
    drone = null;
    game = null;
    deps.strike.setStatus(null);
    restoreLook?.();
    restoreLook = null;
    journeys.start({
      look() {
        transform().clearNearFarZOverride();
        map.setCenterClampedToGround(true);
        // The whole battle area from above, so its terrain loads for the grid.
        origin = to.site.position;
        const r = reach(to) + 1500;
        const sw = toLngLat(origin, -r, -r);
        const ne = toLngLat(origin, r, r);
        const fit = map.cameraForBounds([sw, ne], { padding: 40, maxZoom: 12 });
        map.jumpTo({
          center: fit?.center ?? origin,
          zoom: fit?.zoom ?? 11,
          bearing: 0,
          pitch: 0,
          roll: 0,
        });
      },
      place() {
        siteGround = map.queryTerrainElevation(origin) ?? 0;
        grid = elevationGrid(
          (e, n) => map.queryTerrainElevation(toLngLat(origin, e, n)),
          reach(to) + 1500,
          siteGround,
        );
        restoreLook = applyLook(map, to.look);
        map.setCenterClampedToGround(false);
        begin();
        present();
      },
      finish() {
        // Closer tiles have loaded since: hover at the intended height over them.
        if (drone) {
          const [se, sn] = toLocal(origin, drone.position);
          const g = ground(se, sn);
          drone = { ...drone, altitude: g + scenario.start.height, ground: g };
          siteGround = map.queryTerrainElevation(origin) ?? siteGround;
          if (game) game.spec.site = [0, 0, siteGround + scenario.site.aim];
          present();
        }
        host.setTravelling(null);
        host.ready();
        host.wake();
      },
    });
  };

  const onEvents = (events: StrikeEvent[], camera: Vec3) => {
    if (!game) return;
    fx.onEvents(events, game.time, ground);
    const volumeAt = (at: Vec3) =>
      clamp(1 - length(sub(at, camera)) / 7000, 0.08, 1);
    for (const e of events) {
      switch (e.kind) {
        case "wave":
          publish({
            phase: "wave",
            wave: e.index,
            banner: { kind: "wave", n: e.index, seq: ++bannerSeq },
          });
          cue("go");
          break;
        case "wave-clear":
          if (e.index < game.spec.waves.length - 1) {
            publish({
              phase: "break",
              banner: { kind: "clear", n: e.index, seq: ++bannerSeq },
            });
            cue("gate");
          }
          break;
        case "kill": {
          publish({
            kills: game.kills,
            banner: {
              kind: e.type === "decoy" ? "decoy" : "kill",
              n: e.points,
              seq: ++bannerSeq,
            },
          });
          cue("boom", volumeAt(e.at));
          break;
        }
        case "player-hit":
          shakeUntil = game.time + SHAKE_TIME;
          publish({
            armourLeft: e.hitsLeft,
            banner: { kind: "damage", n: e.hitsLeft, seq: ++bannerSeq },
          });
          cue("boom", 1);
          cue("alarm");
          break;
        case "burst":
          cue("boom", volumeAt(e.at) * 0.5);
          break;
        case "site-hit": {
          publish({
            hitsLeft: e.hitsLeft,
            banner: { kind: "hit", n: e.hitsLeft, seq: ++bannerSeq },
          });
          cue("boom", volumeAt(e.at));
          cue("alarm");
          break;
        }
        case "launcher-down":
          // A co-op guest hears of it before the snapshot that shows it.
          if (game.launchers[e.index]) game.launchers[e.index].alive = false;
          if (status?.launchers) {
            const left = game.launchers.filter((l) => l.alive).length;
            publish({
              launchers: { left, total: game.launchers.length },
              banner: { kind: "launcher", n: left, seq: ++bannerSeq },
            });
          }
          break;
        case "won":
        case "lost": {
          const score = scoreStrike(game);
          const best = loadStrikeRecord(scenario.id);
          const won = e.kind === "won";
          // A co-op score is not a solo best.
          const newBest = !link && won && (!best || score.total > best.score);
          if (newBest) saveStrikeRecord(scenario.id, { score: score.total });
          publish({
            phase: e.kind,
            lostBy: game.lostBy,
            kills: game.kills,
            result: {
              score,
              medal: won ? strikeMedal(score.total, scenario.medals) : null,
              newBest,
            },
          });
          cue(won ? (newBest ? "best" : "finish") : "missed");
          break;
        }
      }
    }
  };

  const present = () => {
    if (!drone || !game) return;
    // A hunter's hit shakes the view for a moment (the drone itself is not thrown about).
    const shaking = game.time < shakeUntil && !host.reducedMotion;
    const jolt = shaking ? ((shakeUntil - game.time) / SHAKE_TIME) * SHAKE : 0;
    const state: DroneState = shaking
      ? {
          ...drone,
          heading: drone.heading + jolt * Math.sin(game.time * 53),
          pitch: drone.pitch + jolt * Math.sin(game.time * 41 + 1),
          roll: drone.roll + jolt * Math.sin(game.time * 37 + 2),
        }
      : drone;
    map.jumpTo(
      map.calculateCameraOptionsFromCameraLngLatAltRotation(
        state.position,
        state.altitude,
        state.heading,
        state.pitch,
        state.roll,
      ),
    );
    const camera = cameraLocal(state);
    const height = Math.max(0, camera[2] - ground(camera[0], camera[1]));
    const scaleZ = transform().pixelsPerMeter;
    setNearFar(map, height);

    const eye = eyeMatrix(angles(state));
    const rel = (p: Vec3) => sub(p, camera);
    const playing = game.phase === "wave" || game.phase === "break";
    layer.show({
      eye,
      fov: map.getVerticalFieldOfView(),
      pixelsPerMeter: scaleZ,
      ...fx.view(game, camera, ground),
      thermal: deps.opticsMode() === "ir",
      navLights: scenario.look === "night",
      time: game.time,
    });
    const ally = link ? link.partner() : (partner?.state() ?? null);
    partnerLayer.show(
      ally && {
        eye,
        offset: rel(ally.position),
        orientation: ally.orientation,
        fov: map.getVerticalFieldOfView(),
        cockpit: false,
        surfaces: { elevator: 0, aileron: 0, rudder: 0 },
        flaps: 0,
        rpm: 0.85,
        dt: 0,
        pixelsPerMeter: scaleZ,
        model: "jet",
        gearDown: 0,
        light: LOOKS[scenario.look].light,
      },
    );
    map.triggerRepaint();

    // The HUD: a box on every drone in view, an arrow to the one nearest the site.
    const canvas = map.getCanvas();
    const fov = map.getVerticalFieldOfView();
    const aspect = canvas.width / canvas.height;
    const boxes: StrikeFrame["boxes"] = [];
    let urgent: { distance: number; offset: Vec3 } | null = null;
    let hunter: number | null = null;
    // The gun's pipper goes on the drone nearest the crosshair within range; the nearest drone is heard.
    const forward = forwardOf(drone);
    let gunTarget: { angle: number; t: (typeof game.threats)[number] } | null =
      null;
    let heard: { distance: number; t: (typeof game.threats)[number] } | null =
      null;
    for (const t of game.threats) {
      const fromPlayer = length(rel(t.position));
      if (!heard || fromPlayer < heard.distance)
        heard = { distance: fromPlayer, t };
      if (fromPlayer < GUN_RANGE) {
        const angle = Math.acos(
          clamp(
            (rel(t.position)[0] * forward[0] +
              rel(t.position)[1] * forward[1] +
              rel(t.position)[2] * forward[2]) /
              Math.max(fromPlayer, 1),
            -1,
            1,
          ),
        );
        if (!gunTarget || angle < gunTarget.angle) gunTarget = { angle, t };
      }
      if (t.kind === "hunter") {
        hunter = Math.min(hunter ?? Infinity, fromPlayer);
      } else {
        const toSite = length(sub(t.position, game.spec.site));
        if (!urgent || toSite < urgent.distance)
          urgent = { distance: toSite, offset: rel(t.position) };
      }
      const p = screenPoint(eye, rel(t.position), fov, aspect);
      if (!p.visible || boxes.length >= MAX_BOXES) continue;
      // What each drone is shows on its box; decoys only once they are close.
      const tag =
        t.kind === "jet"
          ? "jet"
          : t.kind === "hunter"
            ? "hunter"
            : t.kind === "decoy" && fromPlayer < DECOY_REVEAL
              ? "decoy"
              : null;
      boxes.push({
        x: p.x,
        y: p.y,
        distance: p.distance,
        state:
          t.id === lock.target ? (lock.locked ? "locked" : "locking") : "none",
        tag,
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
    if (
      playing &&
      hunter !== null &&
      hunter < HUNTER_WARNING &&
      !warnedHunter
    ) {
      warnedHunter = true;
      cue("alarm", 0.6);
    }
    if (hunter === null || hunter > HUNTER_WARNING * 1.3) warnedHunter = false;
    const arrowPoint = urgent
      ? screenPoint(eye, urgent.offset, fov, aspect)
      : null;
    let pipper: StrikeFrame["pipper"] = null;
    if (playing && gunTarget && gunTarget.angle < 0.5) {
      const lead = leadPoint(
        camera,
        drone.velocity,
        gunTarget.t.position,
        gunTarget.t.velocity,
      );
      const p = screenPoint(eye, rel(lead.point), fov, aspect);
      if (p.visible) pipper = { x: p.x, y: p.y };
    }
    deps.optics.push(droneOptics(map, state, lastGround, flightMode));
    deps.strike.push({
      magazine: game.magazine,
      magazineSize: game.spec.magazine,
      threatsLeft: threatsLeft(game),
      breakLeft: game.phase === "break" ? Math.max(0, game.breakLeft) : null,
      lock: {
        progress: lock.progress,
        locked: lock.locked,
        hunting: lock.target !== null,
      },
      cone: (Math.tan(LOCK.cone) / Math.tan((fov * Math.PI) / 360)) * 0.5,
      boxes,
      arrow:
        playing && arrowPoint && !arrowPoint.visible
          ? { angle: arrowPoint.angle, distance: arrowPoint.distance }
          : null,
      closest: playing && urgent ? urgent.distance : null,
      hunter:
        playing && hunter !== null && hunter < HUNTER_WARNING ? hunter : null,
      ammo: game.ammo,
      ammoSize: game.spec.rounds ?? GUN.rounds,
      pipper,
      shake: shaking ? (shakeUntil - game.time) / SHAKE_TIME : 0,
    });

    if (deps.settings().sound && host.isFlying()) {
      deps.audio.update({
        rpm: 0,
        throttle:
          clamp(groundSpeed(state) / (COMBAT_SPEED * DRONE.boost), 0, 1) * 0.7 +
          0.3,
        airspeed: groundSpeed(state),
        stall: false,
        drone: true,
        tone:
          playing && game.magazine > 0
            ? lock.locked
              ? "lock"
              : lock.target !== null
                ? "seek"
                : null
            : null,
        threat: heard
          ? {
              sound:
                heard.t.kind === "jet"
                  ? "jet"
                  : heard.t.kind === "hunter"
                    ? "quad"
                    : "prop",
              distance: heard.distance,
              closing: (() => {
                const to = rel(heard.t.position);
                const v = sub(heard.t.velocity, drone.velocity);
                return (
                  -(to[0] * v[0] + to[1] * v[1] + to[2] * v[2]) /
                  Math.max(heard.distance, 1)
                );
              })(),
            }
          : null,
      });
    } else {
      deps.audio.silence();
    }
  };

  travel(scenario);

  return {
    frame(now, frameDt) {
      // Arcade runs the defence a little faster than real time (not online: both sides keep one clock).
      const dt =
        deps.settings().gameplay === "arcade" && !deps.coop
          ? frameDt * ARCADE_TIME_SCALE
          : frameDt;
      if (!drone || !game || journeys.active) return false;
      const flying = host.isFlying();
      if (!flying) {
        // A button released while paused never reaches us: let go of the trigger.
        triggerHeld = false;
        present();
        return false;
      }
      const input = readInput(host.keys);
      flightMode = input.boost ? "boost" : input.precise ? "precise" : "cruise";
      const [east, north] = toLocal(origin, drone.position);
      const below = map.queryTerrainElevation(drone.position);
      if (below !== null) lastGround = below;
      const r = reach(scenario) + 3000;
      const [w, s] = toLngLat(origin, -r, -r);
      const [e, n] = toLngLat(origin, r, r);
      drone = step(drone, input, dt, {
        groundBelow: below ?? ground(east, north),
        bounds: [w, s, e, n],
        noRoll: host.reducedMotion,
        maxSpeed: COMBAT_SPEED,
        maxPitch: MAX_LOOK_PITCH,
      });

      const camera = cameraLocal(drone);
      const forward = forwardOf(drone);
      // The host (or a solo game) steps the game; a co-op guest draws the
      // host's, carried on between its snapshots.
      let events: StrikeEvent[] = [];
      if (!link || link.host) {
        link?.applyShots(game);
        events = stepStrike(game, ground, dt, camera);
        link?.sendEvents(events);
      } else {
        coast(game, dt);
      }
      link?.tick(dt, {
        position: camera,
        velocity: drone.velocity,
        orientation: fromAttitude({
          heading: drone.heading,
          pitch: 0,
          roll: drone.roll,
        }),
      });
      partner?.step(dt);
      const guest = link !== null && !link.host;
      guestCooldown = Math.max(0, guestCooldown - dt);
      guestGunCooldown = Math.max(0, guestGunCooldown - dt);
      fx.step(dt, game.time, ground);
      const wasLocked = lock.locked;
      if (wantSwitch && switchLock(lock, camera, forward, game.threats, ground))
        cue("count", 0.5);
      wantSwitch = false;
      stepLock(lock, camera, forward, game.threats, dt, ground);
      if (lock.locked && !wasLocked) cue("lock");
      if (triggerHeld || host.keys.has("KeyG")) {
        const from: Vec3 = [
          camera[0] + forward[0] * 3,
          camera[1] + forward[1] * 3,
          camera[2] + forward[2] * 3 - 1,
        ];
        if (guest) {
          if (link && game.ammo > 0 && guestGunCooldown <= 0) {
            link.fire({
              weapon: "gun",
              position: from,
              velocity: drone.velocity,
              forward,
            });
            guestGunCooldown = 1 / GUN.rate;
            cue("gun", 0.8);
          }
        } else if (shoot(game, from, drone.velocity, forward)) cue("gun", 0.8);
      }
      if (wantFire) {
        wantFire = false;
        const from: Vec3 = [
          camera[0] + forward[0] * LAUNCH_AHEAD,
          camera[1] + forward[1] * LAUNCH_AHEAD,
          camera[2] + forward[2] * LAUNCH_AHEAD - LAUNCH_BELOW,
        ];
        if (guest) {
          if (link && game.magazine > 0 && guestCooldown <= 0) {
            link.fire({
              weapon: "missile",
              position: from,
              velocity: drone.velocity,
              forward,
              target: lock.locked ? lock.target : null,
            });
            guestCooldown = FIRE_INTERVAL;
            cue("launch");
          }
        } else if (
          fire(
            game,
            from,
            drone.velocity,
            forward,
            lock.locked ? lock.target : null,
          )
        )
          cue("launch");
      }
      onEvents(events, camera);
      present();

      if (now - lastHud > HUD_INTERVAL_MS) {
        lastHud = now;
        deps.hud.set({
          speed: Math.round(groundSpeed(drone) * 3.6),
          height: Math.round(drone.altitude - lastGround),
          heading: Math.round(drone.heading) % 360,
          ground: Math.round(lastGround),
          lat: Math.round(drone.position[1] * 1e4) / 1e4,
          lng: Math.round(drone.position[0] * 1e4) / 1e4,
          mode: input.boost ? "boost" : input.precise ? "precise" : "cruise",
          tilesLoading: !map.areTilesLoaded(),
          edge: "clear",
        });
      }
      return true;
    },

    keyDown(event) {
      if (event.ctrlKey || event.metaKey) return;
      if (FLIGHT_KEYS.has(event.code) || event.code === "KeyF")
        event.preventDefault();
      if (!event.repeat && event.code === "KeyR") this.reset();
      if (event.code === "KeyF") wantFire = true;
      if (event.code === "KeyT") {
        event.preventDefault();
        if (!event.repeat) wantSwitch = true;
      }
      host.wake();
    },

    keyUp(event) {
      if (event.code.startsWith("Alt")) event.preventDefault();
      host.wake();
    },

    mouseMove(dx, dy) {
      if (!drone) return;
      drone = look(
        drone,
        dx * MOUSE_SENSITIVITY,
        -dy * MOUSE_SENSITIVITY,
        MAX_LOOK_PITCH,
      );
      host.wake();
    },

    mouseDown(button) {
      if (button === 0) wantFire = true;
      if (button === 2) triggerHeld = true;
      if (button === 1) wantSwitch = true;
      host.wake();
    },

    mouseUp(button) {
      if (button === 2) triggerHeld = false;
    },

    /** R: the scenario from the start, at once (the area is already loaded). */
    reset() {
      if (journeys.active) return;
      if (!grid) {
        travel(scenario);
        return;
      }
      begin();
      present();
      host.wake();
    },

    visit() {
      /* Places belong to free flight; the card hides them in this mode. */
    },

    startStrike(next) {
      travel(next);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      journeys.cancel();
      link?.dispose();
      deps.audio.silence();
      layer.show(null);
      host.setTravelling(null);
      deps.strike.setStatus(null);
      deps.hud.set(null);
      restoreLook?.();
      try {
        if (map.getLayer(LAYER)) map.removeLayer(LAYER);
        if (map.getLayer(PARTNER_LAYER)) map.removeLayer(PARTNER_LAYER);
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
