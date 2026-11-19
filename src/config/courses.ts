/**
 * Air-race courses for the playground's airplane.
 *
 * Every gate was placed by looking at it in the playground itself (the
 * satellite imagery and terrain at that spot), not from memory. Heights are
 * real metres above the ground under the gate; the simulator turns them into
 * altitudes once the elevation tiles there have loaded.
 *
 * Kept import-free (types only) so Node can load it directly.
 */

export interface CourseGate {
  /** Ring centre: [lng, lat]. */
  position: [number, number];
  /** Real metres above the ground. */
  height: number;
  /** The direction to fly through it, degrees from north. */
  heading: number;
  /** Metres, to the inside of the ring. */
  radius: number;
}

export interface Course {
  id: string;
  name: { en: string };
  description: { en: string };
  /** Airborne start, in trimmed level flight. */
  start: {
    position: [number, number];
    /** Real metres above the ground. */
    height: number;
    heading: number;
    /** True airspeed, m/s. */
    speed: number;
  };
  gates: CourseGate[];
  /** Total seconds (penalties included) for each medal, in the race plane. */
  medals: { gold: number; silver: number; bronze: number };
  /** The light the course is flown in. */
  look: "day" | "dawn" | "sunset";
}

export const COURSES: Course[] = [
  {
    id: "lut-kaluts",
    name: { en: "Kalut Slalom" },
    description: {
      en: "A low, fast slalom between the wind-carved ridges of the Lut desert near Shahdad.",
    },
    start: {
      position: [57.97928, 30.50486],
      height: 60,
      heading: 340,
      speed: 75,
    },
    gates: [
      { position: [57.97179, 30.52261], height: 60, heading: 344, radius: 30 },
      { position: [57.96995, 30.53064], height: 45, heading: 336, radius: 30 },
      { position: [57.96399, 30.53739], height: 40, heading: 341, radius: 30 },
      { position: [57.96372, 30.54592], height: 50, heading: 341, radius: 30 },
      { position: [57.95776, 30.55266], height: 40, heading: 340, radius: 30 },
      { position: [57.95719, 30.5611], height: 45, heading: 339, radius: 30 },
      { position: [57.95094, 30.56775], height: 40, heading: 338, radius: 30 },
      { position: [57.95027, 30.57615], height: 50, heading: 345, radius: 30 },
      { position: [57.94608, 30.58345], height: 60, heading: 337, radius: 30 },
      { position: [57.94287, 30.59106], height: 70, heading: 340, radius: 30 },
    ],
    medals: { gold: 119, silver: 131, bronze: 149 },
    look: "sunset",
  },
  {
    // Designed by scripts/design-courses.mts: every gate on the cone at the
    // same altitude (4,370 m), 240 m off the slope; see scripts/courses/damavand.png.
    id: "damavand",
    name: { en: "Damavand Circuit" },
    description: {
      en: "A dawn lap round Iran's highest peak, every gate hugging the volcano's cone at 4,370 m.",
    },
    start: {
      position: [52.08715, 35.92368],
      height: 788,
      heading: 70,
      speed: 70,
    },
    gates: [
      { position: [52.11011, 35.93045], height: 185, heading: 72, radius: 32 },
      { position: [52.128, 35.93462], height: 171, heading: 55, radius: 32 },
      { position: [52.13906, 35.94694], height: 195, heading: 10, radius: 32 },
      { position: [52.13399, 35.96083], height: 151, heading: 335, radius: 32 },
      { position: [52.12513, 35.97128], height: 191, heading: 305, radius: 32 },
      { position: [52.11011, 35.97452], height: 238, heading: 271, radius: 32 },
      { position: [52.09457, 35.97187], height: 177, heading: 240, radius: 32 },
      { position: [52.08243, 35.96183], height: 136, heading: 203, radius: 32 },
      { position: [52.08137, 35.94699], height: 145, heading: 163, radius: 32 },
      { position: [52.09248, 35.93491], height: 171, heading: 143, radius: 32 },
    ],
    medals: { gold: 209, silver: 230, bronze: 261 },
    look: "dawn",
  },
  {
    // Designed by scripts/design-courses.mts: the Karaj river gorge that the
    // Karaj–Chalus road follows, east from above the Amir Kabir reservoir and
    // north up the valley; each gate 70 m over the floor with at least 120 m
    // to the walls. The start is on the gorge floor facing straight down the
    // reach to gate 1 (at least 50 m clear on the way); an earlier start
    // further west faced a cliff. See scripts/courses/chalus.png.
    id: "chalus",
    name: { en: "Chalus Gorge" },
    description: {
      en: "Thread the Karaj river gorge along the Chalus road, 70 m off the water, walls on both wingtips.",
    },
    start: {
      position: [51.19318, 36.03577],
      height: 70,
      heading: 111,
      speed: 65,
    },
    gates: [
      { position: [51.20698, 36.03154], height: 70, heading: 103, radius: 30 },
      { position: [51.22167, 36.03047], height: 70, heading: 96, radius: 30 },
      { position: [51.23537, 36.02893], height: 70, heading: 106, radius: 30 },
      { position: [51.24877, 36.02423], height: 70, heading: 107, radius: 30 },
      { position: [51.262, 36.02242], height: 70, heading: 108, radius: 30 },
      { position: [51.27511, 36.01746], height: 70, heading: 112, radius: 30 },
      { position: [51.28907, 36.0137], height: 70, heading: 80, radius: 30 },
      { position: [51.30102, 36.02111], height: 70, heading: 41, radius: 30 },
      { position: [51.30464, 36.02814], height: 70, heading: 21, radius: 30 },
      { position: [51.31027, 36.04038], height: 70, heading: 16, radius: 30 },
      { position: [51.31347, 36.05252], height: 70, heading: 357, radius: 30 },
      { position: [51.3086, 36.06344], height: 70, heading: 354, radius: 30 },
      { position: [51.31078, 36.07463], height: 70, heading: 14, radius: 30 },
      { position: [51.31542, 36.08571], height: 70, heading: 19, radius: 30 },
    ],
    medals: { gold: 249, silver: 274, bronze: 311 },
    look: "day",
  },
];

/** The bounding box of a course (start and gates): [west, south, east, north]. */
export function courseBounds(course: Course): [number, number, number, number] {
  const points = [
    course.start.position,
    ...course.gates.map((g) => g.position),
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
