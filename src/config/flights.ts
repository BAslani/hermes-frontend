/**
 * Cinematic camera flights for the explorer's "3D Satellite" style.
 *
 * Each scene starts from a view saved in the 141 map viewer (URL kept
 * verbatim) and flies a path described in the drone's own frame: legs of a
 * given length and duration, with heading changes, height above ground,
 * camera pitch and bank eased in between. See src/lib/drone-flight.ts.
 *
 * Kept import-free (types only) so scripts can load it with Node directly.
 */

export type FlightSceneId = "lafurak" | "jandaq" | "savadkuh";

export type FlightPhase =
  | "approach"
  | "forward"
  | "turn"
  | "return"
  | "overview";

export interface FlightLeg {
  /** Ground distance flown in this leg, metres. */
  distance: number;
  /** Seconds. */
  duration: number;
  /** Speed at the end of the leg, m/s (the start speed is the previous leg's end). */
  endSpeed: number;
  /** Heading change over the leg, degrees (positive = clockwise / right). */
  turn?: number;
  /** Height above ground at the end of the leg, metres (rendered terrain). */
  endHeight?: number;
  /** Camera pitch at the end of the leg, degrees from straight down. */
  endPitch?: number;
  /** Peak bank angle reached mid-leg, degrees (eases in and out). */
  bank?: number;
  /** Shown in the flight readout and timeline. */
  phase?: FlightPhase;
}

export interface FlightScene {
  id: FlightSceneId;
  /** Saved view in the 141 map viewer; the flight starts from exactly this view. */
  viewerUrl: string;
  /** A drone flight out, around and back, or a short cinematic glide. */
  kind: "turnaround" | "glide";
  legs: FlightLeg[];
  /** Never fly lower than this above the terrain (or the terrain just ahead). */
  minClearance: number;
}

export const FLIGHT_SCENES: FlightScene[] = [
  {
    // Lafurak, Savadkuh, Mazandaran — the explorer's 3D Satellite scene.
    id: "lafurak",
    viewerUrl:
      "https://map.141.ir/styles/satellite-terrain/#13.94/36.20563/52.81597/125.2/52",
    kind: "glide",
    minClearance: 180,
    legs: [
      { distance: 1400, duration: 12, endSpeed: 0, turn: -12, endPitch: 58 },
    ],
  },
  {
    // Desert near Jandaq, Isfahan — imagery reaches zoom 16 here, so stay higher.
    id: "jandaq",
    viewerUrl:
      "https://map.141.ir/styles/satellite-terrain/#14.68/33.93604/54.47485/-128/65",
    kind: "turnaround",
    minClearance: 220,
    legs: turnaroundLegs({
      out: 2600,
      height: 650,
      turn: 1000,
      back: 2400,
      backHeight: 720,
      top: 1600,
    }),
  },
  {
    // Forested slopes at Lafurak, Savadkuh — Alborz, Mazandaran.
    id: "savadkuh",
    viewerUrl:
      "https://map.141.ir/styles/satellite-terrain/#13.94/36.20563/52.81597/127.6/63",
    kind: "turnaround",
    minClearance: 240,
    legs: turnaroundLegs({
      out: 3000,
      height: 800,
      turn: 1100,
      back: 2800,
      backHeight: 900,
      top: 2400,
    }),
  },
];

/**
 * Out, 180° turnaround, back, rise: 1.5 s settle, 8 s forward, 5 s turn
 * (peak yaw ≈ 68°/s), 7 s return, 3.5 s rise to an overview — 25 s.
 */
function turnaroundLegs(p: {
  out: number;
  height: number;
  turn: number;
  back: number;
  backHeight: number;
  top: number;
}): FlightLeg[] {
  const cruise = (p.turn / 5) * 0.95;
  return [
    { distance: 150, duration: 1.5, endSpeed: 70, phase: "forward" },
    {
      distance: p.out,
      duration: 8,
      endSpeed: cruise,
      endHeight: p.height,
      endPitch: 64,
      phase: "forward",
    },
    {
      distance: p.turn,
      duration: 5,
      endSpeed: cruise,
      turn: 180,
      endPitch: 60,
      bank: 7,
      phase: "turn",
    },
    {
      distance: p.back,
      duration: 7,
      endSpeed: cruise * 0.6,
      endHeight: p.backHeight,
      endPitch: 64,
      phase: "return",
    },
    {
      distance: p.top * 0.45,
      duration: 3.5,
      endSpeed: 0,
      endHeight: p.top,
      endPitch: 52,
      phase: "overview",
    },
  ];
}

/** Scenes offered in the homepage explorer's 3D Satellite style. */
export const EXPLORER_FLIGHT_SCENES = [
  "lafurak",
] as const satisfies readonly FlightSceneId[];
export type ExplorerFlightId = (typeof EXPLORER_FLIGHT_SCENES)[number];
/** "From desert to jungle" on the satellite page, played in this order. */
export const SATELLITE_PAGE_FLIGHTS = [
  "jandaq",
  "savadkuh",
] as const satisfies readonly FlightSceneId[];
export type SatellitePageFlightId = (typeof SATELLITE_PAGE_FLIGHTS)[number];

export const DEFAULT_FLIGHT_SCENE: ExplorerFlightId = "lafurak";
