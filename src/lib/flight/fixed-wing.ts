/**
 * Aerodynamics and engine of a four-seat, high-wing, single-engine trainer
 * with Cessna 172-class numbers.
 *
 * The stability and control derivatives are the published cruise-condition
 * values for that class (Roskam, "Airplane Flight Dynamics and Automatic
 * Flight Controls", Airplane A; the same figures JSBSim's public c172 model is
 * built around). Lift blends from the linear range into flat-plate behaviour
 * past the critical angle (Beard & McLain, "Small Unmanned Aircraft"), which
 * gives a stall that breaks rather than a lift curve that climbs forever.
 *
 * Aerodynamic textbooks use a forward-right-down body frame; the rest of the
 * flight code uses forward-left-up. This file converts at its edges.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import { SEA_LEVEL_DENSITY } from "./atmosphere.ts";
import { clamp, RAD, type Vec3 } from "./vec.ts";

export const KNOT = 0.514444;
export const FOOT = 0.3048;

export const TRAINER = {
  /** kg: 2,300 lb, the normal-category gross weight of the class. */
  mass: 1043,
  /** Roll, pitch, yaw moments of inertia, kg·m². */
  inertia: [1285, 1825, 2667] as Vec3,
  wingArea: 16.17,
  span: 10.91,
  chord: 1.494,
  /** Span efficiency, with aspect ratio 7.32 → induced drag factor 0.058. */
  inducedDrag: 1 / (Math.PI * 0.75 * 7.32),

  // Lift
  CL0: 0.31,
  CLalpha: 5.143,
  CLq: 3.9,
  CLelevator: 0.43,
  /**
   * Angle of attack at which half the wing's flow has separated, clean,
   * radians. Lift peaks about 2.7° before it: CLmax 1.64 at 15.8°, which puts
   * the clean stall at 49 kt and the full-flap stall at 42 kt at gross weight.
   */
  stallAlpha: 18.5 * RAD,
  /** How abruptly lift breaks at the stall. */
  stallSharpness: 60,
  /** Full flaps add this much lift coefficient and stall this much earlier. */
  flapLift: 0.75,
  flapStallAlpha: -2 * RAD,

  // Drag
  CD0: 0.031,
  flapDrag: 0.055,

  // Pitching moment
  Cm0: -0.015,
  CmAlpha: -0.89,
  Cmq: -12.4,
  CmElevator: -1.28,
  /** Flaps pitch the nose down a little. */
  CmFlap: -0.04,

  // Side force
  CYbeta: -0.31,
  CYrudder: 0.187,

  // Rolling moment
  ClBeta: -0.089,
  Clp: -0.47,
  Clr: 0.096,
  ClAileron: 0.178,
  ClRudder: 0.0147,

  // Yawing moment
  CnBeta: 0.065,
  Cnp: -0.03,
  Cnr: -0.099,
  CnAileron: -0.053,
  CnRudder: -0.0657,

  /** Full deflections, radians. */
  elevatorMax: 25 * RAD,
  aileronMax: 17.5 * RAD,
  rudderMax: 16 * RAD,
  /** Trim moves the elevator's neutral point by up to this fraction of full travel. */
  trimAuthority: 0.5,
  /** Flap settings, degrees. */
  flapSteps: [0, 10, 20, 30],
  /** Degrees per second the flaps travel. */
  flapRate: 8,

  // Engine and fixed-pitch propeller
  /** Rated power, W (160 hp). */
  power: 119_300,
  idleRpm: 650,
  /** Full-throttle rpm standing still and at speed. */
  staticRpm: 2300,
  maxRpm: 2700,
  /** Airspeed at which full throttle reaches maxRpm, m/s. */
  rpmSpeed: 60,
  /** Peak propeller efficiency, and the speed scale it builds up over, m/s. */
  propEfficiency: 0.76,
  propSpeed: 22,
  /** Thrust standing still at full power and sea level, N. */
  staticThrust: 2300,
  /** Seconds for the engine to follow the throttle. */
  spoolTime: 0.6,
  /** Propeller disc area, m² (1.9 m diameter), for the slipstream over the tail. */
  propDisc: 2.84,
  /** Share of the slipstream's extra dynamic pressure the tail surfaces feel. */
  slipstream: 0.3,
} as const;

/** Any airframe's numbers: the trainer's shape, with plain numbers instead of its literal values. */
export type FixedWingParams = {
  -readonly [K in keyof typeof TRAINER]: (typeof TRAINER)[K] extends number
    ? number
    : (typeof TRAINER)[K] extends Vec3
      ? Vec3
      : (typeof TRAINER)[K] extends readonly number[]
        ? readonly number[]
        : (typeof TRAINER)[K];
};

/**
 * A single-seat aerobatic racer with Extra 330-class numbers: 315 hp, 750 kg
 * at race weight, a symmetric-section wing of 10 m² and 8 m span, no flaps.
 * Stall near 59 kt, about 200 kt flat out at sea level, roll rate over
 * 300°/s. The derivatives follow the trainer's scaled to the shape (lower
 * aspect ratio, little dihedral, small adverse yaw, lighter pitch stability),
 * from the published figures for unlimited-category aerobatic monoplanes.
 */
export const RACER: FixedWingParams = {
  mass: 750,
  inertia: [520, 950, 1380],
  wingArea: 10,
  span: 8,
  chord: 1.25,
  /** Aspect ratio 6.4, span efficiency 0.8. */
  inducedDrag: 1 / (Math.PI * 0.8 * 6.4),

  // Symmetric section: no lift at zero angle of attack.
  CL0: 0,
  CLalpha: 4.6,
  CLq: 3.6,
  CLelevator: 0.45,
  stallAlpha: 18 * RAD,
  stallSharpness: 50,
  flapLift: 0,
  flapStallAlpha: 0,

  CD0: 0.024,
  flapDrag: 0,

  Cm0: 0,
  CmAlpha: -0.5,
  Cmq: -11,
  CmElevator: -1.35,
  CmFlap: 0,

  CYbeta: -0.4,
  CYrudder: 0.21,

  ClBeta: -0.03,
  Clp: -0.45,
  Clr: 0.06,
  ClAileron: 0.33,
  ClRudder: 0.012,

  CnBeta: 0.075,
  Cnp: -0.02,
  Cnr: -0.11,
  CnAileron: -0.012,
  CnRudder: -0.08,

  elevatorMax: 28 * RAD,
  aileronMax: 25 * RAD,
  rudderMax: 28 * RAD,
  trimAuthority: 0.4,
  flapSteps: [0],
  flapRate: 8,

  /** 315 hp. A constant-speed propeller holds rpm, so rpm hardly sags at low speed. */
  power: 235_000,
  idleRpm: 800,
  staticRpm: 2550,
  maxRpm: 2700,
  rpmSpeed: 40,
  propEfficiency: 0.82,
  propSpeed: 24,
  staticThrust: 4600,
  spoolTime: 0.35,
  /** 2 m propeller. */
  propDisc: 3.14,
  slipstream: 0.35,
};

/**
 * A twin-engine carrier fighter with F-14A-class numbers, wings spread: 22 t
 * (light, part fuel), 52.5 m² of wing, 19.5 m span, two turbofans giving up
 * to 130 kN together. Clean stall near 125 kt, about 105 kt with full flaps.
 * Rough playground numbers scaled from the fighter class, not a validated
 * model: no wing sweep, no compressibility (it will go faster than Mach 1
 * at low level, which the real aircraft would not).
 *
 * The engine reuses the propeller code with the power limit lifted, so
 * thrust follows the spool (“rpm” is engine speed in %): idle 65 %, full
 * 100 %, a 2.5 s spool lag.
 */
export const JET: FixedWingParams = {
  mass: 22_000,
  inertia: [80_000, 300_000, 370_000],
  wingArea: 52.5,
  span: 19.5,
  chord: 3.0,
  /** Aspect ratio 7.2, span efficiency 0.8. */
  inducedDrag: 1 / (Math.PI * 0.8 * 7.2),

  CL0: 0.1,
  CLalpha: 4.5,
  CLq: 4,
  CLelevator: 0.4,
  stallAlpha: 22 * RAD,
  stallSharpness: 30,
  flapLift: 0.9,
  flapStallAlpha: -2 * RAD,

  CD0: 0.024,
  flapDrag: 0.06,

  // Trims hands-off near 270 kt clean; the stabilator is big enough to rotate at about 145 kt.
  Cm0: 0.02,
  CmAlpha: -0.4,
  Cmq: -8,
  CmElevator: -1.6,
  CmFlap: -0.03,

  CYbeta: -0.9,
  CYrudder: 0.15,

  ClBeta: -0.08,
  Clp: -0.35,
  Clr: 0.1,
  ClAileron: 0.16,
  ClRudder: 0.01,

  CnBeta: 0.12,
  Cnp: -0.02,
  Cnr: -0.25,
  CnAileron: 0,
  CnRudder: -0.06,

  elevatorMax: 30 * RAD,
  aileronMax: 20 * RAD,
  rudderMax: 30 * RAD,
  trimAuthority: 0.5,
  flapSteps: [0, 15, 30],
  flapRate: 10,

  // Turbofans: thrust follows the spool, not shaft power.
  power: 1e12,
  idleRpm: 65,
  staticRpm: 100,
  maxRpm: 100,
  rpmSpeed: 1,
  propEfficiency: 1,
  propSpeed: 1,
  staticThrust: 130_000,
  spoolTime: 2.5,
  propDisc: 1,
  slipstream: 0,
};

/** Separation blend: 0 in attached flow, 1 fully stalled. */
function separation(alpha: number, stallAlpha: number, sharpness: number) {
  const a = Math.exp(-sharpness * (alpha - stallAlpha));
  const b = Math.exp(sharpness * (alpha + stallAlpha));
  return (1 + a + b) / ((1 + a) * (1 + b));
}

/**
 * Lift coefficient of the wing alone (no pitch rate or elevator) and the
 * separation blend, for an angle of attack in radians and flaps in degrees.
 */
export function wingLift(
  alpha: number,
  flapDeg: number,
  p: FixedWingParams = TRAINER,
) {
  const flap = clamp(flapDeg / 30, 0, 1);
  const stalled = separation(
    alpha,
    p.stallAlpha + flap * p.flapStallAlpha,
    p.stallSharpness,
  );
  const attached = p.CL0 + flap * p.flapLift + p.CLalpha * alpha;
  const plate = 2 * Math.sign(alpha) * Math.sin(alpha) ** 2 * Math.cos(alpha);
  return { cl: (1 - stalled) * attached + stalled * plate, attached, stalled };
}

/** Highest lift coefficient and the angle of attack it occurs at. */
export function maxLift(flapDeg: number, p: FixedWingParams = TRAINER) {
  let best = { cl: -Infinity, alpha: 0 };
  for (let a = 0; a <= 25 * RAD; a += 0.05 * RAD) {
    const { cl } = wingLift(a, flapDeg, p);
    if (cl > best.cl) best = { cl, alpha: a };
  }
  return best;
}

/** Power-off stall speed in level flight at a given air density, m/s. */
export function stallSpeed(
  flapDeg: number,
  density = SEA_LEVEL_DENSITY,
  p: FixedWingParams = TRAINER,
) {
  return Math.sqrt(
    (2 * p.mass * 9.80665) / (density * p.wingArea * maxLift(flapDeg, p).cl),
  );
}

/* ------------------------------------------------------------------------ */
/* Engine and propeller                                                      */
/* ------------------------------------------------------------------------ */

/** Full-throttle rpm at an airspeed: a fixed-pitch propeller unloads as it speeds up. */
const fullRpm = (airspeed: number, p: FixedWingParams) =>
  p.staticRpm + (p.maxRpm - p.staticRpm) * clamp(airspeed / p.rpmSpeed, 0, 1);

/** The rpm the engine settles at for a throttle setting (0–1). */
export function targetRpm(
  throttle: number,
  airspeed: number,
  p: FixedWingParams = TRAINER,
) {
  return p.idleRpm + (fullRpm(airspeed, p) - p.idleRpm) * clamp(throttle, 0, 1);
}

/**
 * Thrust in newtons. Shaft power falls with air density (Gagg and Farrar),
 * the propeller turns it into thrust with an efficiency that builds with
 * airspeed, and the static-thrust limit caps it at low speed.
 */
export function thrust(
  rpm: number,
  airspeed: number,
  density: number,
  p: FixedWingParams = TRAINER,
) {
  const setting = clamp(
    (rpm - p.idleRpm) / (fullRpm(airspeed, p) - p.idleRpm),
    0,
    1,
  );
  const sigma = density / SEA_LEVEL_DENSITY;
  const altitudeFactor = clamp((sigma - 0.12) / 0.88, 0, 1.1);
  const v = Math.max(airspeed, 0);
  const efficiency = p.propEfficiency * (1 - Math.exp(-v / p.propSpeed));
  const fromPower =
    v > 0.5 ? (efficiency * p.power * setting * altitudeFactor) / v : Infinity;
  return Math.min(p.staticThrust * setting * altitudeFactor, fromPower);
}

/* ------------------------------------------------------------------------ */
/* Aerodynamic forces and moments                                            */
/* ------------------------------------------------------------------------ */

export interface Surfaces {
  /** −1…1, positive = nose up (stick back). Trim is added by the caller. */
  elevator: number;
  /** −1…1, positive = roll right. */
  aileron: number;
  /** −1…1, positive = nose right. */
  rudder: number;
  /** Degrees. */
  flaps: number;
}

export interface AeroResult {
  /** Body frame (forward, left, up), N. */
  force: Vec3;
  /** Body frame, N·m. */
  torque: Vec3;
  /** Radians. */
  alpha: number;
  beta: number;
  /** True airspeed, m/s. */
  airspeed: number;
  /** 0–1: how far the wing is into the stall. */
  stalled: number;
  /** Lift coefficient, for the stall warning. */
  cl: number;
}

/**
 * Forces and moments on the airframe.
 * @param air Velocity of the aircraft through the air, body frame (forward, left, up), m/s.
 * @param omega Angular velocity, body frame, rad/s.
 * @param thrustN Current thrust, for the slipstream over the tail.
 */
export function aerodynamics(
  air: Vec3,
  omega: Vec3,
  surfaces: Surfaces,
  density: number,
  thrustN: number,
  p: FixedWingParams = TRAINER,
): AeroResult {
  // Textbook axes: u forward, v right, w down; p roll right, q pitch up, r yaw right.
  const u = air[0];
  const v = -air[1];
  const w = -air[2];
  const rollRate = omega[0];
  const pitchRate = -omega[1];
  const yawRate = -omega[2];

  const airspeed = Math.hypot(u, v, w);
  const V = Math.max(airspeed, 0.1);
  const alpha = Math.atan2(w, Math.max(u, 0.01));
  const beta = Math.asin(clamp(v / V, -1, 1));
  const qbar = 0.5 * density * airspeed * airspeed;
  // The propeller blows on the elevator and rudder, so they work before the wing does.
  const qTail = qbar + p.slipstream * (Math.max(thrustN, 0) / p.propDisc);

  const pHat = (rollRate * p.span) / (2 * V);
  const qHat = (pitchRate * p.chord) / (2 * V);
  const rHat = (yawRate * p.span) / (2 * V);

  const elevator = -surfaces.elevator * p.elevatorMax; // textbook: positive = trailing edge down
  const aileron = surfaces.aileron * p.aileronMax;
  const rudder = -surfaces.rudder * p.rudderMax; // textbook: positive = nose left
  const flap = clamp(surfaces.flaps / 30, 0, 1);

  const wing = wingLift(alpha, surfaces.flaps, p);
  const cl = wing.cl + p.CLq * qHat + p.CLelevator * elevator;
  const cd =
    p.CD0 +
    flap * p.flapDrag +
    (1 - wing.stalled) * p.inducedDrag * wing.attached * wing.attached +
    wing.stalled * 2 * Math.sin(alpha) ** 2;
  const cy = p.CYbeta * beta;

  const S = p.wingArea;
  const lift = qbar * S * cl;
  const drag = qbar * S * cd;
  const side = qbar * S * cy + qTail * S * p.CYrudder * rudder;

  const ca = Math.cos(alpha);
  const sa = Math.sin(alpha);
  const X = -drag * ca + lift * sa;
  const Z = -drag * sa - lift * ca;

  // Moment slopes are linear in the textbook; keep them bounded deep in the stall.
  const a = clamp(alpha, -30 * RAD, 30 * RAD);
  const b = clamp(beta, -30 * RAD, 30 * RAD);
  const roll =
    qbar *
      S *
      p.span *
      (p.ClBeta * b +
        p.Clp * pHat +
        p.Clr * rHat +
        p.ClAileron * aileron * (1 - 0.5 * wing.stalled)) +
    qTail * S * p.span * p.ClRudder * rudder;
  const pitch =
    qbar *
      S *
      p.chord *
      (p.Cm0 + flap * p.CmFlap + p.CmAlpha * a + p.Cmq * qHat) +
    qTail * S * p.chord * p.CmElevator * elevator;
  const yaw =
    qbar *
      S *
      p.span *
      (p.CnBeta * b + p.Cnp * pHat + p.Cnr * rHat + p.CnAileron * aileron) +
    qTail * S * p.span * p.CnRudder * rudder;

  return {
    force: [X, -side, -Z],
    torque: [roll, -pitch, -yaw],
    alpha,
    beta,
    airspeed,
    stalled: wing.stalled,
    cl,
  };
}
