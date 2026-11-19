import type { EdgeState } from "@/lib/geo-boundary";

/** What the HUD shows, already rounded to what is displayed. */
export interface HudSnapshot {
  /** km/h. */
  speed: number;
  /** Real metres above the ground. */
  height: number;
  /** Whole degrees, 0–359. */
  heading: number;
  /** Real metres above sea level. */
  ground: number;
  /** Rounded to four decimals. */
  lat: number;
  lng: number;
  mode: "cruise" | "boost" | "precise";
  tilesLoading: boolean;
  edge: EdgeState;
}

export interface HudStore {
  get(): HudSnapshot | null;
  /** Notifies subscribers only when a displayed value changed. */
  set(next: HudSnapshot | null): void;
  subscribe(listener: () => void): () => void;
}

/**
 * Holds the HUD readout outside React, so the frame loop can publish values
 * without re-rendering the page: only the HUD subscribes
 * (useSyncExternalStore), and only when what it shows has changed.
 */
export function createHudStore(): HudStore {
  let snapshot: HudSnapshot | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    set(next) {
      if (next === snapshot) return;
      if (next && snapshot) {
        const keys = Object.keys(next) as (keyof HudSnapshot)[];
        if (keys.every((key) => next[key] === snapshot![key])) return;
      }
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
