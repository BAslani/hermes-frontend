import type { Map as MapLibreMap } from "maplibre-gl";
import type { Course } from "@/config/courses";
import type { MissionConfig } from "@/config/missions";
import type { Airport, Place } from "@/config/playground";
import type { StrikeScenario } from "@/config/strikes";
import type { CrashCause } from "@/lib/flight/airplane";

/** What the "loading" overlay is waiting for; null place and airport means the start point. */
export interface TravelTarget {
  place?: Place;
  airport?: Airport;
  course?: Course;
  mission?: MissionConfig;
  strike?: StrikeScenario;
}

export interface CrashInfo {
  cause: CrashCause;
  /** Which part touched the ground, for a structure strike. */
  part?: string;
}

/** What a simulator gets from the page around it. */
export interface SimHost {
  map: MapLibreMap;
  container: HTMLElement;
  /** KeyboardEvent.code of every key held right now. Cleared when flying stops. */
  keys: Set<string>;
  isFlying(): boolean;
  /** Restart the frame loop, which stops itself whenever a simulator reports nothing to do. */
  wake(): void;
  /** Show or hide the overlay that covers the map while a destination loads. */
  setTravelling(target: TravelTarget | null): void;
  setCrash(crash: CrashInfo | null): void;
  /** The simulator has a vehicle in place for the first time. */
  ready(): void;
  reducedMotion: boolean;
}

/**
 * One vehicle: owns its physics, the map camera and its read-outs. Plain
 * objects rather than React components, so the frame loop never renders.
 */
export interface Sim {
  /** One animation frame, `dt` seconds after the last. Returns true while more frames are needed. */
  frame(now: number, dt: number): boolean;
  /** Only called while flying. */
  keyDown(event: KeyboardEvent): void;
  keyUp(event: KeyboardEvent): void;
  /** Mouse moved while flying, with pointer lock or a button held. `buttons` as in MouseEvent. */
  mouseMove(dx: number, dy: number, buttons: number): void;
  /** A mouse button went down while flying with the pointer locked. `button` as in MouseEvent. */
  mouseDown?(button: number): void;
  /** A mouse button came up (anywhere), while flying. */
  mouseUp?(button: number): void;
  /** Back to where this flight started. */
  reset(): void;
  /** Jump to a place. */
  visit(place: Place): void;
  dispose(): void;
}

/** Longest a jump waits for the destination's tiles before going ahead anyway. */
export const TRAVEL_TIMEOUT_MS = 15_000;

/**
 * Runs the two-stage wait every jump needs: look at the destination, wait
 * for the map to go idle (its elevation is only known once its tiles have
 * loaded), let `place` put the vehicle and camera there, wait for that view's
 * tiles, then `finish`. A newer journey cancels an older one.
 */
export class Journeys {
  private current: object | null = null;
  private timer = 0;
  private readonly map: MapLibreMap;

  constructor(map: MapLibreMap) {
    this.map = map;
  }

  get active() {
    return this.current !== null;
  }

  start(steps: { look(): void; place(): void; finish(): void }) {
    const { map } = this;
    const token = {};
    this.current = token;
    window.clearTimeout(this.timer);
    let placed = false;
    const place = () => {
      placed = true;
      steps.place();
      map.triggerRepaint();
    };
    const finish = () => {
      if (this.current !== token) return;
      this.current = null;
      window.clearTimeout(this.timer);
      map.off("idle", onIdle);
      steps.finish();
    };
    const onIdle = () => {
      if (this.current !== token) map.off("idle", onIdle);
      else if (!placed) place();
      else finish();
    };
    steps.look();
    map.on("idle", onIdle);
    // A camera that did not move draws nothing, and nothing drawn never goes idle.
    map.triggerRepaint();
    this.timer = window.setTimeout(() => {
      if (this.current !== token) return;
      if (!placed) place();
      finish();
    }, TRAVEL_TIMEOUT_MS);
  }

  cancel() {
    this.current = null;
    window.clearTimeout(this.timer);
  }
}
