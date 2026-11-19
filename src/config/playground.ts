/**
 * Playground (/playground) configuration: where the drone may fly and the
 * places it can jump to.
 *
 * Kept import-free (types only) so Node can load it directly.
 */
import type { FlightSceneId } from "./flights.ts";

/* ------------------------------------------------------------------------ */
/* Flyable area                                                              */
/* ------------------------------------------------------------------------ */

/**
 * The drone stays inside the Iran outline (src/config/iran-outline.ts) grown
 * by this margin, so the coast, the Gulf islands and the border ranges can be
 * seen from both sides.
 */
export const FLIGHT_MARGIN_KM = 20;

/**
 * Hard limit around the flyable area: [west, south, east, north].
 *
 * Detailed imagery (zoom 12 and deeper) exists in a rectangle of roughly
 * 43.6–64.2°E, 24.5–40.1°N. Outside it /sat answers 404 and only a coarse
 * world mosaic (up to about zoom 10) is left. Measured in November 2026 by
 * requesting zoom-12 tiles along lines across each edge. The elevation data
 * (TERRAIN_BOUNDS) starts at 44°E and 25°N, so those two sides are tighter.
 */
export const FLIGHT_BOUNDS: [number, number, number, number] = [
  44.0, 25.0, 64.0, 40.0,
];

/** Show "approaching the edge" within this distance of the limit. */
export const EDGE_WARNING_KM = 5;
/** Show "edge of the map" within this distance of the limit, metres. */
export const EDGE_REACHED_M = 250;

/* ------------------------------------------------------------------------ */
/* Places to visit                                                           */
/* ------------------------------------------------------------------------ */

export interface PlaceCamera {
  /** Where the drone is put: [lng, lat]. */
  position: [number, number];
  /** Real metres above the ground at that point. */
  height: number;
  /** Degrees, 0 = north. */
  heading: number;
  /** Camera pitch as MapLibre uses it: 0 = straight down, 90 = horizon. */
  pitch: number;
}

export interface Place {
  id: string;
  name: { en: string };
  /** A camera pose, or the saved view of a scene in src/config/flights.ts. */
  view: PlaceCamera | { scene: FlightSceneId };
}

/**
 * In menu order; keys 1–9 and 0 jump to the first ten. Every pose was checked
 * in the playground itself (teleport, look, adjust), not taken from memory.
 */
export const PLACES: Place[] = [
  {
    id: "damavand",
    name: { en: "Mount Damavand" },
    view: { position: [52.02, 35.87], height: 1800, heading: 42, pitch: 82 },
  },
  {
    id: "tehran",
    name: { en: "Tehran and the Alborz" },
    view: { position: [51.39, 35.62], height: 1500, heading: 0, pitch: 78 },
  },
  {
    id: "tochal",
    name: { en: "Tochal" },
    view: { position: [51.42, 35.82], height: 700, heading: 0, pitch: 82 },
  },
  {
    id: "naqsh-e-jahan",
    name: { en: "Naqsh-e Jahan Square, Isfahan" },
    view: { position: [51.6775, 32.6495], height: 350, heading: 0, pitch: 62 },
  },
  {
    id: "persepolis",
    name: { en: "Persepolis" },
    view: { position: [52.878, 29.935], height: 300, heading: 90, pitch: 66 },
  },
  {
    id: "lut",
    name: { en: "Lut desert kaluts, Shahdad" },
    view: { position: [57.95, 30.6], height: 600, heading: 20, pitch: 74 },
  },
  {
    id: "ramsar",
    name: { en: "Caspian coast at Ramsar" },
    view: { position: [50.66, 36.96], height: 600, heading: 185, pitch: 78 },
  },
  {
    id: "hormuz",
    name: { en: "Hormuz Island" },
    view: { position: [56.46, 26.98], height: 900, heading: 0, pitch: 70 },
  },
  {
    id: "savadkuh",
    name: { en: "Savadkuh forests, Lafurak" },
    view: { scene: "savadkuh" },
  },
  {
    id: "jandaq",
    name: { en: "Jandaq desert" },
    view: { scene: "jandaq" },
  },
];

/* ------------------------------------------------------------------------ */
/* Airports                                                                  */
/* ------------------------------------------------------------------------ */

export interface Airport {
  id: string;
  name: { en: string };
  /**
   * Roughly the middle of the airfield. Only used to bring the map there: the
   * runway itself (ends, heading, length) is read from the basemap's
   * `aeroway` layer at that spot, never from this file.
   */
  center: [number, number];
}

/** Where the airplane can start, lined up on a runway. The first is the default. */
export const AIRPORTS: Airport[] = [
  { id: "mehrabad", name: { en: "Tehran Mehrabad" }, center: [51.313, 35.689] },
  { id: "isfahan", name: { en: "Isfahan" }, center: [51.861, 32.751] },
  { id: "shiraz", name: { en: "Shiraz" }, center: [52.59, 29.539] },
  { id: "ramsar", name: { en: "Ramsar" }, center: [50.68, 36.91] },
  { id: "tabriz", name: { en: "Tabriz" }, center: [46.235, 38.134] },
];

/** Jumping to a place in an aircraft starts in level flight at least this high above it, metres. */
export const PLACE_MIN_HEIGHT = 450;
