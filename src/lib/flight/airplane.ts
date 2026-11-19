/**
 * The light airplane: rigid body + fixed-wing aerodynamics + engine + landing
 * gear, stepped at a fixed rate. Also the pilot-side helpers that belong to
 * the model rather than to the UI: the trim solver, crash rules and the
 * read-outs the instruments show.
 *
 * Everything is in real metres and SI units, world frame east-north-up.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import { airDensity, GRAVITY, SEA_LEVEL_DENSITY } from "./atmosphere.ts";
import { type ContactPoint, contactForces, type GroundFn } from "./contact.ts";
import {
  aerodynamics,
  type FixedWingParams,
  JET,
  RACER,
  TRAINER,
  targetRpm,
  thrust,
} from "./fixed-wing.ts";
import { integrateBody, type RigidBody, STEP } from "./rigid-body.ts";
import {
  add,
  clamp,
  DEG,
  fromAttitude,
  RAD,
  rotate,
  sub,
  toAttitude,
  unrotate,
  type Vec3,
} from "./vec.ts";

/* ------------------------------------------------------------------------ */
/* Landing gear and airframe points                                          */
/* ------------------------------------------------------------------------ */

/** Height of the centre of gravity above the ground when parked, metres. */
export const PARKED_HEIGHT = 1.08;

const WEIGHT = TRAINER.mass * GRAVITY;

/**
 * Tricycle gear: wheelbase 1.65 m, track 2.5 m, the centre of gravity 0.4 m
 * ahead of the mains, so the nose wheel carries about a quarter of the weight.
 * Springs give roughly 8 cm of static deflection, dampers about half critical.
 */
export const TRAINER_GEAR: ContactPoint[] = [
  {
    name: "nose",
    position: [1.25, 0, -1.16],
    kind: "wheel",
    stiffness: (0.24 * WEIGHT) / 0.08,
    damping: 2700,
    steered: true,
    friction: 0.02,
    sideFriction: 0.6,
  },
  ...([1, -1] as const).map(
    (side): ContactPoint => ({
      name: side > 0 ? "left main" : "right main",
      position: [-0.4, side * 1.25, -1.16],
      kind: "wheel",
      stiffness: (0.38 * WEIGHT) / 0.08,
      damping: 4400,
      braked: true,
      friction: 0.02,
      sideFriction: 0.7,
      brakeFriction: 0.45,
    }),
  ),
  // The tail tie-down ring: scraping it on a steep rotation is not a crash.
  {
    name: "tail",
    position: [-4.4, 0, -0.3],
    kind: "skid",
    stiffness: 60_000,
    damping: 4000,
    friction: 0.5,
  },
];

/** Parts that end the flight when they touch the ground. */
export const TRAINER_STRUCTURE: ContactPoint[] = (
  [
    ["propeller", [1.95, 0, -0.5]],
    ["left wing tip", [0.1, 5.45, 0.85]],
    ["right wing tip", [0.1, -5.45, 0.85]],
    ["belly", [-0.3, 0, -0.62]],
    ["fin", [-4.9, 0, 1.6]],
    ["cabin roof", [0.2, 0, 1.05]],
  ] as [string, Vec3][]
).map(([name, position]) => ({
  name,
  position,
  kind: "structure",
  stiffness: 150_000,
  damping: 8000,
  friction: 0.8,
}));

/**
 * Racer: a taildragger. Mains 0.45 m ahead of the centre of gravity carry
 * about 90 % of the weight, the tail wheel the rest. Sitting on its tail the propeller clears the ground easily; level,
 * the lowest blade tip is about 15 cm up.
 */
const RACER_WEIGHT = RACER.mass * GRAVITY;
export const RACER_GEAR: ContactPoint[] = [
  ...([1, -1] as const).map(
    (side): ContactPoint => ({
      name: side > 0 ? "left main" : "right main",
      position: [0.45, side * 0.95, -1.05],
      kind: "wheel",
      stiffness: (0.45 * RACER_WEIGHT) / 0.07,
      damping: 3200,
      braked: true,
      friction: 0.02,
      sideFriction: 0.7,
      brakeFriction: 0.4,
    }),
  ),
  {
    name: "tail wheel",
    position: [-4.3, 0, -0.35],
    kind: "wheel",
    stiffness: (0.1 * RACER_WEIGHT) / 0.05,
    damping: 900,
    // Free-castering: it follows rather than steers (a steered wheel behind the
    // centre of gravity would turn the wrong way with the nose-wheel logic).
    friction: 0.03,
    sideFriction: 0.25,
  },
];

export const RACER_STRUCTURE: ContactPoint[] = (
  [
    ["propeller", [2.0, 0, -0.9]],
    ["left wing tip", [0, 4.0, -0.35]],
    ["right wing tip", [0, -4.0, -0.35]],
    ["belly", [-0.6, 0, -0.55]],
    ["fin", [-4.6, 0, 1.15]],
    ["canopy", [0.1, 0, 0.8]],
  ] as [string, Vec3][]
).map(([name, position]) => ({
  name,
  position,
  kind: "structure",
  stiffness: 150_000,
  damping: 8000,
  friction: 0.8,
}));

/** One aircraft type: its aerodynamics and engine, and where it touches the ground. */
/**
 * Jet: tricycle gear measured off the playground's F-14 model
 * (public/models), centre of gravity 0.82 m ahead of the mains so the nose
 * wheel carries about 12 %. On the ground it sits about 4° nose up, as the
 * model's gear does. Retracts.
 */
const JET_WEIGHT = JET.mass * GRAVITY;
export const JET_GEAR: ContactPoint[] = [
  {
    name: "nose",
    position: [6.16, 0, -2.21],
    kind: "wheel",
    stiffness: (0.12 * JET_WEIGHT) / 0.15,
    damping: 60_000,
    steered: true,
    friction: 0.02,
    sideFriction: 0.6,
  },
  ...([1, -1] as const).map(
    (side): ContactPoint => ({
      name: side > 0 ? "left main" : "right main",
      position: [-0.82, side * 2.49, -2.7],
      kind: "wheel",
      stiffness: (0.44 * JET_WEIGHT) / 0.15,
      damping: 180_000,
      braked: true,
      friction: 0.02,
      sideFriction: 0.7,
      brakeFriction: 0.5,
    }),
  ),
];

export const JET_STRUCTURE: ContactPoint[] = (
  [
    ["nose", [11.48, 0, -0.37]],
    ["belly", [8.96, 0, -1.16]],
    ["left wing tip", [-2.67, 9.77, 0.43]],
    ["right wing tip", [-2.67, -9.77, 0.43]],
    ["left engine", [-3.5, 1.4, -1.65]],
    ["right engine", [-3.5, -1.4, -1.65]],
    ["tail", [-7.67, 0, 0.2]],
    ["fins", [-6.82, 0, 2.83]],
  ] as [string, Vec3][]
).map(([name, position]) => ({
  name,
  position,
  kind: "structure",
  stiffness: 2e6,
  damping: 1e5,
  friction: 0.8,
}));

/** One aircraft type: its aerodynamics and engine, and where it touches the ground. */
export interface Airframe {
  id: "trainer" | "racer" | "jet";
  params: FixedWingParams;
  /** Three wheels first (their loads count wheels on the ground), then any skids. */
  gear: ContactPoint[];
  structure: ContactPoint[];
  /** Height of the centre of gravity above the ground when parked level, metres. */
  parkedHeight: number;
  /** A comfortable cruising speed for airborne starts, m/s. */
  cruise: number;
  /** Gear that folds away: its extra drag coefficient when down, and seconds to travel. */
  retractable?: { drag: number; travel: number };
  /**
   * With assists on and airborne, the stick commands a pitch rate (full
   * stick = `maxRate`, rad/s) and centred holds the attitude, as a fighter's
   * fly-by-wire does; angle of attack is kept under `maxAlpha` (rad).
   */
  flyByWire?: { maxRate: number; maxAlpha: number };
}

export const TRAINER_AIRFRAME: Airframe = {
  id: "trainer",
  params: TRAINER,
  gear: TRAINER_GEAR,
  structure: TRAINER_STRUCTURE,
  parkedHeight: PARKED_HEIGHT,
  cruise: 55,
};

export const RACER_AIRFRAME: Airframe = {
  id: "racer",
  params: RACER,
  gear: RACER_GEAR,
  structure: RACER_STRUCTURE,
  parkedHeight: 0.98,
  cruise: 75,
};

export const JET_AIRFRAME: Airframe = {
  id: "jet",
  params: JET,
  gear: JET_GEAR,
  structure: JET_STRUCTURE,
  // The mains' depth; the nose sits higher (see JET_GEAR).
  parkedHeight: 2.66,
  cruise: 150,
  retractable: { drag: 0.018, travel: 6 },
  flyByWire: { maxRate: 20 * RAD, maxAlpha: 15 * RAD },
};

/** Nose wheel steering at full rudder, radians; fades out with speed. */
const STEER_MAX = 12 * RAD;
/** Touching down faster than this breaks the gear, m/s (about 700 ft/min). */
export const MAX_TOUCHDOWN_SINK = 3.6;

/* ------------------------------------------------------------------------ */
/* State                                                                     */
/* ------------------------------------------------------------------------ */

export interface AirplaneControls {
  /** −1…1, positive = nose up. */
  pitch: number;
  /** −1…1, positive = roll right. */
  roll: number;
  /** −1…1, positive = nose right; also steers the nose wheel. */
  yaw: number;
  /** 0…1. */
  throttle: number;
  /** Index into the flap settings. */
  flaps: number;
  /** −1…1, positive = nose up. */
  trim: number;
  /** 0…1 on the main wheels. */
  brake: number;
}

export const NEUTRAL_CONTROLS: AirplaneControls = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 0,
  flaps: 0,
  trim: 0,
  brake: 0,
};

export type CrashCause = "hard-landing" | "structure";

export interface Airplane {
  frame: Airframe;
  /** Retractable gear: 1 down and locked, 0 up; travels towards `gearCommand`. Always 1 for fixed gear. */
  gearDown: number;
  /** Retractable gear: the lever, true = down. */
  gearCommand: boolean;
  /** Fly-by-wire: the integral of the pitch-rate error, which becomes the trim it finds. */
  fbwTrim: number;
  body: RigidBody;
  rpm: number;
  /** Where the flaps actually are, degrees (they travel slowly). */
  flapAngle: number;
  /** Wheels on the ground at the last step. */
  wheelsDown: number;
  crashed: { cause: CrashCause; part?: string } | null;
  /** Values from the last step, for instruments, assists and sound. */
  alpha: number;
  beta: number;
  airspeed: number;
  stalled: number;
  thrust: number;
  /** Surface positions actually applied (−1…1), for the model's animation. */
  surfaces: { elevator: number; aileron: number; rudder: number };
}

export interface Environment {
  /** Ground elevation at a local east/north, real metres. */
  ground: GroundFn;
  /** Velocity of the air mass, world frame, m/s. */
  wind: Vec3;
}

export const CALM: Vec3 = [0, 0, 0];

/** Wind blowing FROM a compass direction at a speed, as an air-mass velocity. */
export function windVector(fromDeg: number, speed: number): Vec3 {
  return [
    -Math.sin(fromDeg * RAD) * speed,
    -Math.cos(fromDeg * RAD) * speed,
    0,
  ];
}

function blank(
  frame: Airframe,
  body: RigidBody,
  rpm: number,
  flaps = 0,
): Airplane {
  return {
    frame,
    gearDown: 1,
    gearCommand: true,
    fbwTrim: 0,
    body,
    rpm,
    flapAngle: flaps,
    wheelsDown: 0,
    crashed: null,
    alpha: 0,
    beta: 0,
    airspeed: 0,
    stalled: 0,
    thrust: 0,
    surfaces: { elevator: 0, aileron: 0, rudder: 0 },
  };
}

/** Parked on the ground at a local position, engine idling. */
export function parkedAirplane(
  east: number,
  north: number,
  groundHeight: number,
  heading: number,
  frame: Airframe = TRAINER_AIRFRAME,
): Airplane {
  return blank(
    frame,
    {
      position: [east, north, groundHeight + frame.parkedHeight],
      velocity: [0, 0, 0],
      orientation: fromAttitude({ heading, pitch: 0, roll: 0 }),
      omega: [0, 0, 0],
    },
    frame.params.idleRpm,
  );
}

/* ------------------------------------------------------------------------ */
/* Trim                                                                      */
/* ------------------------------------------------------------------------ */

export interface Trim {
  /** Angle of attack, radians. */
  alpha: number;
  /** Elevator input (pitch + trim share) that balances the pitching moment. */
  elevator: number;
  throttle: number;
  rpm: number;
}

/**
 * Controls for steady level flight at a true airspeed and altitude, flaps up
 * unless given. Bisects the angle of attack for lift = weight, then the
 * throttle for thrust = drag; the elevator follows from the pitching moment.
 */
export function trimLevel(
  airspeed: number,
  altitude: number,
  flapDeg = 0,
  p: FixedWingParams = TRAINER,
): Trim {
  const density = airDensity(altitude);
  const weight = p.mass * GRAVITY;
  const flap = clamp(flapDeg / 30, 0, 1);
  const qbar = 0.5 * density * airspeed * airspeed;
  // The elevator sits in the slipstream, so its share depends on the thrust too.
  const elevatorFor = (alpha: number, thrustN: number) => {
    const qTail = qbar + p.slipstream * (Math.max(thrustN, 0) / p.propDisc);
    return clamp(
      ((p.Cm0 + flap * p.CmFlap + p.CmAlpha * alpha) * qbar) /
        (p.CmElevator * p.elevatorMax * qTail),
      -1,
      1,
    );
  };
  const at = (alpha: number, thrustN: number) =>
    aerodynamics(
      [airspeed * Math.cos(alpha), 0, -airspeed * Math.sin(alpha)],
      [0, 0, 0],
      {
        elevator: elevatorFor(alpha, thrustN),
        aileron: 0,
        rudder: 0,
        flaps: flapDeg,
      },
      density,
      thrustN,
      p,
    );
  /** World-frame up and forward force for an angle of attack in level flight. */
  const balance = (alpha: number, thrustN: number) => {
    const { force } = at(alpha, thrustN);
    const ca = Math.cos(alpha);
    const sa = Math.sin(alpha);
    const fx = force[0] + thrustN;
    return {
      up: fx * sa + force[2] * ca - weight,
      forward: fx * ca - force[2] * sa,
    };
  };

  let alpha = 0;
  let throttle = 0.5;
  let rpm = targetRpm(throttle, airspeed, p);
  for (let pass = 0; pass < 4; pass++) {
    const thrustN = thrust(rpm, airspeed * Math.cos(alpha), density, p);
    let lo = -5 * RAD;
    let hi = p.stallAlpha;
    for (let i = 0; i < 40; i++) {
      alpha = (lo + hi) / 2;
      if (balance(alpha, thrustN).up > 0) hi = alpha;
      else lo = alpha;
    }
    let tLo = 0;
    let tHi = 1;
    for (let i = 0; i < 40; i++) {
      throttle = (tLo + tHi) / 2;
      rpm = targetRpm(throttle, airspeed, p);
      if (
        balance(alpha, thrust(rpm, airspeed * Math.cos(alpha), density, p))
          .forward > 0
      )
        tHi = throttle;
      else tLo = throttle;
    }
  }
  return {
    alpha,
    elevator: elevatorFor(
      alpha,
      thrust(rpm, airspeed * Math.cos(alpha), density, p),
    ),
    throttle,
    rpm,
  };
}

/** In trimmed level flight at a local position, heading and true airspeed. */
export function airborneAirplane(
  position: Vec3,
  heading: number,
  airspeed: number,
  wind: Vec3 = CALM,
  frame: Airframe = TRAINER_AIRFRAME,
): { airplane: Airplane; trim: Trim } {
  const trim = trimLevel(airspeed, position[2], 0, frame.params);
  const orientation = fromAttitude({
    heading,
    pitch: trim.alpha * DEG,
    roll: 0,
  });
  const h = heading * RAD;
  const airplane = blank(
    frame,
    {
      position: [...position],
      velocity: add([Math.sin(h) * airspeed, Math.cos(h) * airspeed, 0], wind),
      orientation,
      omega: [0, 0, 0],
    },
    trim.rpm,
  );
  airplane.airspeed = airspeed;
  if (frame.retractable) {
    // Already flying: gear up.
    airplane.gearDown = 0;
    airplane.gearCommand = false;
  }
  airplane.alpha = trim.alpha;
  return { airplane, trim };
}

/* ------------------------------------------------------------------------ */
/* Step                                                                      */
/* ------------------------------------------------------------------------ */

/** Advance the airplane by dt seconds (mutates it). Does nothing once crashed. */
export function stepAirplane(
  plane: Airplane,
  controls: AirplaneControls,
  env: Environment,
  dt: number,
  p: FixedWingParams = plane.frame.params,
) {
  if (plane.crashed) return;
  const { body } = plane;
  const density = airDensity(body.position[2]);

  // Engine and flaps follow their levers with a lag.
  const air = unrotate(body.orientation, sub(body.velocity, env.wind));
  const airspeed = Math.hypot(air[0], air[1], air[2]);
  plane.rpm +=
    (targetRpm(controls.throttle, airspeed, p) - plane.rpm) *
    (1 - Math.exp(-dt / p.spoolTime));
  const flapTarget =
    p.flapSteps[clamp(Math.round(controls.flaps), 0, p.flapSteps.length - 1)];
  plane.flapAngle += clamp(
    flapTarget - plane.flapAngle,
    -p.flapRate * dt,
    p.flapRate * dt,
  );
  const thrustN = thrust(plane.rpm, Math.max(air[0], 0), density, p);
  const { retractable } = plane.frame;
  if (retractable) {
    plane.gearDown = clamp(
      plane.gearDown + (plane.gearCommand ? 1 : -1) * (dt / retractable.travel),
      0,
      1,
    );
  }
  /** Wheels only take load once the gear is down and locked. */
  const gearLocked = plane.gearDown >= 1;

  const elevator = clamp(
    controls.pitch + controls.trim * p.trimAuthority,
    -1,
    1,
  );
  const aileron = clamp(controls.roll, -1, 1);
  const rudder = clamp(controls.yaw, -1, 1);
  const aero = aerodynamics(
    air,
    body.omega,
    { elevator, aileron, rudder, flaps: plane.flapAngle },
    density,
    thrustN,
    p,
  );

  // Nose wheel steering: full at taxi speed, fading out as the rudder takes over.
  const steer = -rudder * STEER_MAX * clamp(1.4 - airspeed / 25, 0.15, 1);
  const input = { steer, brake: clamp(controls.brake, 0, 1) };
  const gear = contactForces(
    body,
    gearLocked ? plane.frame.gear : [],
    env.ground,
    input,
  );
  const structure = contactForces(
    body,
    plane.frame.structure,
    env.ground,
    input,
  );

  const wheels = gear.loads.slice(0, 3).filter((load) => load > 0).length;
  const hit = structure.loads.findIndex((load) => load > 0);
  if (hit >= 0) {
    plane.crashed = {
      cause: "structure",
      part: plane.frame.structure[hit].name,
    };
  } else if (wheels > plane.wheelsDown && gear.sinkRate > MAX_TOUCHDOWN_SINK) {
    plane.crashed = { cause: "hard-landing" };
  }
  plane.wheelsDown = wheels;

  let bodyForce = add(aero.force, [thrustN, 0, 0]);
  if (retractable && plane.gearDown > 0 && airspeed > 0.1) {
    // Gear hanging in the airflow: extra drag straight against it.
    const drag =
      0.5 *
      density *
      airspeed *
      airspeed *
      p.wingArea *
      retractable.drag *
      plane.gearDown;
    bodyForce = add(bodyForce, [
      (-air[0] / airspeed) * drag,
      (-air[1] / airspeed) * drag,
      (-air[2] / airspeed) * drag,
    ]);
  }
  const force = add(add(rotate(body.orientation, bodyForce), gear.force), [
    0,
    0,
    -p.mass * GRAVITY,
  ]);
  const torque = add(aero.torque, gear.torque);
  integrateBody(body, p, force, torque, dt);

  plane.alpha = aero.alpha;
  plane.beta = aero.beta;
  plane.airspeed = aero.airspeed;
  plane.stalled = aero.stalled;
  plane.thrust = thrustN;
  plane.surfaces.elevator = elevator;
  plane.surfaces.aileron = aileron;
  plane.surfaces.rudder = rudder;

  if (plane.crashed) {
    // Stop dead where it hit; the UI takes over from here.
    body.velocity = [0, 0, 0];
    body.omega = [0, 0, 0];
  }
}

/* ------------------------------------------------------------------------ */
/* Read-outs                                                                 */
/* ------------------------------------------------------------------------ */

export interface FlightData {
  /** Indicated airspeed, m/s (true airspeed scaled by the density ratio). */
  ias: number;
  /** True airspeed, m/s. */
  tas: number;
  /** Altitude above sea level, metres. */
  altitude: number;
  /** Height of the wheels above the ground, metres. */
  agl: number;
  /** Vertical speed, m/s. */
  climb: number;
  /** Degrees. */
  heading: number;
  pitch: number;
  roll: number;
  /** Ground speed, m/s. */
  groundSpeed: number;
  rpm: number;
  flaps: number;
  /** The wing is at or near the critical angle of attack. */
  stallWarning: boolean;
  onGround: boolean;
}

/**
 * The horn sounds this far below the half-separated angle: about 3° (5–8 kt)
 * before lift peaks, like a reed stall warner.
 */
const STALL_WARNING_MARGIN = 5.7 * RAD;

export function flightData(
  plane: Airplane,
  env: Environment,
  p: FixedWingParams = plane.frame.params,
): FlightData {
  const { body } = plane;
  const attitude = toAttitude(body.orientation);
  const density = airDensity(body.position[2]);
  const flap = clamp(plane.flapAngle / 30, 0, 1);
  const critical = p.stallAlpha + flap * p.flapStallAlpha;
  const onGround = plane.wheelsDown > 0;
  return {
    ias: plane.airspeed * Math.sqrt(density / SEA_LEVEL_DENSITY),
    tas: plane.airspeed,
    altitude: body.position[2],
    agl: Math.max(
      0,
      body.position[2] -
        plane.frame.parkedHeight -
        env.ground(body.position[0], body.position[1]),
    ),
    climb: body.velocity[2],
    heading: attitude.heading,
    pitch: attitude.pitch,
    roll: attitude.roll,
    groundSpeed: Math.hypot(body.velocity[0], body.velocity[1]),
    rpm: plane.rpm,
    flaps: plane.flapAngle,
    stallWarning:
      !onGround &&
      plane.airspeed > 8 &&
      plane.alpha > critical - STALL_WARNING_MARGIN,
    onGround,
  };
}

/* ------------------------------------------------------------------------ */
/* Assists                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Keyboard-and-mouse help, applied to the pilot's inputs before the model
 * sees them: the rudder keeps the ball centred (and leads the ailerons into a
 * turn), and with the stick centred sideways the wings ease back to level.
 * Returns new controls; the pilot's own inputs always add on top.
 */
export function assist(
  controls: AirplaneControls,
  plane: Airplane,
  dt = STEP,
): AirplaneControls {
  const fbw = plane.frame.flyByWire;
  if (plane.wheelsDown > 0) {
    // On the wheels the stick works directly (rotation); the fly-by-wire starts from scratch at lift-off.
    plane.fbwTrim =
      controls.pitch + controls.trim * plane.frame.params.trimAuthority;
    return controls;
  }
  let pitch = controls.pitch;
  let trim = controls.trim;
  if (fbw) {
    // Pitch rate wanted, eased off as the angle of attack nears its limit.
    const nosesUp = -plane.body.omega[1];
    let wanted = controls.pitch * fbw.maxRate;
    const room = fbw.maxAlpha - plane.alpha;
    if (wanted > 0) wanted = Math.min(wanted, Math.max(0, room) * 3);
    if (room < 0) wanted += room * 3;
    const error = wanted - nosesUp;
    // Gains are per unit of elevator authority, so the loop behaves the same at any speed.
    const q = Math.max(plane.airspeed, 40);
    const scale = (120 / q) ** 2;
    plane.fbwTrim = clamp(plane.fbwTrim + 2.5 * scale * error * dt, -1, 1);
    pitch = clamp(plane.fbwTrim + 1.6 * scale * error, -1, 1);
    trim = 0;
  }
  const { roll } = toAttitude(plane.body.orientation);
  const fade = clamp((plane.airspeed - 15) / 10, 0, 1);
  const coordinated = clamp(
    controls.yaw + fade * (2.2 * plane.beta + 0.25 * controls.roll),
    -1,
    1,
  );
  const centred = Math.abs(controls.roll) < 0.02;
  const levelling = centred
    ? fade * clamp(-0.012 * roll - 0.25 * plane.body.omega[0], -0.35, 0.35)
    : 0;
  return {
    ...controls,
    pitch,
    trim,
    yaw: coordinated,
    roll: clamp(controls.roll + levelling, -1, 1),
  };
}

/** Body-frame velocity through the air, for callers that need it (camera shake, sound). */
export const airVelocity = (plane: Airplane, wind: Vec3): Vec3 =>
  unrotate(plane.body.orientation, sub(plane.body.velocity, wind));
