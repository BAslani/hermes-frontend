/**
 * A light twin-engine helicopter with H135-class numbers: 2.6 t, a 10.2 m
 * four-blade hingeless main rotor at 395 rpm, a shrouded tail fan, skids.
 *
 * - Main rotor thrust: blade element theory for an untwisted blade (thrust
 *   coefficient from collective pitch, inflow and advance ratio), with the
 *   inflow from momentum theory, iterated. Translational lift falls out of
 *   this: forward speed lets the rotor work on more air, the inflow drops and
 *   the same collective lifts more.
 * - Ground effect: Cheeseman and Bennett's factor, fading with speed.
 * - Vortex ring state: descending at about the hover inflow speed with little
 *   forward speed loses thrust and shakes the airframe. Momentum theory does
 *   not hold there, so it is an empirical loss on top.
 * - Power: induced, climb, profile and fuselage drag power. A governor holds
 *   rotor speed while the engines can give the power; asked for more, rotor
 *   speed droops, and thrust with it (thrust goes with rotor speed squared).
 * - The main rotor's torque yaws the fuselage nose right; the tail fan pushes
 *   back with the pedals. A vertical fin weathervanes the tail at speed.
 * - Cyclic tilts the rotor disc with a short lag. A hingeless rotor moves the
 *   fuselage hard: the thrust acts above the centre of gravity and the hub
 *   itself is stiff. The disc lags fuselage rotation (which damps it) and
 *   blows back with forward speed (speed stability).
 * - Skids are spring-damper contacts; rotor tips, tail and nose must not
 *   touch. Tipping over on a slope puts a rotor tip into the ground.
 *
 * Numbers follow the class (published H135 dimensions and performance;
 * rotor aerodynamics from Leishman, "Principles of Helicopter Aerodynamics",
 * and Padfield, "Helicopter Flight Dynamics"). A playground model, not a
 * validated one.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import { airDensity, GRAVITY, SEA_LEVEL_DENSITY } from "./atmosphere.ts";
import { type ContactPoint, contactForces, type GroundFn } from "./contact.ts";
import { integrateBody, type RigidBody } from "./rigid-body.ts";
import {
  add,
  clamp,
  cross,
  DEG,
  dot,
  fromAttitude,
  length,
  RAD,
  rotate,
  scale,
  sub,
  toAttitude,
  unrotate,
  type Vec3,
} from "./vec.ts";

export const HELI = {
  /** kg: crew of two, some fuel. */
  mass: 2600,
  /** Roll, pitch, yaw, kg·m². */
  inertia: [1700, 5200, 4600] as Vec3,
  rotor: {
    radius: 5.1,
    blades: 4,
    chord: 0.29,
    /** rad/s at 100 % (395 rpm). */
    omega: 41.4,
    liftSlope: 5.7,
    profileDrag: 0.011,
    /** Induced power factor over ideal. */
    inducedFactor: 1.15,
    /** kg·m²: rotor speed's inertia (blades and hub). */
    inertia: 1000,
    /** Hub above the centre of gravity, body frame. */
    hub: [0, 0, 2.23] as Vec3,
    /** Hub moment per radian of disc tilt relative to the mast, N·m. */
    hubStiffness: 60_000,
    /** Seconds for the disc to follow the cyclic. */
    discLag: 0.08,
    /** Full cyclic tilts the disc this far, radians. */
    maxCyclic: 9 * RAD,
    /** Collective pitch range, radians. */
    pitchMin: 0.5 * RAD,
    pitchMax: 17 * RAD,
    /**
     * How far the disc lags fuselage rotation, seconds (16 / (γΩ) with
     * Lock number 6): the main source of pitch and roll damping.
     */
    rateLag: 0.064,
  },
  tail: {
    /** Fan behind the centre of gravity, metres. */
    arm: 6.3,
    /** Fan thrust at full pedal travel, N, at 100 % rotor speed. */
    maxThrust: 4200,
    /** Share of the travel at neutral pedals (enough to hold the hover torque, roughly). */
    neutral: 0.42,
    /** Yaw damping from the fan and fin, N·m per rad/s. */
    yawDamping: 4000,
    /** Fin area × lift slope, for weathervaning, m². */
    fin: 3.2,
  },
  engine: {
    /** Both engines, W, at sea level. */
    maxPower: 900_000,
    /** Governor gain: W per rad/s of rotor speed error. */
    governor: 60_000,
  },
  /** Fuselage drag areas forward, sideways, vertical, m². */
  dragArea: [1.6, 6, 9] as Vec3,
  /** Pitch and roll damping of the fuselage itself, N·m per rad/s. */
  bodyDamping: 1500,
} as const;

/* ------------------------------------------------------------------------ */
/* Contacts                                                                  */
/* ------------------------------------------------------------------------ */

/** Height of the centre of gravity above the ground when standing on the skids. */
export const HELI_PARKED_HEIGHT = 1.3;
const WEIGHT = HELI.mass * GRAVITY;

/** Four skid points (front and back of each skid), measured off the playground model. */
export const HELI_SKIDS: ContactPoint[] = ([1, -1] as const).flatMap((side) =>
  ([1.89, -1.07] as const).map(
    (x): ContactPoint => ({
      name: `${side > 0 ? "left" : "right"} skid ${x > 0 ? "front" : "back"}`,
      position: [x, side * 1.54, -1.32],
      kind: "skid",
      stiffness: WEIGHT / 4 / 0.03,
      damping: 9000,
      friction: 0.55,
    }),
  ),
);

/** Parts that end the flight when they touch the ground. */
export const HELI_STRUCTURE: ContactPoint[] = (
  [
    ["main rotor (front)", [5.0, 0, 2.15]],
    ["main rotor (back)", [-5.0, 0, 2.15]],
    ["main rotor (left)", [0, 5.0, 2.15]],
    ["main rotor (right)", [0, -5.0, 2.15]],
    ["tail", [-5.37, 0, -0.05]],
    ["nose", [3.03, 0, -0.25]],
    ["belly", [0.5, 0, -0.8]],
  ] as [string, Vec3][]
).map(([name, position]) => ({
  name,
  position,
  kind: "structure",
  stiffness: 300_000,
  damping: 15_000,
  friction: 0.8,
}));

/** Touching down faster than this breaks the skids, m/s (about 600 ft/min). */
export const MAX_SKID_SINK = 3;

/* ------------------------------------------------------------------------ */
/* State                                                                     */
/* ------------------------------------------------------------------------ */

export interface HeliControls {
  /** 0–1: collective lever, bottom to top. */
  collective: number;
  /** −1…1: cyclic, right = roll right. */
  roll: number;
  /** −1…1: cyclic, back = nose up. */
  pitch: number;
  /** −1…1: pedals, right = nose right. */
  pedal: number;
}

export const NEUTRAL_HELI: HeliControls = {
  collective: 0,
  roll: 0,
  pitch: 0,
  pedal: 0,
};

export type HeliCrash = "hard-landing" | "structure";

export interface Helicopter {
  body: RigidBody;
  /** Rotor speed, rad/s. */
  rotorSpeed: number;
  /** Disc tilt relative to the mast, radians: forward (nose-down push) and right. */
  disc: { forward: number; right: number };
  /** Inflow ratio from the last step, the starting guess for the next. */
  inflow: number;
  crashed: { cause: HeliCrash; part?: string } | null;
  /** Skid points on the ground at the last step. */
  skidsDown: number;
  /** Read-outs from the last step. */
  thrust: number;
  /** Power the rotor and fuselage need, W. */
  power: number;
  /** Main rotor torque, N·m. */
  torque: number;
  airspeed: number;
  /** 0–1: how deep in vortex ring state. */
  vortexRing: number;
  /** Ground effect thrust factor (1 = none). */
  groundEffect: number;
  /** Fastest skid point moving down while touching the ground this step, m/s (touchdown hardness). */
  sinkRate: number;
  /** Assist memory: the heading held while the pedals are free. */
  headingHold: number | null;
  /** Assist memory: the collective the climb-rate hold has settled on. */
  collectiveHold: number | null;
}

export interface HeliEnvironment {
  ground: GroundFn;
  /** Air-mass velocity, world frame, m/s. */
  wind: Vec3;
}

function blank(body: RigidBody, rotorSpeed: number): Helicopter {
  return {
    body,
    rotorSpeed,
    disc: { forward: 0, right: 0 },
    inflow: 0.05,
    crashed: null,
    skidsDown: 0,
    thrust: 0,
    power: 0,
    torque: 0,
    airspeed: 0,
    vortexRing: 0,
    groundEffect: 1,
    sinkRate: 0,
    headingHold: null,
    collectiveHold: null,
  };
}

/** Standing on its skids, rotor turning at flight speed, collective down. */
export function parkedHelicopter(
  east: number,
  north: number,
  groundHeight: number,
  heading: number,
): Helicopter {
  return blank(
    {
      position: [east, north, groundHeight + HELI_PARKED_HEIGHT],
      velocity: [0, 0, 0],
      orientation: fromAttitude({ heading, pitch: 0, roll: 0 }),
      omega: [0, 0, 0],
    },
    HELI.rotor.omega,
  );
}

/** Hovering out of ground effect at a position, with the collective that holds it there. */
export function hoveringHelicopter(
  position: Vec3,
  heading: number,
): { heli: Helicopter; collective: number } {
  const heli = blank(
    {
      position: [...position],
      velocity: [0, 0, 0],
      orientation: fromAttitude({ heading, pitch: 0, roll: 0 }),
      omega: [0, 0, 0],
    },
    HELI.rotor.omega,
  );
  const collective = hoverCollective(position[2]);
  heli.inflow =
    Math.sqrt(
      WEIGHT / (2 * airDensity(position[2]) * Math.PI * HELI.rotor.radius ** 2),
    ) /
    (HELI.rotor.omega * HELI.rotor.radius);
  return { heli, collective };
}

/* ------------------------------------------------------------------------ */
/* Rotor                                                                     */
/* ------------------------------------------------------------------------ */

const AREA = Math.PI * HELI.rotor.radius ** 2;
const SOLIDITY =
  (HELI.rotor.blades * HELI.rotor.chord) / (Math.PI * HELI.rotor.radius);

export const pitchFor = (collective: number) =>
  HELI.rotor.pitchMin +
  clamp(collective, 0, 1) * (HELI.rotor.pitchMax - HELI.rotor.pitchMin);

export interface RotorResult {
  /** Thrust coefficient and the converged inflow ratio (climb + induced). */
  ct: number;
  inflow: number;
  induced: number;
}

/**
 * Thrust coefficient and inflow for a blade pitch, advance ratio `mu` and
 * climb inflow `climb` (velocity through the disc upwards / tip speed),
 * starting from a guess. Momentum inflow, relaxed so it converges in descent.
 */
export function rotorThrust(
  pitch: number,
  mu: number,
  climb: number,
  guess = 0.05,
): RotorResult {
  const a = HELI.rotor.liftSlope;
  let inflow = guess;
  let ct = 0;
  let induced = 0;
  for (let i = 0; i < 12; i++) {
    ct =
      ((SOLIDITY * a) / 2) * ((pitch / 3) * (1 + 1.5 * mu * mu) - inflow / 2);
    // Momentum theory: induced inflow from thrust and the air through the disc.
    induced =
      Math.max(ct, 0) / (2 * Math.sqrt(mu * mu + inflow * inflow + 1e-6));
    inflow += 0.5 * (climb + induced - inflow);
  }
  return { ct: Math.max(ct, 0), inflow, induced };
}

/** Collective that hovers out of ground effect at an altitude, at gross weight. */
export function hoverCollective(altitude: number, mass: number = HELI.mass) {
  const density = airDensity(altitude);
  const tip = HELI.rotor.omega * HELI.rotor.radius;
  const need = (mass * GRAVITY) / (density * AREA * tip * tip);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const c = (lo + hi) / 2;
    if (rotorThrust(pitchFor(c), 0, 0).ct > need) hi = c;
    else lo = c;
  }
  return (lo + hi) / 2;
}

/**
 * Power for steady level flight at a true airspeed and altitude, W (the
 * classic power curve): collective found for thrust = weight at that advance
 * ratio, then induced, profile and fuselage drag power.
 */
export function powerRequired(
  speed: number,
  altitude: number,
  mass: number = HELI.mass,
) {
  const density = airDensity(altitude);
  const tip = HELI.rotor.omega * HELI.rotor.radius;
  const mu = speed / tip;
  const weight = mass * GRAVITY;
  const drag = 0.5 * density * HELI.dragArea[0] * speed * speed;
  const need = Math.hypot(weight, drag) / (density * AREA * tip * tip);
  let lo = 0;
  let hi = 1;
  let result = rotorThrust(pitchFor(0.5), mu, 0);
  for (let i = 0; i < 40; i++) {
    const c = (lo + hi) / 2;
    result = rotorThrust(pitchFor(c), mu, 0, result.inflow);
    if (result.ct > need) hi = c;
    else lo = c;
  }
  const thrust = result.ct * density * AREA * tip * tip;
  const induced = HELI.rotor.inducedFactor * thrust * result.induced * tip;
  const profile =
    ((SOLIDITY * HELI.rotor.profileDrag) / 8) *
    (1 + 4.65 * mu * mu) *
    density *
    AREA *
    tip ** 3;
  return induced + profile + drag * speed;
}

/** Ground effect factor at a hub height (Cheeseman and Bennett), fading out with advance ratio. */
export function groundEffect(hubHeight: number, mu: number) {
  const r = HELI.rotor.radius;
  if (hubHeight > 2 * r) return 1;
  const ratio = r / (4 * Math.max(hubHeight, 0.5 * r));
  const full = Math.min(1.35, 1 / (1 - ratio * ratio));
  return 1 + (full - 1) * clamp(1 - mu / 0.1, 0, 1);
}

/**
 * How far into vortex ring state, 0–1, from the descent rate and forward
 * speed relative to the hover induced velocity: worst descending at about
 * 0.7 of it, with less than half of it in forward speed.
 */
export function vortexRingState(
  descent: number,
  forward: number,
  hoverInduced: number,
) {
  const d = descent / hoverInduced;
  const band =
    d < 0.3 || d > 1.6 ? 0 : d < 0.7 ? (d - 0.3) / 0.4 : 1 - (d - 0.7) / 0.9;
  return clamp(band, 0, 1) * clamp(1 - forward / (0.6 * hoverInduced), 0, 1);
}

/* ------------------------------------------------------------------------ */
/* Step                                                                      */
/* ------------------------------------------------------------------------ */

/** Advance the helicopter by dt seconds (mutates it). Does nothing once crashed. */
export function stepHelicopter(
  heli: Helicopter,
  controls: HeliControls,
  env: HeliEnvironment,
  dt: number,
) {
  if (heli.crashed) return;
  const { body } = heli;
  const { rotor, tail } = HELI;
  const density = airDensity(body.position[2]);
  const omega = Math.max(heli.rotorSpeed, 1);
  const tip = omega * rotor.radius;

  // Air through the hub and over the fuselage, body frame.
  const air = unrotate(body.orientation, sub(body.velocity, env.wind));
  const hubAir = add(air, cross(body.omega, rotor.hub));
  const airspeed = length(air);

  // Disc tilt: follows the cyclic with a lag, lags the fuselage's own rotation
  // (damping), and blows back with forward speed.
  const nosesUp = -body.omega[1];
  const rollsRight = body.omega[0];
  const muForward = Math.max(hubAir[0], 0) / tip;
  const pitch = pitchFor(controls.collective);
  const blowback = 2 * muForward * ((4 * pitch) / 3 - heli.inflow);
  // Air from the left (moving left) blows the disc over to the right, away from it.
  const sideflap = ((2 * hubAir[1]) / tip) * ((4 * pitch) / 3 - heli.inflow);
  const targetForward =
    -controls.pitch * rotor.maxCyclic - blowback + rotor.rateLag * nosesUp;
  const targetRight =
    controls.roll * rotor.maxCyclic +
    sideflap * 0.5 -
    rotor.rateLag * rollsRight;
  const follow = 1 - Math.exp(-dt / rotor.discLag);
  heli.disc.forward += (targetForward - heli.disc.forward) * follow;
  heli.disc.right += (targetRight - heli.disc.right) * follow;

  // Disc normal in the body frame: tilted forward (towards +x) and right (towards −y).
  const n: Vec3 = (() => {
    const v: Vec3 = [
      Math.sin(heli.disc.forward),
      -Math.sin(heli.disc.right),
      Math.cos(heli.disc.forward) * Math.cos(heli.disc.right),
    ];
    return scale(v, 1 / length(v));
  })();

  // Thrust.
  const through = dot(hubAir, n); // up through the disc is positive (climbing)
  const inPlane = sub(hubAir, scale(n, through));
  const mu = length(inPlane) / tip;
  const climb = through / tip;
  const { ct, inflow, induced } = rotorThrust(pitch, mu, climb, heli.inflow);
  heli.inflow = inflow;
  const ideal = ct * density * AREA * tip * tip;

  const groundBelow = env.ground(body.position[0], body.position[1]);
  const hubWorld = add(body.position, rotate(body.orientation, rotor.hub));
  const ge = groundEffect(hubWorld[2] - groundBelow, mu);
  const hoverInduced = Math.sqrt(Math.max(ideal, 1) / (2 * density * AREA));
  const vrs = vortexRingState(
    Math.max(0, -through),
    length(inPlane),
    hoverInduced,
  );
  const thrust = ideal * ge * (1 - 0.3 * vrs);

  // Power and the rotor's speed.
  const induce = rotor.inducedFactor * ideal * Math.max(induced, 0) * tip;
  const climbPower = ideal * climb * tip;
  const profile =
    ((SOLIDITY * rotor.profileDrag) / 8) *
    (1 + 4.65 * mu * mu) *
    density *
    AREA *
    tip ** 3;
  const parasite = 0.5 * density * HELI.dragArea[0] * Math.abs(air[0]) ** 3;
  const power =
    Math.max(induce + climbPower, 0.2 * induce) + profile + parasite;
  const available =
    HELI.engine.maxPower * clamp(density / SEA_LEVEL_DENSITY, 0, 1.1);
  const engine = clamp(
    power + HELI.engine.governor * (rotor.omega - omega),
    0,
    available,
  );
  heli.rotorSpeed = Math.max(
    0,
    omega + ((engine - power) / (rotor.inertia * omega)) * dt,
  );
  const torque = power / omega;

  // Forces, body frame.
  const rotorForce = scale(n, thrust);
  const drag: Vec3 = [
    -0.5 * density * HELI.dragArea[0] * air[0] * Math.abs(air[0]),
    -0.5 * density * HELI.dragArea[1] * air[1] * Math.abs(air[1]),
    -0.5 * density * HELI.dragArea[2] * air[2] * Math.abs(air[2]),
  ];
  // Tail fan pushes the tail right (−y) to yaw the nose left against the torque.
  const rpmShare = (omega / rotor.omega) ** 2;
  const fan =
    tail.maxThrust *
    clamp(tail.neutral - controls.pedal * (1 - tail.neutral), -0.3, 1) *
    rpmShare;
  const tailArm: Vec3 = [-tail.arm, 0, 0.6];
  const tailAir = add(air, cross(body.omega, tailArm));
  const fin =
    airspeed > 3
      ? -0.5 *
        density *
        tail.fin *
        tailAir[1] *
        Math.hypot(tailAir[0], tailAir[1])
      : 0;
  const tailForce: Vec3 = [0, -fan + fin, 0];

  // Moments, body frame.
  const hubMoment: Vec3 = [
    rotor.hubStiffness * heli.disc.right,
    rotor.hubStiffness * heli.disc.forward,
    0,
  ];
  const torqueReaction: Vec3 = [0, 0, -torque];
  const damping: Vec3 = [
    -HELI.bodyDamping * body.omega[0],
    -HELI.bodyDamping * body.omega[1],
    -tail.yawDamping * body.omega[2],
  ];
  // Vortex ring buffeting: random shakes in pitch and roll.
  const buffet: Vec3 =
    vrs > 0.05
      ? [
          (Math.random() - 0.5) * 9000 * vrs,
          (Math.random() - 0.5) * 9000 * vrs,
          0,
        ]
      : [0, 0, 0];

  const contacts = contactForces(body, HELI_SKIDS, env.ground, {
    steer: 0,
    brake: 0,
  });
  const structure = contactForces(body, HELI_STRUCTURE, env.ground, {
    steer: 0,
    brake: 0,
  });
  const down = contacts.loads.filter((load) => load > 0).length;
  const hit = structure.loads.findIndex((load) => load > 0);
  if (hit >= 0)
    heli.crashed = { cause: "structure", part: HELI_STRUCTURE[hit].name };
  else if (down > heli.skidsDown && contacts.sinkRate > MAX_SKID_SINK)
    heli.crashed = { cause: "hard-landing" };
  heli.skidsDown = down;

  const bodyForce = add(add(rotorForce, drag), tailForce);
  const force = add(add(rotate(body.orientation, bodyForce), contacts.force), [
    0,
    0,
    -HELI.mass * GRAVITY,
  ]);
  let moment = add(cross(rotor.hub, rotorForce), hubMoment);
  moment = add(moment, cross(tailArm, tailForce));
  moment = add(add(add(moment, torqueReaction), damping), buffet);
  moment = add(moment, contacts.torque);
  integrateBody(body, HELI, force, moment, dt);

  heli.thrust = thrust;
  heli.power = power;
  heli.torque = torque;
  heli.airspeed = airspeed;
  heli.vortexRing = vrs;
  heli.groundEffect = ge;
  heli.sinkRate = contacts.sinkRate;

  if (heli.crashed) {
    body.velocity = [0, 0, 0];
    body.omega = [0, 0, 0];
  }
}

/* ------------------------------------------------------------------------ */
/* Read-outs                                                                 */
/* ------------------------------------------------------------------------ */

export interface HeliData {
  /** Indicated airspeed, m/s. */
  ias: number;
  altitude: number;
  /** Radar altimeter: skids above the ground, metres. */
  height: number;
  climb: number;
  heading: number;
  pitch: number;
  roll: number;
  /** Rotor speed, % of 100 %. */
  rotor: number;
  /** Power used, % of what both engines give at sea level. */
  torque: number;
  lowRotor: boolean;
  vortexRing: boolean;
  onGround: boolean;
}

export function heliData(heli: Helicopter, env: HeliEnvironment): HeliData {
  const { body } = heli;
  const attitude = toAttitude(body.orientation);
  const density = airDensity(body.position[2]);
  const rotor = (heli.rotorSpeed / HELI.rotor.omega) * 100;
  return {
    ias: heli.airspeed * Math.sqrt(density / SEA_LEVEL_DENSITY),
    altitude: body.position[2],
    height: Math.max(
      0,
      body.position[2] -
        HELI_PARKED_HEIGHT -
        env.ground(body.position[0], body.position[1]),
    ),
    climb: body.velocity[2],
    heading: attitude.heading,
    pitch: attitude.pitch,
    roll: attitude.roll,
    rotor,
    torque: (heli.power / HELI.engine.maxPower) * 100,
    lowRotor: rotor < 92,
    vortexRing: heli.vortexRing > 0.3,
    onGround: heli.skidsDown > 0,
  };
}

/* ------------------------------------------------------------------------ */
/* Assists                                                                   */
/* ------------------------------------------------------------------------ */

/** Attitudes the cyclic commands at full travel with assists on, degrees. */
const ASSIST_PITCH = 20;
const ASSIST_BANK = 30;

/** With assists, the collective lever's middle hovers; its ends ask for these climb rates, m/s. */
export const ASSIST_CLIMB = 8;
export const ASSIST_DESCENT = 5;
/** Within this height of the ground the descent is eased to a touchdown speed, m and m/s. */
const CUSHION_HEIGHT = 12;
const TOUCHDOWN_SPEED = 1;

/**
 * Climb rate the assisted collective lever asks for (lever 0–1, middle =
 * hover), eased near the ground so the skids touch down gently.
 */
export function assistedClimb(lever: number, height: number) {
  const wanted =
    lever >= 0.5
      ? ((lever - 0.5) / 0.5) * ASSIST_CLIMB
      : -((0.5 - lever) / 0.5) * ASSIST_DESCENT;
  if (wanted >= 0) return wanted;
  const ease = clamp(height / CUSHION_HEIGHT, 0, 1);
  return Math.max(
    wanted,
    -(TOUCHDOWN_SPEED + (ASSIST_DESCENT - TOUCHDOWN_SPEED) * ease),
  );
}

/**
 * Stability augmentation for keyboard and mouse: the cyclic commands an
 * attitude (stick centred = level, holding position, so a centred stick
 * settles into a hover), pitch and roll rates are damped, the collective
 * lever asks for a climb rate (middle = hover), and with the pedals free the
 * heading is held; pedals command a yaw rate. Mutates the helicopter's assist
 * memory. On the ground it only holds the heading and lifts off once the
 * lever asks for a climb.
 */
export function heliAssist(
  controls: HeliControls,
  heli: Helicopter,
  env?: HeliEnvironment,
  dt = 1 / 120,
): HeliControls {
  const { body } = heli;
  // Collective: climb-rate hold.
  const height = env
    ? body.position[2] -
      HELI_PARKED_HEIGHT -
      env.ground(body.position[0], body.position[1])
    : 100;
  const wantedClimb = assistedClimb(controls.collective, height);
  let collective: number;
  if (heli.skidsDown > 0 && wantedClimb <= 0) {
    // Sitting on the skids with the lever low: flat pitch, ready to lift.
    heli.collectiveHold = null;
    collective = 0;
  } else {
    heli.collectiveHold ??=
      heli.skidsDown > 0
        ? hoverCollective(body.position[2]) * 0.92
        : hoverCollective(body.position[2]);
    const error = wantedClimb - body.velocity[2];
    heli.collectiveHold = clamp(
      heli.collectiveHold + 0.012 * error * dt * 60,
      0,
      1,
    );
    collective = clamp(heli.collectiveHold + 0.03 * error, 0, 1);
  }
  controls = { ...controls, collective };
  const attitude = toAttitude(body.orientation);
  const yawRate = body.omega[2] * DEG; // positive = nose left
  let pedal = controls.pedal;
  if (Math.abs(controls.pedal) < 0.05) {
    heli.headingHold ??= attitude.heading;
    const error = ((attitude.heading - heli.headingHold + 540) % 360) - 180; // positive = nose right of the held heading
    pedal = clamp(-0.06 * error + 0.03 * yawRate, -1, 1);
  } else {
    heli.headingHold = null;
    // Pedals ask for a yaw rate: full = 40°/s.
    pedal = clamp(
      0.5 * controls.pedal + 0.02 * (controls.pedal * 40 + yawRate),
      -1,
      1,
    );
  }
  if (heli.skidsDown > 0) return { ...controls, pedal };

  const nosesUp = -body.omega[1] * DEG;
  const rollsRight = body.omega[0] * DEG;
  // Near the centre the cyclic also holds position: lean against any drift
  // (the tail fan's side push, wind), so a centred stick stays put.
  const hold = clamp(
    1 - Math.hypot(controls.pitch, controls.roll) / 0.15,
    0,
    1,
  );
  const ground = unrotate(body.orientation, [
    body.velocity[0],
    body.velocity[1],
    0,
  ]);
  const pitchTarget =
    controls.pitch * ASSIST_PITCH + hold * clamp(1.2 * ground[0], -12, 12);
  const rollTarget =
    controls.roll * ASSIST_BANK + hold * clamp(1.5 * ground[1], -15, 15);
  const pitch = clamp(
    0.06 * (pitchTarget - attitude.pitch) - 0.025 * nosesUp,
    -1,
    1,
  );
  const roll = clamp(
    0.05 * (rollTarget - attitude.roll) - 0.02 * rollsRight,
    -1,
    1,
  );
  return { ...controls, pitch, roll, pedal };
}
