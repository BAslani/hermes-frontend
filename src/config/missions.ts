/**
 * Helicopter rescue and delivery missions in the Alborz above Tehran.
 *
 * Every site was found by scripts/design-missions.mts on the 141 DEM
 * (landing zones: the flattest disc near a guide point; the hoist spot: steep
 * ground with clear air above it) and checked on a satellite close-up
 * (scripts/missions/<site>.png), not placed from memory. The DEM has no
 * buildings, so pads in the city were moved onto open ground by eye.
 *
 * Kept import-free (types only) so Node can load it directly.
 */

type LngLat = [number, number];
type Text = { en: string };

export interface MissionSiteSpec {
  kind: "land" | "hoist";
  role:
    | "load-cargo"
    | "drop-cargo"
    | "pick-patient"
    | "drop-patient"
    | "return";
  position: LngLat;
  /** Metres: landing zone radius, or how far off the spot the hoist may hover. */
  radius: number;
  /** Seconds on the ground, or of winching. */
  hold: number;
  name: Text;
}

export interface MissionConfig {
  id: string;
  name: Text;
  brief: Text;
  /** Where it starts, on the ground. */
  base: { position: LngLat; heading: number; name: Text; radius: number };
  steps: MissionSiteSpec[];
  /** kg of fuel at the start. */
  fuel: number;
  /** A good time, seconds. */
  par: number;
  /** Seconds by which the patient should be on board. */
  patientDeadline?: number;
  startsWithCargo?: boolean;
  /** Score for each medal. */
  medals: { gold: number; silver: number; bronze: number };
  /** A storm building while it is flown (see src/lib/flight/weather.ts). */
  storm?: {
    startWind: number;
    fullWind: number;
    from: number;
    veer: number;
    buildUp: number;
    gustiness: number;
    seed: number;
  };
  /**
   * An avalanche that breaks above one step's site once the work there
   * starts: released `above` metres up the fall line, `width` wide, `delay`
   * seconds after the hoist or landing begins.
   */
  avalanche?: { step: number; above: number; width: number; delay: number };
  /**
   * Built at run time from the map: a village picked from the basemap's
   * `place` layer near the base, a landing zone found beside it on the
   * terrain. `steps` here are empty.
   */
  generated?: boolean;
}

/** North-west Tehran: a sports ground on the hillside campus off Ferdows road (scripts/missions/base.png). */
const BASE = {
  position: [51.3071, 35.79442] as LngLat,
  name: { en: "141 rescue base" },
  radius: 30,
};
/** North-east Tehran: the vacant lot north of Lavasani Boulevard (scripts/missions/east-hospital.png). */
const EAST_PAD = {
  position: [51.46743, 35.80064] as LngLat,
  name: { en: "north-east hospital pad" },
  radius: 25,
};

export const MISSIONS: MissionConfig[] = [
  {
    id: "hikers-camp",
    name: { en: "Supplies for stranded hikers" },
    brief: {
      en: "A group of hikers is cut off on a ridge track at 3,200 m. Fly up the supplies and set them down on the only flat patch.",
    },
    base: { ...BASE, heading: 346 },
    startsWithCargo: true,
    steps: [
      {
        kind: "land",
        role: "drop-cargo",
        // Flattest disc near the track: 3.3° slope (scripts/missions/kan-village.png).
        position: [51.26111, 35.9414],
        radius: 22,
        hold: 6,
        name: { en: "the hikers' camp" },
      },
    ],
    fuel: 160,
    par: 380,
    medals: { gold: 1450, silver: 1300, bronze: 1150 },
  },
  {
    id: "tochal-climber",
    name: { en: "Climber below Tochal" },
    brief: {
      en: "A climber is hurt on a 35° slope near Station 7, just below the summit. There is nowhere to land: hover low and steady and winch them up, then fly them to base.",
    },
    base: { ...BASE, heading: 45 },
    steps: [
      {
        kind: "hoist",
        role: "pick-patient",
        // Steep, clear above, 385 m below the 3,912 m summit (scripts/missions/tochal-climber.png).
        position: [51.41499, 35.88185],
        radius: 12,
        hold: 12,
        name: { en: "the climber" },
      },
      {
        kind: "land",
        role: "drop-patient",
        position: BASE.position,
        radius: BASE.radius,
        hold: 4,
        name: BASE.name,
      },
    ],
    fuel: 220,
    par: 600,
    patientDeadline: 330,
    medals: { gold: 1450, silver: 1300, bronze: 1150 },
  },
  {
    id: "fasham-accident",
    name: { en: "Accident on the Fasham road" },
    brief: {
      en: "A car has gone off the Tehran–Fasham road in the valley. Land beside the road, take the injured driver aboard and fly them to the hospital pad.",
    },
    base: { ...EAST_PAD, heading: 23 },
    steps: [
      {
        kind: "land",
        role: "pick-patient",
        // Beside the road and river: 1.1° slope (scripts/missions/shemshak-road.png).
        position: [51.52922, 35.91635],
        radius: 18,
        hold: 8,
        name: { en: "the crash site" },
      },
      {
        kind: "land",
        role: "drop-patient",
        position: EAST_PAD.position,
        radius: EAST_PAD.radius,
        hold: 4,
        name: EAST_PAD.name,
      },
    ],
    fuel: 200,
    par: 600,
    patientDeadline: 300,
    medals: { gold: 1450, silver: 1300, bronze: 1150 },
  },
];

MISSIONS.push(
  {
    id: "tochal-avalanche",
    name: { en: "Avalanche below Tochal" },
    brief: {
      en: "A storm is building over the climber on the slope by Station 7. The snow above is loaded: the moment you start winching, it lets go. Winch fast, then get clear.",
    },
    base: { ...BASE, heading: 45 },
    steps: [
      {
        kind: "hoist",
        role: "pick-patient",
        // The same spot as the climber mission (scripts/missions/tochal-climber.png).
        position: [51.41499, 35.88185],
        radius: 12,
        hold: 12,
        name: { en: "the climber" },
      },
      {
        kind: "land",
        role: "drop-patient",
        position: BASE.position,
        radius: BASE.radius,
        hold: 4,
        name: BASE.name,
      },
    ],
    fuel: 220,
    par: 620,
    patientDeadline: 360,
    medals: { gold: 1450, silver: 1300, bronze: 1150 },
    storm: {
      startWind: 3,
      fullWind: 15,
      from: 290,
      veer: 35,
      buildUp: 300,
      gustiness: 0.35,
      seed: 41,
    },
    avalanche: { step: 0, above: 320, width: 140, delay: 4 },
  },
  {
    id: "village-callout",
    name: { en: "Village call-out" },
    brief: {
      en: "A new call each time: a real village from the 141 map near the base, supplies or a patient, sometimes in a storm. The landing zone is found on the terrain beside it.",
    },
    base: { ...BASE, heading: 0 },
    steps: [],
    fuel: 240,
    par: 600,
    medals: { gold: 1450, silver: 1300, bronze: 1150 },
    generated: true,
  },
);

/** Bounding box of a mission's base and sites: [west, south, east, north]. */
export function missionBounds(
  mission: MissionConfig,
): [number, number, number, number] {
  const points = [
    mission.base.position,
    ...mission.steps.map((s) => s.position),
  ];
  const lngs = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return [
    Math.min(...lngs),
    Math.min(...lats),
    Math.max(...lngs),
    Math.max(...lats),
  ];
}
