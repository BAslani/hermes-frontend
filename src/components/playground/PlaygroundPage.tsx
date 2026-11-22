"use client";

import type { ErrorEvent, Map as MapLibreMap } from "maplibre-gl";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Course } from "@/config/courses";
import { START_CAMERA } from "@/config/map";
import type { MissionConfig } from "@/config/missions";
import { AIRPORTS, type Airport, type Place } from "@/config/playground";
import { STRIKES, type StrikeScenario } from "@/config/strikes";
import { LOCALES, type Locale } from "@/content";
import type { CoopSession } from "@/lib/coop/client";
import { rewriteImageryRequest, satellite3dStyle } from "@/lib/imagery";
import {
  configureWorker,
  DAY_SKY,
  hasWebGL,
  prefersReducedMotion,
} from "@/lib/map-effects";
import {
  createOpticsBridge,
  DroneOptics,
  OPTICS_FILTER,
  OPTICS_MODES,
  type OpticsMode,
} from "./DroneOptics";
import { createFlightAudio } from "./flight-audio";
import { createHudStore } from "./hud-store";
import { createPanelBridge, InstrumentPanel } from "./InstrumentPanel";
import { createMissionBridge, MissionHud } from "./MissionHud";
import { PlaygroundCard, type Vehicle } from "./PlaygroundCard";
import { PlaygroundHud } from "./PlaygroundHud";
import { createRaceBridge, RaceHud } from "./RaceHud";
import { createStrikeBridge, StrikeHud } from "./StrikeHud";
import {
  DEFAULT_SETTINGS,
  type FlightSettings,
  getSettings,
  setSettings,
  subscribeSettings,
} from "./settings";
import { type AirplaneSim, createAirplaneSim } from "./sims/airplane-sim";
import { createDroneSim } from "./sims/drone-sim";
import { createHeliSim, type HeliSim } from "./sims/heli-sim";
import { createStrikeSim, type StrikeSim } from "./sims/strike-sim";
import type { CrashInfo, Sim, TravelTarget } from "./sims/types";
import "maplibre-gl/dist/maplibre-gl.css";

type Status = "loading" | "ready" | "flying" | "paused" | "error";

/** A style that loads but never finishes (slow or broken tile server) is an error after this long. */
const LOAD_TIMEOUT_MS = 20_000;
const START = START_CAMERA;

const subscribeNever = () => () => {};
const isTouchOnly = () =>
  window.matchMedia("(pointer: coarse)").matches &&
  !window.matchMedia("(any-pointer: fine)").matches;

/**
 * Only failures that leave nothing to fly over are fatal: the style itself or
 * the elevation source. A missing sprite, font or single tile is not.
 */
function isFatal(event: ErrorEvent, styleReady: boolean) {
  const detail = event as ErrorEvent & {
    sourceId?: string;
    tile?: unknown;
    source?: { type?: string };
  };
  if (detail.tile) return false;
  if (detail.sourceId) return detail.source?.type === "raster-dem";
  // Sprites and fonts are requested after the style has loaded.
  return !styleReady;
}

/**
 * A game page (/play/<game>): the map, the frame loop, the input wiring and
 * the overlays. What flies is a simulator from ./sims, fixed per page; the
 * page only passes it frames, keys and mouse movement.
 */
export function PlaygroundPage({
  vehicle,
  locale = "en",
  coop,
}: {
  vehicle: Vehicle;
  locale?: Locale;
  /** Online co-op: the room this game is played in (the co-op page passes it). */
  coop?: CoopSession;
}) {
  const { dict, dir } = LOCALES[locale];
  const t = dict.playgroundPage;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Sim | AirplaneSim | HeliSim | StrikeSim | null>(null);
  const keysRef = useRef(new Set<string>());
  const statusRef = useRef<Status>("loading");
  /** Restarts the frame loop, which stops itself when nothing is happening. */
  const wakeRef = useRef<() => void>(() => {});
  /** Where the airplane lines up when it is selected. */
  const airportRef = useRef<Airport>(AIRPORTS[0]);
  /** The drone-defence scenario to start when the interceptor is created. */
  const scenarioRef = useRef<StrikeScenario>(
    STRIKES.find((s) => s.id === coop?.scenario) ?? STRIKES[0],
  );

  const [status, setStatusState] = useState<Status>("loading");
  /** Bumped by Retry: tears the map down and builds a new one. */
  const [attempt, setAttempt] = useState(0);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [locked, setLocked] = useState(false);
  const [travelling, setTravelling] = useState<TravelTarget | null>(null);
  const [crash, setCrash] = useState<CrashInfo | null>(null);
  const settings = useSyncExternalStore(
    subscribeSettings,
    getSettings,
    () => DEFAULT_SETTINGS,
  );
  const [hudStore] = useState(createHudStore);
  const [panel] = useState(createPanelBridge);
  const [raceBridge] = useState(createRaceBridge);
  const [missionBridge] = useState(createMissionBridge);
  const [strikeBridge] = useState(createStrikeBridge);
  const [opticsBridge] = useState(createOpticsBridge);
  /** The drone camera's image: colour, monochrome or thermal (V cycles). */
  const [optics, setOptics] = useState<OpticsMode>("tv");
  const opticsRef = useRef<OpticsMode>("tv");
  useEffect(() => {
    opticsRef.current = optics;
  }, [optics]);
  const [audio] = useState(createFlightAudio);
  const touchOnly = useSyncExternalStore(
    subscribeNever,
    isTouchOnly,
    () => false,
  );
  /** A race is on: flown in the race plane, with its wider airspeed dial. */
  const racing = useSyncExternalStore(
    raceBridge.subscribe,
    () => raceBridge.status() !== null,
    () => false,
  );
  /** An F-14 strike is on (the airplane game): flown in the jet, with its dials. */
  const striking = useSyncExternalStore(
    strikeBridge.subscribe,
    () => strikeBridge.status() !== null,
    () => false,
  );

  const setStatus = useCallback((next: Status) => {
    statusRef.current = next;
    setStatusState(next);
    if (next !== "flying") keysRef.current.clear();
  }, []);

  useEffect(() => () => audio.dispose(), [audio]);

  const changeSettings = useCallback(
    (next: FlightSettings) => {
      const swapped =
        next.aircraft !== getSettings().aircraft ||
        (vehicle === "airplane" && next.gameplay !== getSettings().gameplay);
      setSettings(next);
      if (!next.sound) audio.silence();
      // A different aircraft, or airplane gameplay: start again where this flight started, in it.
      if (swapped) simRef.current?.reset();
    },
    [audio, vehicle],
  );

  // The map.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let created: MapLibreMap | undefined;
    let cancelled = false;
    let failed = false;
    let styleReady = false;

    const fail = () => {
      if (cancelled || failed) return;
      failed = true;
      window.clearTimeout(loadTimer);
      setMap(null);
      created?.remove();
      created = undefined;
      hudStore.set(null);
      setStatus("error");
    };
    const loadTimer = window.setTimeout(() => {
      if (statusRef.current === "loading") fail();
    }, LOAD_TIMEOUT_MS);

    (hasWebGL()
      ? import("maplibre-gl")
      : Promise.reject(new Error("WebGL unavailable"))
    )
      .then((maplibre) => {
        if (cancelled || failed) return;
        configureWorker(maplibre);
        const instance = new maplibre.Map({
          container,
          style: satellite3dStyle(),
          center: START.center,
          zoom: START.zoom,
          bearing: START.bearing,
          pitch: 72,
          maxPitch: 100,
          // The vehicle owns the camera: no drag, scroll or keyboard handlers.
          interactive: false,
          pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
          // Flying covers ground quickly; keep more tiles around for turning back.
          maxTileCacheSize: 800,
          transformRequest: (url) => {
            const rewritten = rewriteImageryRequest(url);
            return rewritten ? { url: rewritten } : undefined;
          },
          attributionControl: false,
          fadeDuration: 150,
        });
        created = instance;
        if (process.env.NODE_ENV === "development") {
          (window as unknown as { __playground?: unknown }).__playground = {
            map: instance,
            sim: () => simRef.current,
          };
        }

        instance.once("style.load", () => (styleReady = true));
        instance.on("error", (event) => {
          if (process.env.NODE_ENV === "development") console.warn(event.error);
          if (isFatal(event, styleReady)) fail();
        });
        instance.on("webglcontextlost", fail);

        instance.once("load", () => {
          if (cancelled || failed) return;
          window.clearTimeout(loadTimer);
          if (!instance.getSky()) instance.setSky(DAY_SKY);
          // The assembled fallback style paints a near-black "space" background.
          if (instance.getLayer("space"))
            instance.setPaintProperty("space", "background-color", "#6b675d");
          setMap(instance);
        });
      })
      .catch(fail);

    return () => {
      cancelled = true;
      window.clearTimeout(loadTimer);
      setMap(null);
      created?.remove();
    };
  }, [attempt, hudStore, setStatus]);

  // The simulator for the selected vehicle, and the frame loop that drives it.
  useEffect(() => {
    const container = containerRef.current;
    if (!map || !container) return;
    let frame = 0;
    let running = false;
    let stopped = false;
    let last = 0;

    const tick = (now: number) => {
      const sim = simRef.current;
      if (!sim || document.hidden) {
        running = false;
        return;
      }
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (sim.frame(now, dt)) frame = requestAnimationFrame(tick);
      else running = false;
    };
    const wake = () => {
      if (running || stopped) return;
      running = true;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };
    wakeRef.current = wake;

    const host = {
      map,
      container,
      keys: keysRef.current,
      isFlying: () => statusRef.current === "flying",
      wake,
      setTravelling,
      setCrash,
      ready: () => {
        if (statusRef.current === "loading") setStatus("ready");
      },
      reducedMotion: prefersReducedMotion(),
    };
    const sim =
      vehicle === "airplane"
        ? createAirplaneSim(host, {
            panel,
            race: raceBridge,
            strike: strikeBridge,
            audio,
            settings: getSettings,
            airport: airportRef.current,
            locale,
            coop,
          })
        : vehicle === "helicopter"
          ? createHeliSim(host, {
              panel,
              mission: missionBridge,
              audio,
              settings: getSettings,
              airport: airportRef.current,
              locale,
            })
          : vehicle === "strike"
            ? createStrikeSim(host, {
                hud: hudStore,
                optics: opticsBridge,
                opticsMode: () => opticsRef.current,
                strike: strikeBridge,
                audio,
                settings: getSettings,
                scenario: scenarioRef.current,
                locale,
                coop,
              })
            : createDroneSim(host, hudStore, opticsBridge);
    simRef.current = sim;

    const onVisible = () => !document.hidden && wake();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisible);
      wakeRef.current = () => {};
      simRef.current = null;
      sim.dispose();
    };
  }, [
    map,
    vehicle,
    hudStore,
    panel,
    raceBridge,
    missionBridge,
    strikeBridge,
    opticsBridge,
    audio,
    setStatus,
    locale,
    coop,
  ]);

  const retry = useCallback(() => {
    setStatus("loading");
    setAttempt((n) => n + 1);
  }, [setStatus]);

  /** Pointer lock gives unlimited mouse travel; without it, drag instead. */
  const requestLock = useCallback(() => {
    try {
      const request = wrapperRef.current?.requestPointerLock?.() as
        | Promise<void>
        | undefined;
      request?.catch?.(() => {});
    } catch {
      /* drag fallback */
    }
  }, []);

  const startFlying = useCallback(() => {
    if (!simRef.current) return;
    setStatus("flying");
    requestLock();
    // Browsers only allow sound after a click: this is that click.
    if (vehicle !== "drone" && getSettings().sound) audio.start();
    wakeRef.current();
  }, [audio, requestLock, setStatus, vehicle]);

  const reset = useCallback(() => simRef.current?.reset(), []);
  const visit = useCallback(
    (place: Place) => {
      if (!simRef.current) return;
      simRef.current.visit(place);
      if (statusRef.current !== "flying") startFlying();
    },
    [startFlying],
  );
  const startAt = useCallback(
    (airport: Airport) => {
      airportRef.current = airport;
      const sim = simRef.current;
      if (!sim || !("startAt" in sim)) return;
      sim.startAt(airport);
      if (statusRef.current !== "flying") startFlying();
    },
    [startFlying],
  );
  const startRace = useCallback(
    (course: Course) => {
      const sim = simRef.current;
      if (!sim || !("startRace" in sim)) return;
      sim.startRace(course);
      if (statusRef.current !== "flying") startFlying();
    },
    [startFlying],
  );

  const startMission = useCallback(
    (mission: MissionConfig) => {
      const sim = simRef.current;
      if (!sim || !("startMission" in sim)) return;
      sim.startMission(mission);
      if (statusRef.current !== "flying") startFlying();
    },
    [startFlying],
  );

  const startStrike = useCallback(
    (scenario: StrikeScenario) => {
      scenarioRef.current = scenario;
      const sim = simRef.current;
      if (!sim || !("startStrike" in sim)) return;
      sim.startStrike(scenario);
      if (statusRef.current !== "flying") startFlying();
    },
    [startFlying],
  );

  // Pointer lock, mouse and keyboard.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    let dragging = false;

    const onLockChange = () => {
      const has = document.pointerLockElement === el;
      setLocked(has);
      if (!has && statusRef.current === "flying") setStatus("paused");
    };
    const onMouseMove = (e: MouseEvent) => {
      if (statusRef.current !== "flying") return;
      if (document.pointerLockElement === el || dragging || e.buttons & 2) {
        simRef.current?.mouseMove(e.movementX, e.movementY, e.buttons);
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (
        statusRef.current !== "flying" ||
        document.pointerLockElement === el ||
        e.button !== 0
      )
        return;
      // Chrome refuses pointer lock for about a second after Esc, so Resume can
      // leave the vehicle flying without it: every click on the map asks again,
      // and dragging works until one succeeds.
      dragging = true;
      requestLock();
    };
    const onPointerUp = () => (dragging = false);
    // Buttons for the vehicle (fire, gun) come as mouse events: pointer events
    // send no second "down" while another button is already held.
    const onMouseDown = (e: MouseEvent) => {
      if (statusRef.current === "flying" && document.pointerLockElement === el)
        simRef.current?.mouseDown?.(e.button);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (statusRef.current === "flying") simRef.current?.mouseUp?.(e.button);
    };
    // Right drag orbits the camera; no browser menu over the map while flying.
    const onContextMenu = (e: MouseEvent) => {
      if (statusRef.current === "flying") e.preventDefault();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (statusRef.current !== "flying") return;
      if (e.code === "Escape" && document.pointerLockElement !== el) {
        setStatus("paused");
        return;
      }
      keysRef.current.add(e.code);
      if (
        e.code === "KeyV" &&
        !e.repeat &&
        (vehicle === "drone" || vehicle === "strike")
      ) {
        setOptics(
          (mode) =>
            OPTICS_MODES[
              (OPTICS_MODES.indexOf(mode) + 1) % OPTICS_MODES.length
            ],
        );
      }
      simRef.current?.keyDown(e);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.code);
      if (statusRef.current === "flying") simRef.current?.keyUp(e);
    };
    const onBlur = () => keysRef.current.clear();

    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("mousemove", onMouseMove);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    el.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("mousemove", onMouseMove);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      el.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      if (document.pointerLockElement === el) document.exitPointerLock();
    };
  }, [requestLock, setStatus, vehicle]);

  // Pausing silences the engine; resuming lets the next frame bring it back.
  useEffect(() => {
    if (status !== "flying") audio.silence();
  }, [audio, status]);

  const showCard = status === "ready" || status === "paused";
  const droneView = vehicle === "drone" || vehicle === "strike";
  const flying = status === "flying";
  const loaded = status !== "loading" && status !== "error";
  const travelLabel = travelling?.strike
    ? t.strike.gettingReady.replace("{mission}", travelling.strike.name[locale])
    : travelling?.mission
      ? t.mission.gettingReady.replace(
          "{mission}",
          travelling.mission.name[locale],
        )
      : travelling?.course
        ? t.race.gettingReady.replace(
            "{course}",
            travelling.course.name[locale],
          )
        : travelling?.place
          ? t.flyingTo.replace("{place}", travelling.place.name[locale])
          : travelling?.airport
            ? t.airplane.liningUp.replace(
                "{place}",
                travelling.airport.name[locale],
              )
            : t.loading;

  return (
    <div
      ref={wrapperRef}
      dir={dir}
      className={`on-night fixed inset-0 overflow-hidden bg-night text-white select-none ${
        flying ? "cursor-crosshair" : ""
      }`}
    >
      {/* MapLibre's CSS makes its container position: relative, so size it from a wrapper. */}
      {/* Earth-toned backdrop: imagery that hasn't arrived yet reads as haze, not holes. */}
      <div className="absolute inset-0 bg-[#6b675d]">
        <div
          ref={containerRef}
          role="region"
          aria-label={t.mapLabel}
          className="h-full w-full"
          style={{ filter: droneView ? OPTICS_FILTER[optics] : "none" }}
        />
      </div>

      {/* Jumping somewhere: covers the map until the destination has loaded. */}
      {travelling && loaded && (
        <div
          role="status"
          className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-night/85 p-4 backdrop-blur-md"
        >
          <div className="flex items-center gap-3 rounded-full bg-night-2 px-5 py-3 text-sm font-medium">
            <span
              className="size-2 animate-pulse rounded-full bg-accent-bright"
              aria-hidden
            />
            {travelLabel}
          </div>
        </div>
      )}

      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-4">
        <a
          href="/"
          className="pointer-events-auto rounded-full bg-night/70 px-4 py-2 text-sm font-medium backdrop-blur hover:bg-night/90"
        >
          <span aria-hidden>{dir === "rtl" ? "→" : "←"}</span> {t.back}
        </a>
        {flying && (
          <span className="rounded-full bg-night/60 px-3 py-1.5 text-xs text-night-body backdrop-blur">
            {vehicle === "drone"
              ? t.hint
              : vehicle === "strike"
                ? t.strike.hint
                : vehicle === "helicopter"
                  ? t.helicopter.hint
                  : t.airplane.hint}
          </span>
        )}
      </div>

      {/* Crosshair (drone), and how to get the mouse back while flying without pointer lock */}
      {flying && !travelling && !crash && (
        <div
          aria-hidden={locked}
          className="pointer-events-none absolute inset-0 z-10 grid place-items-center"
        >
          {!locked && (
            <p
              role="status"
              className="absolute top-1/2 mt-8 rounded-full bg-night/75 px-4 py-2 text-sm font-medium backdrop-blur"
            >
              {t.captureMouse}
            </p>
          )}
        </div>
      )}

      {loaded && droneView && (
        <DroneOptics
          bridge={opticsBridge}
          mode={optics}
          visible={flying && !travelling}
        />
      )}
      {loaded && droneView && (
        <PlaygroundHud
          store={hudStore}
          locale={locale}
          t={t}
          flying={flying && !travelling}
          readout={false}
        />
      )}
      {loaded && vehicle !== "drone" && vehicle !== "strike" && !travelling && (
        <InstrumentPanel
          bridge={panel}
          t={t.instruments}
          locale={locale}
          metric={settings.metric}
          kind={
            vehicle === "helicopter"
              ? "heli"
              : racing
                ? "race"
                : striking || settings.aircraft === "jet"
                  ? "jet"
                  : "light"
          }
        />
      )}
      {loaded && vehicle === "airplane" && !travelling && !crash && (
        <RaceHud bridge={raceBridge} locale={locale} t={t.race} dir={dir} />
      )}
      {loaded && vehicle === "helicopter" && !travelling && !crash && (
        <MissionHud
          bridge={missionBridge}
          locale={locale}
          t={t.mission}
          dir={dir}
        />
      )}
      {loaded &&
        (vehicle === "strike" || vehicle === "airplane") &&
        !travelling && (
          <StrikeHud
            bridge={strikeBridge}
            locale={locale}
            t={t.strike}
            dir={dir}
          />
        )}

      {crash && flying && (
        <div
          role="alert"
          className="pointer-events-none absolute inset-x-0 top-1/3 z-10 flex justify-center px-4"
        >
          <div className="max-w-sm rounded-2xl border border-red-400/60 bg-night-2/95 p-5 text-center shadow-2xl">
            <p className="t-eyebrow mb-1 text-red-300">{t.crash.title}</p>
            <p className="mb-3 text-night-body">
              {crash.cause === "hard-landing"
                ? t.crash.hardLanding
                : t.crash.structure}
            </p>
            <p className="text-sm font-semibold text-white">
              {t.crash.restart}
            </p>
          </div>
        </div>
      )}

      {status === "loading" && (
        <div
          role="status"
          className="pointer-events-none absolute top-16 inset-s-4 z-10 flex items-center gap-2 rounded-full bg-night/70 px-3 py-1.5 text-xs font-medium backdrop-blur"
        >
          <span
            className="size-1.5 animate-pulse rounded-full bg-accent-bright"
            aria-hidden
          />
          {t.loading}
        </div>
      )}

      {status === "error" && (
        <div className="absolute inset-0 z-20 grid place-items-center p-4">
          <div className="max-w-sm rounded-2xl bg-night-2 p-6 text-center">
            <p className="mb-5 text-night-body">{t.unavailable}</p>
            <button
              type="button"
              className="btn btn-night-primary"
              onClick={retry}
            >
              {t.retry}
            </button>
          </div>
        </div>
      )}

      {showCard && (
        <PlaygroundCard
          t={t}
          locale={locale}
          paused={status === "paused"}
          touchOnly={touchOnly}
          vehicle={vehicle}
          settings={settings}
          onSettings={changeSettings}
          onStart={startFlying}
          onReset={reset}
          onPlace={visit}
          onAirport={startAt}
          onCourse={startRace}
          onMission={startMission}
          onStrike={startStrike}
          coop={
            coop && {
              code: coop.code,
              role: coop.role,
              host: coop.host,
              missionName: scenarioRef.current.name[locale],
            }
          }
        />
      )}
    </div>
  );
}
