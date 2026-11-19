/**
 * Drone defence rules: waves of attack drones fly at a defended site over
 * the real terrain, hugging it at a set height and diving onto the site at
 * the end; the player's interceptor locks on and fires guided missiles that
 * steer by proportional navigation and burst by proximity fuse.
 *
 * Positions are local east-north-up metres with the site near the origin;
 * the caller supplies the ground. No DOM, MapLibre or three.js.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import type { GroundFn } from "./contact.ts";
import {
  add,
  cross,
  dot,
  length,
  normalize,
  scale,
  sub,
  type Vec3,
} from "./vec.ts";

const G = 9.81;
const RAD = Math.PI / 180;
/** Physics step: the missile turns hard and fast, so small steps. */
const SUBSTEP = 1 / 120;

export const MISSILE = {
  /** Pushed off the rails ahead of the carrier, m/s. */
  launchSpeed: 40,
  /** Motor acceleration while it burns, m/s², and for how long, s. */
  thrust: 140,
  burn: 2.8,
  /** Drag deceleration = drag × speed², per metre: about 420 m/s at burn-out, coasting down from there. */
  drag: 0.00025,
  /** Hardest it can turn, m/s² (about 30 g). */
  maxAccel: 300,
  /** Proportional navigation constant. */
  navigation: 4,
  /** The fuse fires this close to a drone, metres; it arms after `arm` seconds. */
  fuse: 7,
  arm: 0.3,
  /** Everything within this of the burst is destroyed, metres. */
  blast: 14,
  /** It destroys itself after this long, s. */
  life: 14,
} as const;

export const LOCK = {
  /** A drone this close to the crosshair (radians) starts a lock... */
  cone: 7 * RAD,
  /** ...which holds while it stays within this. */
  keep: 12 * RAD,
  /** Seconds to lock. */
  time: 0.9,
  /** Furthest a lock can reach, metres. */
  range: 4500,
} as const;

export const THREAT = {
  /** Turn rate cruising and diving, radians per second. */
  turnRate: 25 * RAD,
  diveTurnRate: 70 * RAD,
  /** Fastest climb or descent while following the terrain, m/s. */
  climb: 25,
  /** Ground looked at ahead along the track, metres. */
  lookahead: [0, 250, 500, 800],
  /** Starts the dive this far from the site, horizontally, metres. */
  diveRange: 900,
  /** Speeds up by this much in the dive. */
  diveSpeedUp: 1.25,
  /** Hits the site within this, metres. */
  impact: 15,
} as const;

/**
 * What kinds of drone there are, and how each differs from the plain attack
 * drone: points for downing it, how hard it turns, where it starts its dive.
 * - jet: fast and straight, dives from further out.
 * - low: slow, hugs the ground, hides behind it.
 * - decoy: looks like an attack drone but never dives: it passes over the
 *   site and leaves. Worth nothing; it is there to use up missiles.
 * - hunter: ignores the site and goes for the interceptor.
 */
export type ThreatKind = "attack" | "jet" | "low" | "decoy" | "hunter";

export const KINDS: Record<
  ThreatKind,
  { points: number; turnRate: number; diveRange: number; diveTurnRate: number }
> = {
  attack: {
    points: 100,
    turnRate: THREAT.turnRate,
    diveRange: THREAT.diveRange,
    diveTurnRate: THREAT.diveTurnRate,
  },
  jet: {
    points: 150,
    turnRate: 12 * RAD,
    diveRange: 1800,
    diveTurnRate: 45 * RAD,
  },
  low: {
    points: 120,
    turnRate: 35 * RAD,
    diveRange: 500,
    diveTurnRate: 80 * RAD,
  },
  decoy: {
    points: 0,
    turnRate: THREAT.turnRate,
    diveRange: THREAT.diveRange,
    diveTurnRate: THREAT.diveTurnRate,
  },
  hunter: {
    points: 150,
    turnRate: 45 * RAD,
    diveRange: 0,
    diveTurnRate: 70 * RAD,
  },
};

/** A hunter that gets this close to the interceptor hits it, metres. */
export const HUNTER_REACH = 10;
/** A hunter closer than this goes straight for the interceptor, metres. */
const HUNTER_TERMINAL = 600;
/** Decoys show what they are this close to the interceptor (the read-outs use it), metres. */
export const DECOY_REVEAL = 1200;
/** A decoy that has passed over the site leaves this far beyond it, metres. */
const DECOY_EXIT = 2500;
/** Hits the interceptor takes before it is lost, unless the scenario says otherwise. */
export const PLAYER_HITS = 3;

/** Drones appear above the highest ground this far along their way in, metres. */
const SPAWN_CLEAR = 1200;
/** A launched drone leaves the rail this high above the ground, metres, climbing at this angle. */
const LAUNCH = { height: 4, pitch: 35 * RAD };

/** Shortest time between launches, s. */
export const FIRE_INTERVAL = 0.5;

/**
 * Drone launchers on the ground: what it takes to destroy one. Missile bursts
 * and gun rounds wear its health down; destroyed, it launches nothing more.
 */
export const LAUNCHER = {
  health: 100,
  /** A missile bursting within `blast` metres takes this much... */
  missile: 50,
  blast: 20,
  /** ...and a round passing within `hitRadius` metres this much. */
  round: 2,
  hitRadius: 5,
  /** Its middle, for aiming at, this high above the ground, metres. */
  height: 2,
} as const;

/**
 * The close-range gun: rounds that fly ballistically and destroy a drone
 * they pass close to. For hunters and anything too close for a missile.
 */
export const GUN = {
  /** Muzzle speed, m/s, on top of the carrier's. */
  speed: 950,
  /** Rounds per second while the trigger is held. */
  rate: 12,
  /** Each round strays up to this from the aim, radians. */
  spread: 0.15 * RAD,
  /** Rounds fall away after this long (about 1.7 km), s. */
  life: 1.8,
  /** A round passing this close to a drone destroys it, metres. */
  hitRadius: 2.2,
  /** Rounds at the start of each wave, unless the scenario says otherwise. */
  rounds: 300,
} as const;

export interface WaveGroup {
  /** Bearing from the site the group comes from, degrees. */
  from: number;
  /** Each drone's bearing varies by up to this either way, degrees. */
  spread: number;
  count: number;
  /** Seconds between drones. */
  interval: number;
  /** Seconds after the wave starts that the first one appears. */
  delay?: number;
  /** m/s. */
  speed: number;
  /** Height kept above the ground ahead, metres. */
  cruise: number;
  /** Side-to-side weaving, degrees either way. */
  weave: number;
  /** What kind of drone (default: attack). */
  kind?: ThreatKind;
  /** A swarm: the group appears together and flies abreast, this many metres apart (interval and spread then apply to the whole group). */
  formation?: number;
  /**
   * Takes off from this launcher (an index into the spec's `launchers`)
   * instead of appearing in the air on the ring; `from` and `spread` are then
   * unused.
   */
  launcher?: number;
}

export interface StrikeSpec {
  /** What the drones aim at, local metres. */
  site: Vec3;
  /** Drones crashing within this of the site still count as hits, metres. */
  siteRadius: number;
  /** Drones appear this far from the site, metres. */
  spawnDistance: number;
  /** Launchers on the ground, local east/north metres, that wave groups can take off from. */
  launchers?: [number, number][];
  waves: { groups: WaveGroup[] }[];
  /** Hits the site takes before it is lost. */
  hitsAllowed: number;
  /** Missiles at the start of each wave. */
  magazine: number;
  /** Seconds before the first wave, and between waves. */
  firstBreak: number;
  breakTime: number;
  /** Hits the interceptor takes from hunters before it is lost (default PLAYER_HITS). */
  playerHits?: number;
  /** Gun rounds at the start of each wave (default GUN.rounds). */
  rounds?: number;
}

export interface Round {
  position: Vec3;
  velocity: Vec3;
  age: number;
  alive: boolean;
}

export interface Threat {
  id: number;
  kind: ThreatKind;
  position: Vec3;
  velocity: Vec3;
  speed: number;
  cruise: number;
  /** Weaving amplitude, radians, and its phase. */
  weave: number;
  phase: number;
  age: number;
  diving: boolean;
  alive: boolean;
  /** Highest ground ahead, refreshed a few times a second. */
  groundAhead: number;
  sampleIn: number;
  /** A decoy that has turned away over the site. */
  passed: boolean;
  /** Its place in a swarm: aims this far beside the site until the dive, so the swarm stays abreast. */
  slot: Vec3;
  /** The launcher it took off from, if any. */
  launcher?: number;
}

export interface Missile {
  id: number;
  position: Vec3;
  velocity: Vec3;
  /** The drone it steers for; null flies straight (fired without a lock). */
  target: number | null;
  /** Steers for this launcher instead of a drone. */
  launcher?: number;
  /** What its burst takes from a launcher it catches (default LAUNCHER.missile). */
  warhead?: number;
  age: number;
  alive: boolean;
}

export type StrikePhase = "break" | "wave" | "won" | "lost";

export interface StrikeGame {
  spec: StrikeSpec;
  time: number;
  /** Index of the current (or last) wave; -1 before the first. */
  wave: number;
  phase: StrikePhase;
  /** Seconds left in a break. */
  breakLeft: number;
  /** Drones of this wave yet to appear, by mission time. */
  pending: { at: number; threat: Threat }[];
  threats: Threat[];
  missiles: Missile[];
  hits: number;
  /** Real drones downed (not decoys), and the points they were worth. */
  kills: number;
  /** Real drones downed by missiles (accuracy counts these and launcher hits). */
  missileKills: number;
  /** Missile bursts that hurt a launcher. */
  launcherMissileHits: number;
  /** One per spec launcher. */
  launchers: { health: number; alive: boolean }[];
  rounds: Round[];
  ammo: number;
  gunCooldown: number;
  points: number;
  decoysHit: number;
  /** Hits the interceptor has taken. */
  damage: number;
  /** What was lost, once the game is. */
  lostBy: "site" | "interceptor" | null;
  fired: number;
  magazine: number;
  cooldown: number;
  nextId: number;
  seed: number;
}

export type StrikeEvent =
  | { kind: "wave"; index: number }
  | { kind: "wave-clear"; index: number }
  | {
      kind: "kill";
      at: Vec3;
      velocity: Vec3;
      threat: number;
      type: ThreatKind;
      points: number;
      by: "missile" | "gun";
    }
  | { kind: "burst"; at: Vec3; ground: boolean }
  | { kind: "site-hit"; at: Vec3; hitsLeft: number }
  | { kind: "crash"; at: Vec3; threat: number }
  | { kind: "player-hit"; at: Vec3; hitsLeft: number }
  | { kind: "launcher-hit"; index: number; at: Vec3; healthLeft: number }
  | { kind: "launcher-down"; index: number; at: Vec3 }
  | { kind: "won" }
  | { kind: "lost" };

/** Small seeded generator (mulberry32), so a game can be replayed in tests. */
function random(game: StrikeGame) {
  game.seed = (game.seed + 0x6d2b79f5) | 0;
  let t = game.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function newStrike(spec: StrikeSpec, seed = 1): StrikeGame {
  return {
    spec,
    time: 0,
    wave: -1,
    phase: "break",
    breakLeft: spec.firstBreak,
    pending: [],
    threats: [],
    missiles: [],
    hits: 0,
    kills: 0,
    missileKills: 0,
    launcherMissileHits: 0,
    launchers: (spec.launchers ?? []).map(() => ({
      health: LAUNCHER.health,
      alive: true,
    })),
    rounds: [],
    ammo: spec.rounds ?? GUN.rounds,
    gunCooldown: 0,
    points: 0,
    decoysHit: 0,
    damage: 0,
    lostBy: null,
    fired: 0,
    magazine: spec.magazine,
    cooldown: 0,
    nextId: 1,
    seed,
  };
}

/** Real drones in the whole scenario (decoys not counted). */
export const totalThreats = (spec: StrikeSpec) =>
  spec.waves.reduce(
    (sum, wave) =>
      sum +
      wave.groups.reduce((s, g) => s + (g.kind === "decoy" ? 0 : g.count), 0),
    0,
  );

/** The best score a scenario allows: every drone's points, the site untouched, every missile a kill. */
export const maxScore = (spec: StrikeSpec) =>
  spec.waves.reduce(
    (sum, wave) =>
      sum +
      wave.groups.reduce(
        (s, g) => s + g.count * KINDS[g.kind ?? "attack"].points,
        0,
      ),
    0,
  ) + 1500;

/** Drones of the current wave still to deal with: in the air or yet to appear. */
export const threatsLeft = (game: StrikeGame) =>
  game.pending.length + game.threats.filter((t) => t.alive).length;

/** Turn unit vector `from` towards unit vector `to` by at most `max` radians. */
export function rotateToward(from: Vec3, to: Vec3, max: number): Vec3 {
  const cos = Math.max(-1, Math.min(1, dot(from, to)));
  const angle = Math.acos(cos);
  if (angle <= max) return to;
  let axis = cross(from, to);
  if (length(axis) < 1e-9)
    axis =
      Math.abs(from[2]) < 0.9 ? cross(from, [0, 0, 1]) : cross(from, [1, 0, 0]);
  const k = normalize(axis);
  // Rodrigues: v cos θ + (k × v) sin θ (k ⟂ v here).
  return normalize(
    add(scale(from, Math.cos(max)), scale(cross(k, from), Math.sin(max))),
  );
}

function startWave(game: StrikeGame, ground: GroundFn, events: StrikeEvent[]) {
  game.wave += 1;
  game.phase = "wave";
  game.magazine = game.spec.magazine;
  game.ammo = game.spec.rounds ?? GUN.rounds;
  const { site, spawnDistance } = game.spec;
  for (const group of game.spec.waves[game.wave].groups) {
    const pad =
      group.launcher === undefined
        ? null
        : game.spec.launchers?.[group.launcher];
    if (pad === undefined)
      throw new Error(`No launcher ${group.launcher} in this scenario`);
    // A destroyed launcher launches nothing more.
    if (pad && !game.launchers[group.launcher!].alive) continue;
    // From a launcher: its bearing and distance from the site; otherwise the ring.
    const padBearing = pad ? Math.atan2(pad[0] - site[0], pad[1] - site[1]) : 0;
    const distance = pad
      ? Math.hypot(pad[0] - site[0], pad[1] - site[1])
      : spawnDistance;
    // A swarm shares one bearing and one weave; others draw their own.
    const swarmBearing =
      (group.from + (random(game) * 2 - 1) * group.spread) * RAD;
    const swarmPhase = random(game) * Math.PI * 2;
    for (let i = 0; i < group.count; i++) {
      const drawn = group.formation
        ? swarmBearing
        : (group.from + (random(game) * 2 - 1) * group.spread) * RAD;
      const bearing = pad ? padBearing : drawn;
      const abreast = group.formation
        ? (i - (group.count - 1) / 2) * group.formation
        : 0;
      // Abreast: offset across the line in (to the right of the way in is (cos, -sin)).
      const east =
        site[0] + Math.sin(bearing) * distance - Math.cos(bearing) * abreast;
      const north =
        site[1] + Math.cos(bearing) * distance + Math.sin(bearing) * abreast;
      const heading: Vec3 = normalize([
        Math.sin(bearing + Math.PI),
        Math.cos(bearing + Math.PI),
        0,
      ]);
      // In the air: above the highest ground of the first stretch in, so a
      // slope just ahead is no wall. From a launcher: just off the rail,
      // climbing towards the site.
      let z: number;
      let velocity: Vec3;
      if (pad) {
        z = ground(east, north) + LAUNCH.height;
        velocity = scale(
          [
            heading[0] * Math.cos(LAUNCH.pitch),
            heading[1] * Math.cos(LAUNCH.pitch),
            Math.sin(LAUNCH.pitch),
          ],
          group.speed,
        );
      } else {
        let top = -Infinity;
        for (let d = 0; d <= SPAWN_CLEAR; d += 100)
          top = Math.max(
            top,
            ground(east + heading[0] * d, north + heading[1] * d),
          );
        z = top + group.cruise;
        velocity = scale(heading, group.speed);
      }
      game.pending.push({
        at:
          game.time +
          (group.delay ?? 0) +
          (group.formation ? 0 : i * group.interval),
        threat: {
          id: game.nextId++,
          kind: group.kind ?? "attack",
          launcher: group.launcher,
          passed: false,
          slot: [-Math.cos(bearing) * abreast, Math.sin(bearing) * abreast, 0],
          position: [east, north, z],
          velocity,
          speed: group.speed,
          cruise: group.cruise,
          weave: group.weave * RAD,
          phase: group.formation ? swarmPhase : random(game) * Math.PI * 2,
          age: 0,
          diving: false,
          alive: true,
          groundAhead: z - group.cruise,
          sampleIn: 0,
        },
      });
    }
  }
  game.pending.sort((a, b) => a.at - b.at);
  events.push({ kind: "wave", index: game.wave });
}

/**
 * One drone for `h` seconds: what it hit, if anything. Attack, jet and low
 * drones follow the terrain to the site and dive onto it; decoys pass over
 * it and leave; hunters go for the interceptor at `player` (or, with no
 * player, fly at the site like the rest).
 */
export function stepThreat(
  t: Threat,
  site: Vec3,
  ground: GroundFn,
  h: number,
  player?: Vec3,
): "impact" | "crash" | "player" | "gone" | null {
  t.age += h;
  const kind = KINDS[t.kind];
  const hunting = t.kind === "hunter" && player !== undefined;
  const goal = hunting ? player : site;
  const toGoal = sub(goal, t.position);
  const horizontal = Math.hypot(toGoal[0], toGoal[1]);
  // Swarms cruise for their slot beside the site, keeping their spacing.
  const toSlot = hunting ? toGoal : sub(add(site, t.slot), t.position);
  const heading = normalize(t.velocity);
  // Dives once close, and only with a clear line down to the site (not into a ridge).
  if (
    !hunting &&
    t.kind !== "decoy" &&
    !t.diving &&
    horizontal < kind.diveRange &&
    t.sampleIn <= h &&
    lineOfSight(t.position, site, ground, 30)
  )
    t.diving = true;
  if (t.kind === "decoy" && !t.passed && horizontal < kind.diveRange)
    t.passed = true;
  const terminal = hunting && length(toGoal) < HUNTER_TERMINAL;
  let desired: Vec3;
  let speed = t.speed;
  if (t.diving || terminal) {
    desired = normalize(toGoal);
    speed *= THREAT.diveSpeedUp;
  } else {
    t.sampleIn -= h;
    if (t.sampleIn <= 0) {
      t.sampleIn = 0.25;
      const flat = normalize([heading[0], heading[1], 0]);
      t.groundAhead = Math.max(
        ...THREAT.lookahead.map((d) =>
          ground(t.position[0] + flat[0] * d, t.position[1] + flat[1] * d),
        ),
      );
    }
    let bearing: number;
    if (t.passed) {
      // A decoy keeps going the way it was flying.
      bearing = Math.atan2(heading[0], heading[1]);
    } else {
      // Weaving fades out on the run in, so the dive starts lined up.
      const fade = Math.max(
        0,
        Math.min(1, (horizontal - kind.diveRange) / 1500),
      );
      bearing =
        Math.atan2(toSlot[0], toSlot[1]) +
        t.weave * fade * Math.sin(t.phase + t.age * 0.35);
    }
    // Hunters climb to the interceptor's height when it is above the ground they follow.
    const cruiseAt = Math.max(
      t.groundAhead + t.cruise,
      hunting ? player[2] : -Infinity,
    );
    const climb = Math.max(
      -THREAT.climb,
      Math.min(THREAT.climb, (cruiseAt - t.position[2]) * 0.8),
    );
    const level = Math.sqrt(Math.max(0, speed * speed - climb * climb));
    desired = normalize([
      Math.sin(bearing) * level,
      Math.cos(bearing) * level,
      climb,
    ]);
  }
  const direction = rotateToward(
    heading,
    desired,
    (t.diving || terminal ? kind.diveTurnRate : kind.turnRate) * h,
  );
  t.velocity = scale(direction, speed);
  t.position = add(t.position, scale(t.velocity, h));
  if (hunting && length(sub(player, t.position)) < HUNTER_REACH)
    return "player";
  if (
    !hunting &&
    t.kind !== "decoy" &&
    length(sub(site, t.position)) < THREAT.impact
  )
    return "impact";
  if (
    t.passed &&
    Math.hypot(t.position[0] - site[0], t.position[1] - site[1]) > DECOY_EXIT
  )
    return "gone";
  if (t.position[2] < ground(t.position[0], t.position[1]) + 0.5)
    return "crash";
  return null;
}

/** Steering for a missile closing on a target: proportional navigation, lateral only, limited. */
export function guidance(
  position: Vec3,
  velocity: Vec3,
  targetPosition: Vec3,
  targetVelocity: Vec3,
): Vec3 {
  const r = sub(targetPosition, position);
  const vr = sub(targetVelocity, velocity);
  const r2 = Math.max(dot(r, r), 1);
  const omega = scale(cross(r, vr), 1 / r2);
  // Closing speed; a target pulling away still gets steered at.
  const closing = Math.max(-dot(r, vr) / Math.sqrt(r2), 50);
  let command = add(
    scale(cross(omega, normalize(r)), MISSILE.navigation * closing),
    [0, 0, G],
  );
  const dir = normalize(velocity);
  command = sub(command, scale(dir, dot(command, dir)));
  const size = length(command);
  return size > MISSILE.maxAccel
    ? scale(command, MISSILE.maxAccel / size)
    : command;
}

/** One missile for `h` seconds. */
export function stepMissile(
  m: Missile,
  target: { position: Vec3; velocity: Vec3; alive: boolean } | null,
  h: number,
) {
  m.age += h;
  const speed = Math.max(length(m.velocity), 1);
  const dir = scale(m.velocity, 1 / speed);
  let accel: Vec3 = [0, 0, -G];
  if (m.age < MISSILE.burn) accel = add(accel, scale(dir, MISSILE.thrust));
  accel = sub(accel, scale(dir, MISSILE.drag * speed * speed));
  if (target && target.alive)
    accel = add(
      accel,
      guidance(m.position, m.velocity, target.position, target.velocity),
    );
  m.velocity = add(m.velocity, scale(accel, h));
  m.position = add(m.position, scale(m.velocity, h));
}

/**
 * Launch a missile from `from` (the carrier moving at `carrier`) along
 * `forward`, steering for `target` if there is a lock. Null when the
 * magazine is empty, the launcher is cycling, or the game is over.
 */
export function fire(
  game: StrikeGame,
  from: Vec3,
  carrier: Vec3,
  forward: Vec3,
  target: number | null,
): Missile | null {
  if (
    game.magazine <= 0 ||
    game.cooldown > 0 ||
    game.phase === "won" ||
    game.phase === "lost"
  )
    return null;
  game.magazine -= 1;
  game.cooldown = FIRE_INTERVAL;
  return addMissile(game, from, carrier, forward, target);
}

/**
 * Put a missile in the air with no magazine or cycle checks: for a shooter
 * that keeps its own (the F-14). `launcher` makes it steer for that launcher.
 */
export function addMissile(
  game: StrikeGame,
  from: Vec3,
  carrier: Vec3,
  forward: Vec3,
  target: number | null,
  launcher?: number,
  warhead?: number,
): Missile {
  const missile: Missile = {
    id: game.nextId++,
    position: [...from],
    velocity: add(carrier, scale(normalize(forward), MISSILE.launchSpeed)),
    target,
    launcher,
    warhead,
    age: 0,
    alive: true,
  };
  game.missiles.push(missile);
  game.fired += 1;
  return missile;
}

/** Where to aim at launcher `index`: its middle, above the ground. */
export function launcherPosition(
  game: StrikeGame,
  index: number,
  ground: GroundFn,
): Vec3 {
  const [east, north] = game.spec.launchers![index];
  return [east, north, ground(east, north) + LAUNCHER.height];
}

/** Wear launcher `index` down by `amount`; destroyed, its drones still to come are cancelled. */
function damageLauncher(
  game: StrikeGame,
  index: number,
  amount: number,
  at: Vec3,
  events: StrikeEvent[],
) {
  const launcher = game.launchers[index];
  if (!launcher.alive) return;
  launcher.health = Math.max(0, launcher.health - amount);
  events.push({ kind: "launcher-hit", index, at, healthLeft: launcher.health });
  if (launcher.health > 0) return;
  launcher.alive = false;
  game.pending = game.pending.filter((p) => p.threat.launcher !== index);
  events.push({ kind: "launcher-down", index, at });
}

/** Whether any drones are still to come in later waves (from launchers still standing, or the ring). */
function dronesToCome(game: StrikeGame) {
  return game.spec.waves
    .slice(game.wave + 1)
    .some((wave) =>
      wave.groups.some(
        (g) =>
          g.launcher === undefined ||
          game.launchers[g.launcher]?.alive !== false,
      ),
    );
}

/** A drone destroyed by a missile's burst or the gun. */
function destroy(
  game: StrikeGame,
  t: Threat,
  by: "missile" | "gun",
  events: StrikeEvent[],
) {
  t.alive = false;
  const points = KINDS[t.kind].points;
  if (t.kind === "decoy") {
    game.decoysHit += 1;
  } else {
    game.kills += 1;
    if (by === "missile") game.missileKills += 1;
  }
  game.points += points;
  events.push({
    kind: "kill",
    at: t.position,
    velocity: t.velocity,
    threat: t.id,
    type: t.kind,
    points,
    by,
  });
}

function burst(
  game: StrikeGame,
  at: Vec3,
  ground: boolean,
  events: StrikeEvent[],
  pads: Vec3[],
  warhead: number = LAUNCHER.missile,
) {
  events.push({ kind: "burst", at, ground });
  for (const t of game.threats)
    if (t.alive && length(sub(t.position, at)) <= MISSILE.blast)
      destroy(game, t, "missile", events);
  let hurt = false;
  pads.forEach((pad, i) => {
    if (game.launchers[i].alive && length(sub(pad, at)) <= LAUNCHER.blast) {
      damageLauncher(game, i, warhead, pad, events);
      hurt = true;
    }
  });
  if (hurt) game.launcherMissileHits += 1;
}

/**
 * Fire one gun round from `from` (the carrier moving at `carrier`) along
 * `forward`, strayed by up to `spread` radians. Null when out of rounds,
 * between rounds, or the game is over.
 */
export function shoot(
  game: StrikeGame,
  from: Vec3,
  carrier: Vec3,
  forward: Vec3,
  spread: number = GUN.spread,
): Round | null {
  if (
    game.ammo <= 0 ||
    game.gunCooldown > 0 ||
    game.phase === "won" ||
    game.phase === "lost"
  )
    return null;
  game.ammo -= 1;
  game.gunCooldown = 1 / GUN.rate;
  return addRound(game, from, carrier, forward, spread);
}

/** Fire one round with no ammunition or rate checks: for a shooter that keeps its own (the F-14). */
export function addRound(
  game: StrikeGame,
  from: Vec3,
  carrier: Vec3,
  forward: Vec3,
  spread: number = GUN.spread,
): Round {
  const f = normalize(forward);
  // Stray within a cone: two directions across the line of fire.
  const across = normalize(
    Math.abs(f[2]) < 0.95 ? cross(f, [0, 0, 1]) : cross(f, [1, 0, 0]),
  );
  const up = cross(across, f);
  const a = (random(game) * 2 - 1) * spread;
  const b = (random(game) * 2 - 1) * spread;
  const dir = normalize(add(f, add(scale(across, a), scale(up, b))));
  const round: Round = {
    position: [...from],
    velocity: add(carrier, scale(dir, GUN.speed)),
    age: 0,
    alive: true,
  };
  game.rounds.push(round);
  return round;
}

/** Closest a point comes to the segment a→b. */
function segmentDistance(a: Vec3, b: Vec3, p: Vec3) {
  const ab = sub(b, a);
  const t = Math.max(
    0,
    Math.min(1, dot(sub(p, a), ab) / Math.max(dot(ab, ab), 1e-9)),
  );
  return length(sub(p, add(a, scale(ab, t))));
}

/**
 * Where to aim a gun to hit a target: its position when a round fired now
 * would get there, raised for the drop. Rounds leave at `speed` on top of
 * the shooter's velocity, so the target's motion counts relative to it.
 */
export function leadPoint(
  from: Vec3,
  shooterVelocity: Vec3,
  target: Vec3,
  targetVelocity: Vec3,
  speed: number = GUN.speed,
): { point: Vec3; time: number } {
  const relative = sub(targetVelocity, shooterVelocity);
  let time = length(sub(target, from)) / speed;
  let point: Vec3 = target;
  for (let i = 0; i < 4; i++) {
    point = add(add(target, scale(relative, time)), [
      0,
      0,
      0.5 * G * time * time,
    ]);
    time = length(sub(point, from)) / speed;
  }
  return { point, time };
}

/** Advance the game by `dt` seconds (in small steps). `player` is the interceptor, for hunters. */
export function stepStrike(
  game: StrikeGame,
  ground: GroundFn,
  dt: number,
  player?: Vec3,
): StrikeEvent[] {
  const events: StrikeEvent[] = [];
  let left = dt;
  while (left > 1e-9) {
    const h = Math.min(SUBSTEP, left);
    left -= h;
    step(game, ground, h, events, player);
  }
  return events;
}

function lose(
  game: StrikeGame,
  by: "site" | "interceptor",
  events: StrikeEvent[],
) {
  if (game.phase === "lost") return;
  game.phase = "lost";
  game.lostBy = by;
  game.pending = [];
  events.push({ kind: "lost" });
}

function step(
  game: StrikeGame,
  ground: GroundFn,
  h: number,
  events: StrikeEvent[],
  player?: Vec3,
) {
  game.time += h;
  game.cooldown = Math.max(0, game.cooldown - h);
  game.gunCooldown = Math.max(0, game.gunCooldown - h);
  const over = game.phase === "won" || game.phase === "lost";

  if (game.phase === "break") {
    game.breakLeft -= h;
    if (game.breakLeft <= 0) startWave(game, ground, events);
  }
  while (!over && game.pending.length && game.pending[0].at <= game.time)
    game.threats.push(game.pending.shift()!.threat);

  if (!over) {
    for (const t of game.threats) {
      if (!t.alive) continue;
      const result = stepThreat(t, game.spec.site, ground, h, player);
      if (!result) continue;
      t.alive = false;
      if (result === "gone") continue;
      if (result === "player") {
        game.damage += 1;
        const allowed = game.spec.playerHits ?? PLAYER_HITS;
        events.push({
          kind: "player-hit",
          at: t.position,
          hitsLeft: Math.max(0, allowed - game.damage),
        });
        if (game.damage >= allowed) lose(game, "interceptor", events);
        continue;
      }
      const onSite =
        t.kind !== "decoy" &&
        (result === "impact" ||
          Math.hypot(
            t.position[0] - game.spec.site[0],
            t.position[1] - game.spec.site[1],
          ) < game.spec.siteRadius);
      if (onSite) {
        game.hits += 1;
        events.push({
          kind: "site-hit",
          at: t.position,
          hitsLeft: Math.max(0, game.spec.hitsAllowed - game.hits),
        });
        if (game.hits >= game.spec.hitsAllowed) lose(game, "site", events);
      } else {
        events.push({ kind: "crash", at: t.position, threat: t.id });
      }
    }
  }

  const pads = game.launchers.map((_, i) => launcherPosition(game, i, ground));
  for (const m of game.missiles) {
    if (!m.alive) continue;
    const pad = m.launcher === undefined ? null : pads[m.launcher];
    const target = pad
      ? {
          position: pad,
          velocity: [0, 0, 0] as Vec3,
          alive: game.launchers[m.launcher!].alive,
        }
      : m.target === null
        ? null
        : (game.threats.find((t) => t.id === m.target) ?? null);
    stepMissile(m, target, h);
    if (
      m.age > MISSILE.arm &&
      ((pad && length(sub(pad, m.position)) < MISSILE.fuse) ||
        game.threats.some(
          (t) => t.alive && length(sub(t.position, m.position)) < MISSILE.fuse,
        ))
    ) {
      m.alive = false;
      burst(game, m.position, false, events, pads, m.warhead);
    } else if (m.position[2] < ground(m.position[0], m.position[1])) {
      m.alive = false;
      burst(game, m.position, true, events, pads, m.warhead);
    } else if (m.age > MISSILE.life) {
      m.alive = false;
      events.push({ kind: "burst", at: m.position, ground: false });
    }
  }
  for (const r of game.rounds) {
    if (!r.alive) continue;
    const from = r.position;
    r.velocity = [r.velocity[0], r.velocity[1], r.velocity[2] - G * h];
    r.position = add(r.position, scale(r.velocity, h));
    r.age += h;
    const hit = game.threats.find(
      (t) =>
        t.alive &&
        segmentDistance(from, r.position, t.position) < GUN.hitRadius,
    );
    const pad = hit
      ? -1
      : pads.findIndex(
          (p, i) =>
            game.launchers[i].alive &&
            segmentDistance(from, r.position, p) < LAUNCHER.hitRadius,
        );
    if (hit) {
      r.alive = false;
      destroy(game, hit, "gun", events);
    } else if (pad >= 0) {
      r.alive = false;
      damageLauncher(game, pad, LAUNCHER.round, pads[pad], events);
    } else if (
      r.age > GUN.life ||
      r.position[2] < ground(r.position[0], r.position[1])
    ) {
      r.alive = false;
    }
  }
  game.rounds = game.rounds.filter((r) => r.alive);
  game.missiles = game.missiles.filter((m) => m.alive);
  game.threats = game.threats.filter((t) => t.alive);

  // A wave is clear when nothing is left in it; the game is won when no more
  // drones can come (the last wave is done, or every launcher still needed is down).
  if (
    (game.phase === "wave" || game.phase === "break") &&
    game.pending.length === 0 &&
    game.threats.length === 0
  ) {
    if (game.phase === "wave")
      events.push({ kind: "wave-clear", index: game.wave });
    if (!dronesToCome(game)) {
      game.phase = "won";
      events.push({ kind: "won" });
    } else if (game.phase === "wave") {
      game.phase = "break";
      game.breakLeft = game.spec.breakTime;
    }
  }
}

/* Lock-on ----------------------------------------------------------------- */

export interface Lock {
  target: number | null;
  /** 0–1 towards a lock. */
  progress: number;
  locked: boolean;
}

export const newLock = (): Lock => ({
  target: null,
  progress: 0,
  locked: false,
});

/** Whether the ground is out of the way between two points, sampled every `step` metres. */
export function lineOfSight(
  a: Vec3,
  b: Vec3,
  ground: GroundFn,
  step = 60,
): boolean {
  const d = sub(b, a);
  const n = Math.ceil(length(d) / step);
  for (let i = 1; i < n; i++) {
    const p = add(a, scale(d, i / n));
    if (ground(p[0], p[1]) > p[2]) return false;
  }
  return true;
}

const angleTo = (eye: Vec3, forward: Vec3, p: Vec3) => {
  const to = sub(p, eye);
  const d = length(to);
  return {
    angle: Math.acos(
      Math.max(-1, Math.min(1, dot(to, forward) / Math.max(d, 1e-9))),
    ),
    distance: d,
  };
};

/**
 * Keep or build a lock on the drone nearest the crosshair: a drone within
 * the cone, in range and in sight starts it, it builds over LOCK.time while
 * the drone stays within the wider keep cone, and it is lost or moves to
 * another drone otherwise. `forward` is a unit vector.
 */
export function stepLock(
  lock: Lock,
  eye: Vec3,
  forward: Vec3,
  threats: { id: number; position: Vec3; alive: boolean }[],
  dt: number,
  ground: GroundFn,
  range: number = LOCK.range,
) {
  const usable = (t: (typeof threats)[number], cone: number) => {
    if (!t.alive) return null;
    const { angle, distance } = angleTo(eye, forward, t.position);
    if (angle > cone || distance > range) return null;
    return lineOfSight(eye, t.position, ground) ? angle : null;
  };
  const current = threats.find((t) => t.id === lock.target);
  if (current && usable(current, LOCK.keep) !== null) {
    lock.progress = Math.min(1, lock.progress + dt / LOCK.time);
  } else {
    let best: { id: number; angle: number } | null = null;
    for (const t of threats) {
      const angle = usable(t, LOCK.cone);
      if (angle !== null && (!best || angle < best.angle))
        best = { id: t.id, angle };
    }
    lock.target = best?.id ?? null;
    lock.progress = best ? Math.min(1, dt / LOCK.time) : 0;
  }
  lock.locked = lock.target !== null && lock.progress >= 1;
}

/* Score ------------------------------------------------------------------- */

export interface StrikeScore {
  kills: number;
  site: number;
  accuracy: number;
  total: number;
}

/** Each drone's points (KINDS), up to 1000 for the site intact, up to 500 for real drones downed per missile. */
export function scoreStrike(game: StrikeGame): StrikeScore {
  const kills = game.points;
  const site = Math.round(
    (Math.max(0, game.spec.hitsAllowed - game.hits) / game.spec.hitsAllowed) *
      1000,
  );
  const accuracy =
    game.fired > 0
      ? Math.round(
          Math.min(
            1,
            (game.missileKills + game.launcherMissileHits) / game.fired,
          ) * 500,
        )
      : 0;
  return { kills, site, accuracy, total: kills + site + accuracy };
}

export type StrikeMedal = "gold" | "silver" | "bronze" | null;

export function strikeMedal(
  total: number,
  medals: { gold: number; silver: number; bronze: number },
): StrikeMedal {
  if (total >= medals.gold) return "gold";
  if (total >= medals.silver) return "silver";
  if (total >= medals.bronze) return "bronze";
  return null;
}
