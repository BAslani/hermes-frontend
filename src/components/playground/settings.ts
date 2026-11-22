/** Player settings for the aircraft, kept in localStorage. This is a demo: no backend. */
export interface FlightSettings {
  /** Auto-coordinated rudder and gentle roll levelling. */
  assists: boolean;
  /** The mouse yoke springs back to centre when the mouse stops. */
  selfCentring: boolean;
  /** km/h, metres and m/s instead of knots, feet and ft/min. */
  metric: boolean;
  sound: boolean;
  /** Direction the wind blows from, degrees, and its speed in knots (0 = calm). */
  windFrom: number;
  windKnots: number;
  /** What free flight is flown in (races always use the race plane). */
  aircraft: "trainer" | "jet";
  /** Realistic flight physics, or arcade: faster, nose-pointing action-game handling. */
  gameplay: "realistic" | "arcade";
  /** Co-op launcher missions: a stand-in partner flies the other aircraft. */
  partner: boolean;
}

export const DEFAULT_SETTINGS: FlightSettings = {
  assists: true,
  selfCentring: false,
  metric: false,
  sound: true,
  windFrom: 270,
  windKnots: 0,
  aircraft: "trainer",
  gameplay: "realistic",
  partner: false,
};

const KEY = "141-playground-settings";
export const MAX_WIND_KNOTS = 25;

function loadSettings(): FlightSettings {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(KEY) ?? "{}",
    ) as Partial<FlightSettings>;
    const bool = (value: unknown, fallback: boolean) =>
      typeof value === "boolean" ? value : fallback;
    const num = (value: unknown, fallback: number, lo: number, hi: number) =>
      typeof value === "number" && Number.isFinite(value)
        ? Math.min(hi, Math.max(lo, value))
        : fallback;
    return {
      assists: bool(stored.assists, DEFAULT_SETTINGS.assists),
      selfCentring: bool(stored.selfCentring, DEFAULT_SETTINGS.selfCentring),
      metric: bool(stored.metric, DEFAULT_SETTINGS.metric),
      sound: bool(stored.sound, DEFAULT_SETTINGS.sound),
      windFrom: num(stored.windFrom, DEFAULT_SETTINGS.windFrom, 0, 359),
      windKnots: num(
        stored.windKnots,
        DEFAULT_SETTINGS.windKnots,
        0,
        MAX_WIND_KNOTS,
      ),
      aircraft: stored.aircraft === "jet" ? "jet" : "trainer",
      gameplay: stored.gameplay === "arcade" ? "arcade" : "realistic",
      partner: bool(stored.partner, DEFAULT_SETTINGS.partner),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: FlightSettings) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode or storage full: the settings just don't persist */
  }
}

/*
 * A small store, so React reads the settings with useSyncExternalStore (the
 * stored values only exist in the browser) and the frame loop reads them
 * directly without a render.
 */
let current: FlightSettings | null = null;
const listeners = new Set<() => void>();

export function getSettings(): FlightSettings {
  current ??= loadSettings();
  return current;
}

export function setSettings(next: FlightSettings) {
  current = next;
  saveSettings(next);
  listeners.forEach((listener) => listener());
}

export function subscribeSettings(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
