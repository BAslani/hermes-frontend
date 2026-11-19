/**
 * Drone defence scenarios: waves of attack drones flying at a site over the
 * real terrain, and the interceptor drone that stops them.
 *
 * The site was read off the 141 satellite imagery and checked with
 * scripts/design-strikes.mts (close-ups in scripts/strikes/), not placed
 * from memory. Wave bearings follow the valleys around it.
 *
 * Kept import-free (types only) so Node can load it directly.
 */
import type { WaveGroup } from "../lib/flight/strike.ts";

type LngLat = [number, number];
type Text = { en: string };

export interface StrikeScenario {
  id: string;
  name: Text;
  brief: Text;
  /** What the drones aim at: its centre, the radius that counts as a hit, and how high above the ground they aim. */
  site: { position: LngLat; radius: number; aim: number; name: Text };
  /** The interceptor starts in a hover here, `height` metres above the ground, facing `heading`. */
  start: { position: LngLat; heading: number; height: number };
  /** Drones appear this far from the site, metres. */
  spawnDistance: number;
  /** Launchers on the ground that wave groups with `launcher` take off from, by index. */
  launchers?: LngLat[];
  /**
   * The F-14's strike on the launchers, flown from the airplane game: where it
   * starts (in level flight, `height` metres above the ground), what it carries,
   * and the hits the site takes with nobody defending it (solo only).
   */
  jet?: {
    start: { position: LngLat; heading: number; height: number };
    missiles: number;
    rounds: number;
    hitsAllowed: number;
  };
  waves: { groups: WaveGroup[] }[];
  hitsAllowed: number;
  /** Hits the interceptor takes from hunters (default 3). */
  playerHits?: number;
  magazine: number;
  /** Gun rounds per wave (default 300). */
  rounds?: number;
  firstBreak: number;
  breakTime: number;
  medals: { gold: number; silver: number; bronze: number };
  look: "day" | "dawn" | "sunset" | "night";
}

export const STRIKES: StrikeScenario[] = [
  {
    id: "karaj-dam",
    name: { en: "Hold the Karaj dam" },
    brief: {
      en: "Three waves of attack drones come down the valleys at the Amir Kabir dam. Twenty-four drones; the dam takes four hits.",
    },
    // The crest of the arch, read off the z16 close-up.
    site: {
      position: [51.0907, 35.9564],
      radius: 150,
      aim: 15,
      name: { en: "Amir Kabir dam" },
    },
    // In the gorge just below the dam, high enough to see over its walls.
    start: { position: [51.0905, 35.9515], heading: 15, height: 500 },
    spawnDistance: 5500,
    // About 20 % harder than the first cut (20 drones at 42–55 m/s): a fifth more drones, a tenth faster.
    waves: [
      // From the north, along the ridges above the reservoir.
      {
        groups: [
          {
            from: 15,
            spread: 8,
            count: 5,
            interval: 6,
            speed: 46,
            cruise: 90,
            weave: 12,
          },
        ],
      },
      // Up the Karaj river valley from the south-west, then over the ridges from the east.
      {
        groups: [
          {
            from: 215,
            spread: 6,
            count: 4,
            interval: 5,
            speed: 50,
            cruise: 80,
            weave: 10,
          },
          {
            from: 70,
            spread: 10,
            count: 3,
            interval: 5,
            delay: 8,
            speed: 50,
            cruise: 110,
            weave: 15,
          },
        ],
      },
      // From three sides at once, faster and lower.
      {
        groups: [
          {
            from: 290,
            spread: 10,
            count: 5,
            interval: 3.5,
            speed: 55,
            cruise: 70,
            weave: 15,
          },
          {
            from: 15,
            spread: 6,
            count: 4,
            interval: 4,
            delay: 6,
            speed: 60,
            cruise: 60,
            weave: 8,
          },
          {
            from: 160,
            spread: 12,
            count: 3,
            interval: 3.5,
            delay: 12,
            speed: 55,
            cruise: 80,
            weave: 20,
          },
        ],
      },
    ],
    hitsAllowed: 4,
    magazine: 14,
    firstBreak: 6,
    breakTime: 10,
    // Most: 2400 for the drones, 1000 for an untouched dam, 500 for accuracy.
    medals: { gold: 3550, silver: 3000, bronze: 2250 },
    look: "day",
  },
  {
    id: "karaj-launchers",
    name: { en: "Karaj dam: launch sites" },
    brief: {
      en: "The drones now take off from four launchers in the valleys around the Amir Kabir dam, the orange beams. Three waves; the dam takes four hits.",
    },
    // The same dam and start as "Hold the Karaj dam".
    site: {
      position: [51.0907, 35.9564],
      radius: 150,
      aim: 15,
      name: { en: "Amir Kabir dam" },
    },
    start: { position: [51.0905, 35.9515], heading: 15, height: 500 },
    spawnDistance: 5500,
    // Read off the z12 overview; every wave flown on the DEM reaches the dam (scripts/design-strikes.mts check karaj-launchers):
    // 0 the reservoir road to the north-east, 1 the orchards to the south-east,
    // 2 the Karaj river road to the south-west, 3 the river valley to the north-west.
    launchers: [
      [51.125, 36.0],
      [51.114, 35.913],
      [51.045, 35.913],
      [51.0226, 35.985],
    ],
    // 12 km south of the dam at 1500 m, heading north up the Karaj valley. One
    // of its missiles (or about fifty rounds) destroys a launcher, and it can
    // lock on to drones too: eight missiles and the M61's 675 rounds. Alone,
    // nobody else stops the drones already up, so the dam takes twelve hits
    // instead of four.
    jet: {
      start: { position: [51.0907, 35.8483], heading: 0, height: 1500 },
      missiles: 8,
      rounds: 675,
      hitsAllowed: 12,
    },
    waves: [
      {
        groups: [
          {
            launcher: 0,
            from: 36,
            spread: 0,
            count: 5,
            interval: 6,
            speed: 46,
            cruise: 90,
            weave: 12,
          },
        ],
      },
      {
        groups: [
          {
            launcher: 2,
            from: 220,
            spread: 0,
            count: 4,
            interval: 5,
            speed: 50,
            cruise: 80,
            weave: 10,
          },
          {
            launcher: 1,
            from: 156,
            spread: 0,
            count: 3,
            interval: 5,
            delay: 8,
            speed: 50,
            cruise: 110,
            weave: 15,
          },
        ],
      },
      {
        groups: [
          {
            launcher: 3,
            from: 297,
            spread: 0,
            count: 5,
            interval: 3.5,
            speed: 55,
            cruise: 70,
            weave: 15,
          },
          {
            launcher: 0,
            from: 36,
            spread: 0,
            count: 4,
            interval: 4,
            delay: 6,
            speed: 60,
            cruise: 80,
            weave: 8,
          },
          {
            launcher: 1,
            from: 156,
            spread: 0,
            count: 3,
            interval: 3.5,
            delay: 12,
            speed: 55,
            cruise: 80,
            weave: 20,
          },
        ],
      },
    ],
    hitsAllowed: 4,
    magazine: 14,
    firstBreak: 6,
    breakTime: 10,
    medals: { gold: 3550, silver: 3000, bronze: 2250 },
    look: "day",
  },
  {
    id: "milad-tower",
    name: { en: "Milad Tower at sunset" },
    brief: {
      en: "Drones come in over Tehran from every side: swarms, jets, low fliers in the streets, decoys, and hunters that go for you. Twenty-four real drones.",
    },
    // The tower's foot, read off the z16 close-up (scripts/strikes/milad-z16.png).
    site: {
      position: [51.3749, 35.7448],
      radius: 120,
      aim: 20,
      name: { en: "Milad Tower" },
    },
    // South of the tower over the city, facing it.
    start: { position: [51.376, 35.734], heading: 350, height: 350 },
    spawnDistance: 6000,
    waves: [
      // From the west over the city, and low fliers up from the south-west.
      {
        groups: [
          {
            from: 270,
            spread: 10,
            count: 4,
            interval: 5,
            speed: 48,
            cruise: 90,
            weave: 12,
          },
          {
            from: 200,
            spread: 8,
            count: 2,
            interval: 6,
            delay: 6,
            speed: 38,
            cruise: 35,
            weave: 6,
            kind: "low",
          },
        ],
      },
      // A swarm from the north-west, jets from the south, decoys mixed in.
      {
        groups: [
          {
            from: 300,
            spread: 6,
            count: 4,
            interval: 0,
            speed: 50,
            cruise: 100,
            weave: 10,
            formation: 22,
          },
          {
            from: 180,
            spread: 10,
            count: 2,
            interval: 8,
            delay: 10,
            speed: 110,
            cruise: 150,
            weave: 0,
            kind: "jet",
          },
          {
            from: 240,
            spread: 12,
            count: 3,
            interval: 4,
            delay: 4,
            speed: 48,
            cruise: 90,
            weave: 12,
            kind: "decoy",
          },
        ],
      },
      // Everything at once: hunters down off the mountains first.
      {
        groups: [
          {
            from: 0,
            spread: 15,
            count: 2,
            interval: 6,
            speed: 62,
            cruise: 120,
            weave: 0,
            kind: "hunter",
          },
          {
            from: 250,
            spread: 6,
            count: 5,
            interval: 0,
            delay: 8,
            speed: 52,
            cruise: 90,
            weave: 10,
            formation: 20,
          },
          {
            from: 150,
            spread: 10,
            count: 3,
            interval: 4,
            delay: 14,
            speed: 40,
            cruise: 30,
            weave: 6,
            kind: "low",
          },
          {
            from: 90,
            spread: 10,
            count: 2,
            interval: 6,
            delay: 20,
            speed: 120,
            cruise: 150,
            weave: 0,
            kind: "jet",
          },
          {
            from: 320,
            spread: 12,
            count: 3,
            interval: 3,
            delay: 10,
            speed: 50,
            cruise: 90,
            weave: 12,
            kind: "decoy",
          },
        ],
      },
    ],
    hitsAllowed: 4,
    playerHits: 3,
    magazine: 14,
    firstBreak: 6,
    breakTime: 10,
    // Most: 2800 for the drones, 1000 for the tower untouched, 500 for accuracy (4300).
    medals: { gold: 3910, silver: 3310, bronze: 2490 },
    look: "sunset",
  },
  {
    id: "rajaee-port",
    name: { en: "Shield Shahid Rajaee port" },
    brief: {
      en: "At dawn over Bandar Abbas: sea-skimming jets and swarms come in off the Gulf, hunters from the hills behind. Thirty real drones; the hardest.",
    },
    // The container pier, read off the z15 close-up (scripts/strikes/port-z15.png).
    site: {
      position: [56.0548, 27.0984],
      radius: 220,
      aim: 15,
      name: { en: "the container pier" },
    },
    // Inland of the pier, looking out to sea.
    start: { position: [56.0548, 27.108], heading: 180, height: 250 },
    spawnDistance: 6500,
    waves: [
      // Low over the water from the south, attack drones from the hills.
      {
        groups: [
          {
            from: 190,
            spread: 10,
            count: 4,
            interval: 5,
            speed: 45,
            cruise: 25,
            weave: 8,
            kind: "low",
          },
          {
            from: 330,
            spread: 10,
            count: 3,
            interval: 6,
            delay: 8,
            speed: 48,
            cruise: 80,
            weave: 12,
          },
        ],
      },
      // Sea-skimming jets, a swarm, decoys, and the first hunter from inland.
      {
        groups: [
          {
            from: 160,
            spread: 8,
            count: 3,
            interval: 6,
            speed: 120,
            cruise: 40,
            weave: 0,
            kind: "jet",
          },
          {
            from: 220,
            spread: 6,
            count: 4,
            interval: 0,
            delay: 6,
            speed: 50,
            cruise: 60,
            weave: 10,
            formation: 22,
          },
          {
            from: 200,
            spread: 15,
            count: 4,
            interval: 3,
            delay: 3,
            speed: 46,
            cruise: 60,
            weave: 12,
            kind: "decoy",
          },
          {
            from: 20,
            spread: 10,
            count: 1,
            interval: 0,
            delay: 12,
            speed: 62,
            cruise: 100,
            weave: 0,
            kind: "hunter",
          },
        ],
      },
      // The big push off the Gulf, with hunters behind you.
      {
        groups: [
          {
            from: 180,
            spread: 6,
            count: 6,
            interval: 0,
            speed: 52,
            cruise: 40,
            weave: 8,
            formation: 18,
          },
          {
            from: 230,
            spread: 8,
            count: 3,
            interval: 5,
            delay: 10,
            speed: 125,
            cruise: 40,
            weave: 0,
            kind: "jet",
          },
          {
            from: 140,
            spread: 10,
            count: 4,
            interval: 4,
            delay: 5,
            speed: 42,
            cruise: 22,
            weave: 6,
            kind: "low",
          },
          {
            from: 340,
            spread: 12,
            count: 2,
            interval: 5,
            delay: 15,
            speed: 64,
            cruise: 100,
            weave: 0,
            kind: "hunter",
          },
          {
            from: 250,
            spread: 12,
            count: 3,
            interval: 3,
            delay: 8,
            speed: 48,
            cruise: 50,
            weave: 12,
            kind: "decoy",
          },
        ],
      },
    ],
    hitsAllowed: 4,
    playerHits: 3,
    magazine: 16,
    firstBreak: 6,
    breakTime: 10,
    // Most: 3610 for the drones, 1000 for the pier untouched, 500 for accuracy (5110).
    medals: { gold: 4650, silver: 3930, bronze: 2960 },
    look: "dawn",
  },
  {
    id: "mehrabad-night",
    name: { en: "Mehrabad by night" },
    brief: {
      en: "A night raid on the airport's terminals. In the dark, only their blinking lights give the drones away: switch the camera to thermal (V) and they glow. Twenty-eight real drones.",
    },
    // The apron in front of terminals 1 and 2, read off the z15 close-up (scripts/strikes/mehrabad-z15.png).
    // The south side of the field is an air base: kept clear of it.
    site: {
      position: [51.3166, 35.6914],
      radius: 180,
      aim: 15,
      name: { en: "the terminals" },
    },
    // Over the runway, west of the terminals, looking along it.
    start: { position: [51.305, 35.6895], heading: 75, height: 300 },
    spawnDistance: 6000,
    waves: [
      {
        groups: [
          {
            from: 250,
            spread: 10,
            count: 5,
            interval: 5,
            speed: 48,
            cruise: 80,
            weave: 12,
          },
          {
            from: 160,
            spread: 8,
            count: 3,
            interval: 6,
            delay: 6,
            speed: 40,
            cruise: 30,
            weave: 6,
            kind: "low",
          },
        ],
      },
      {
        groups: [
          {
            from: 290,
            spread: 6,
            count: 4,
            interval: 0,
            speed: 50,
            cruise: 90,
            weave: 10,
            formation: 22,
          },
          {
            from: 20,
            spread: 12,
            count: 2,
            interval: 8,
            delay: 6,
            speed: 62,
            cruise: 110,
            weave: 0,
            kind: "hunter",
          },
          {
            from: 220,
            spread: 12,
            count: 3,
            interval: 4,
            delay: 3,
            speed: 48,
            cruise: 80,
            weave: 12,
            kind: "decoy",
          },
          {
            from: 120,
            spread: 10,
            count: 2,
            interval: 8,
            delay: 14,
            speed: 115,
            cruise: 120,
            weave: 0,
            kind: "jet",
          },
        ],
      },
      {
        groups: [
          {
            from: 200,
            spread: 6,
            count: 4,
            interval: 0,
            speed: 52,
            cruise: 70,
            weave: 10,
            formation: 20,
          },
          {
            from: 90,
            spread: 10,
            count: 4,
            interval: 4,
            delay: 6,
            speed: 40,
            cruise: 28,
            weave: 6,
            kind: "low",
          },
          {
            from: 330,
            spread: 12,
            count: 2,
            interval: 6,
            delay: 10,
            speed: 62,
            cruise: 110,
            weave: 0,
            kind: "hunter",
          },
          {
            from: 260,
            spread: 8,
            count: 2,
            interval: 5,
            delay: 16,
            speed: 120,
            cruise: 120,
            weave: 0,
            kind: "jet",
          },
          {
            from: 160,
            spread: 12,
            count: 3,
            interval: 3,
            delay: 8,
            speed: 48,
            cruise: 70,
            weave: 12,
            kind: "decoy",
          },
        ],
      },
    ],
    hitsAllowed: 4,
    playerHits: 3,
    magazine: 14,
    rounds: 300,
    firstBreak: 6,
    breakTime: 10,
    // Most: 3340 for the drones, 1000 for the terminals untouched, 500 for accuracy (4840).
    medals: { gold: 4400, silver: 3730, bronze: 2810 },
    look: "night",
  },
];
