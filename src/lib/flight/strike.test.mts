/** pnpm test — drone defence: guidance, lock-on, terrain-following drones and waves. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DECOY_REVEAL,
  fire,
  GUN,
  KINDS,
  LOCK,
  leadPoint,
  lineOfSight,
  MISSILE,
  type Missile,
  maxScore,
  newLock,
  newStrike,
  rotateToward,
  type StrikeSpec,
  scoreStrike,
  shoot,
  stepLock,
  stepMissile,
  stepStrike,
  stepThreat,
  strikeMedal,
  type Threat,
  threatsLeft,
  totalThreats,
} from "./strike.ts";
import { length, sub, type Vec3 } from "./vec.ts";

const flat = () => 0;

const threat = (
  position: Vec3,
  velocity: Vec3,
  cruise = 100,
  kind: Threat["kind"] = "attack",
): Threat => ({
  id: 1,
  kind,
  passed: false,
  slot: [0, 0, 0],
  position,
  velocity,
  speed: Math.hypot(...velocity),
  cruise,
  weave: 0,
  phase: 0,
  age: 0,
  diving: false,
  alive: true,
  groundAhead: 0,
  sampleIn: 0,
});

/** Fly a missile at a drone moving in a straight line; the closest it got. */
function chase(guided: boolean, target: Threat, from: Vec3, aim: Vec3) {
  const m: Missile = {
    id: 2,
    position: from,
    velocity: aim,
    target: guided ? 1 : null,
    age: 0,
    alive: true,
  };
  let closest = Infinity;
  for (let t = 0; t < MISSILE.life; t += 1 / 120) {
    stepMissile(m, guided ? target : null, 1 / 120);
    target.position = [
      target.position[0] + target.velocity[0] / 120,
      target.position[1] + target.velocity[1] / 120,
      target.position[2],
    ];
    closest = Math.min(closest, length(sub(m.position, target.position)));
  }
  return closest;
}

test("missile: proportional navigation catches a crossing drone that a straight shot misses", () => {
  // A drone 2 km ahead, crossing left to right at 50 m/s, 150 m up.
  const make = () => threat([0, 2000, 150], [50, 0, 0]);
  const aim: Vec3 = [0, MISSILE.launchSpeed, 0];
  assert.ok(
    chase(true, make(), [0, 0, 150], aim) < MISSILE.fuse,
    "guided gets within the fuse",
  );
  assert.ok(
    chase(false, make(), [0, 0, 150], aim) > 100,
    "unguided misses by a long way",
  );
});

test("missile: catches a drone flying away, and a diving one", () => {
  assert.ok(
    chase(true, threat([300, 1500, 200], [0, 55, 0]), [0, 0, 150], [0, 40, 0]) <
      MISSILE.fuse,
  );
  assert.ok(
    chase(true, threat([0, 1200, 400], [0, 20, -40]), [0, 0, 150], [0, 40, 5]) <
      MISSILE.fuse,
  );
});

test("rotateToward: turns by at most the limit, and lands on the target within it", () => {
  const out = rotateToward([1, 0, 0], [0, 1, 0], 0.1);
  assert.ok(Math.abs(Math.acos(out[0]) - 0.1) < 1e-9);
  assert.deepEqual(
    rotateToward([1, 0, 0], [0.99, 0.141, 0], 0.5),
    [0.99, 0.141, 0],
  );
  // Straight back still turns (no NaN from a zero cross product).
  assert.ok(rotateToward([1, 0, 0], [-1, 0, 0], 0.2).every(Number.isFinite));
});

test("drone: follows the terrain over a ridge and dives onto the site", () => {
  // A 400 m ridge 3 km out from the site, between the drone and it.
  const ground = (_e: number, n: number) =>
    Math.max(0, 400 - Math.abs(n - 3000) * 0.5);
  const t = threat([0, 6000, 100], [0, -50, 0], 100);
  const site: Vec3 = [0, 0, 10];
  let lowest = Infinity;
  let result: string | null = null;
  for (let s = 0; s < 400 && !result; s += 1 / 120) {
    result = stepThreat(t, site, ground, 1 / 120);
    if (!t.diving)
      lowest = Math.min(
        lowest,
        t.position[2] - ground(t.position[0], t.position[1]),
      );
  }
  assert.equal(result, "impact");
  assert.ok(
    lowest > 30,
    `kept clear of the ground (lowest ${lowest.toFixed(0)} m)`,
  );
});

test("lock: builds over LOCK.time on a drone near the crosshair, not off it or behind a hill", () => {
  const t = threat([0, 2000, 100], [0, 0, 0]);
  const lock = newLock();
  const eye: Vec3 = [0, 0, 100];
  for (let i = 0; i < 10; i++)
    stepLock(lock, eye, [0, 1, 0], [t], LOCK.time / 12, flat);
  assert.equal(lock.target, 1);
  assert.equal(lock.locked, false);
  for (let i = 0; i < 3; i++)
    stepLock(lock, eye, [0, 1, 0], [t], LOCK.time / 12, flat);
  assert.equal(lock.locked, true);

  // Looking 30° away loses it.
  stepLock(lock, eye, [Math.sin(0.52), Math.cos(0.52), 0], [t], 0.1, flat);
  assert.equal(lock.target, null);
  assert.equal(lock.locked, false);

  // A hill in between: no lock.
  const hill = (_e: number, n: number) => (Math.abs(n - 1000) < 100 ? 300 : 0);
  const blocked = newLock();
  stepLock(blocked, eye, [0, 1, 0], [t], 0.1, hill);
  assert.equal(blocked.target, null);
  assert.equal(lineOfSight(eye, t.position, hill), false);
});

const spec: StrikeSpec = {
  site: [0, 0, 10],
  siteRadius: 60,
  spawnDistance: 3000,
  waves: [
    {
      groups: [
        {
          from: 0,
          spread: 0,
          count: 2,
          interval: 2,
          speed: 50,
          cruise: 80,
          weave: 0,
        },
      ],
    },
    {
      groups: [
        {
          from: 90,
          spread: 10,
          count: 3,
          interval: 1,
          speed: 50,
          cruise: 80,
          weave: 10,
        },
      ],
    },
  ],
  hitsAllowed: 3,
  magazine: 4,
  firstBreak: 3,
  breakTime: 5,
};

test("game: waves start after the break, drones appear in turn and reaching the site costs hits", () => {
  const game = newStrike(spec);
  assert.equal(totalThreats(spec), 5);
  let events = stepStrike(game, flat, 3.05);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["wave"],
  );
  assert.equal(game.threats.length, 1);
  assert.equal(threatsLeft(game), 2);
  stepStrike(game, flat, 2);
  assert.equal(game.threats.length, 2);

  // Left alone, both reach the site: two hits, then a break and wave 2.
  const kinds: string[] = [];
  for (let s = 0; s < 200 && !kinds.includes("wave-clear"); s++)
    kinds.push(...stepStrike(game, flat, 1).map((e) => e.kind));
  assert.equal(kinds.filter((k) => k === "site-hit").length, 2);
  assert.ok(kinds.includes("wave-clear"));
  assert.equal(game.hits, 2);
  // Wave 2 has three drones: the third hit loses the site.
  events = stepStrike(game, flat, 200);
  assert.ok(events.some((e) => e.kind === "lost"));
  assert.equal(game.phase, "lost");
});

test("game: missiles destroy drones, and clearing the last wave wins", () => {
  const game = newStrike({ ...spec, waves: [spec.waves[0]] });
  stepStrike(game, flat, 5.2);
  assert.equal(game.threats.length, 2);
  let won = false;
  let guard = 0;
  while (game.phase === "wave" && guard++ < 4000) {
    const target = game.threats[0];
    if (target && game.cooldown === 0) {
      const from: Vec3 = [0, 0, 120];
      fire(game, from, [0, 0, 0], sub(target.position, from), target.id);
    }
    won = stepStrike(game, flat, 1 / 30).some((e) => e.kind === "won") || won;
  }
  assert.ok(won, "won");
  assert.equal(game.kills, 2);
  assert.equal(game.hits, 0);
  const score = scoreStrike(game);
  assert.equal(score.kills, 200);
  assert.equal(score.site, 1000);
  assert.ok(score.accuracy > 0 && score.accuracy <= 500);
  assert.equal(
    strikeMedal(score.total, { gold: 1600, silver: 1400, bronze: 1200 }),
    score.total >= 1600 ? "gold" : "silver",
  );
});

test("fire: limited by the magazine and the launcher's cycle, refilled each wave", () => {
  const game = newStrike(spec);
  const shoot = () => fire(game, [0, 0, 100], [0, 0, 0], [0, 1, 0], null);
  assert.ok(shoot());
  assert.equal(shoot(), null, "still cycling");
  for (let i = 0; i < 3; i++) {
    stepStrike(game, flat, 0.6);
    assert.ok(shoot());
  }
  stepStrike(game, flat, 0.6);
  assert.equal(game.magazine, 0);
  assert.equal(shoot(), null, "empty");
  stepStrike(game, flat, 2);
  assert.equal(game.magazine, spec.magazine, "the first wave refills it");
});

test("decoy: passes over the site and leaves, never diving onto it", () => {
  const t = threat([0, 4000, 100], [0, -50, 0], 100, "decoy");
  let result: string | null = null;
  for (let s = 0; s < 300 && !result; s += 1 / 120)
    result = stepThreat(t, [0, 0, 10], flat, 1 / 120);
  assert.equal(result, "gone");
  assert.ok(t.position[1] < -2000, "carried on past the site");
  assert.ok(DECOY_REVEAL > 0);
});

test("hunter: goes for the interceptor, not the site", () => {
  const t = threat([0, 3000, 100], [0, -60, 0], 100, "hunter");
  const player: Vec3 = [1500, 0, 400];
  let result: string | null = null;
  for (let s = 0; s < 200 && !result; s += 1 / 120)
    result = stepThreat(t, [0, 0, 10], flat, 1 / 120, player);
  assert.equal(result, "player");
});

test("game: a swarm appears together, abreast; hunters wear the interceptor down until it is lost", () => {
  const swarm: StrikeSpec = {
    ...spec,
    waves: [
      {
        groups: [
          {
            from: 0,
            spread: 0,
            count: 3,
            interval: 5,
            speed: 50,
            cruise: 80,
            weave: 0,
            formation: 20,
          },
        ],
      },
    ],
  };
  const game = newStrike(swarm);
  stepStrike(game, flat, 3.02);
  assert.equal(game.threats.length, 3, "all at once");
  const xs = game.threats.map((t) => t.position[0]).sort((a, b) => a - b);
  assert.ok(
    Math.abs(xs[1] - xs[0] - 20) < 1e-6 && Math.abs(xs[2] - xs[1] - 20) < 1e-6,
    `abreast ${xs}`,
  );

  const hunters: StrikeSpec = {
    ...spec,
    playerHits: 2,
    waves: [
      {
        groups: [
          {
            from: 0,
            spread: 20,
            count: 3,
            interval: 3,
            speed: 60,
            cruise: 80,
            weave: 0,
            kind: "hunter",
          },
        ],
      },
    ],
  };
  const g = newStrike(hunters);
  const player: Vec3 = [0, 0, 300];
  const kinds: string[] = [];
  for (let s = 0; s < 300 && g.phase !== "lost"; s++)
    kinds.push(...stepStrike(g, flat, 1, player).map((e) => e.kind));
  assert.equal(kinds.filter((k) => k === "player-hit").length, 2);
  assert.equal(g.phase, "lost");
  assert.equal(g.lostBy, "interceptor");
  assert.equal(g.hits, 0, "hunters leave the site alone");
});

test("score: each kind's points, decoys worth nothing and not counted as kills", () => {
  const mixed: StrikeSpec = {
    ...spec,
    waves: [
      {
        groups: [
          {
            from: 0,
            spread: 0,
            count: 1,
            interval: 1,
            speed: 50,
            cruise: 80,
            weave: 0,
            kind: "jet",
          },
          {
            from: 0,
            spread: 0,
            count: 1,
            interval: 1,
            speed: 50,
            cruise: 80,
            weave: 0,
            kind: "decoy",
          },
        ],
      },
    ],
  };
  assert.equal(totalThreats(mixed), 1);
  assert.equal(maxScore(mixed), KINDS.jet.points + 1500);
  const game = newStrike(mixed);
  stepStrike(game, flat, 3.02);
  assert.equal(game.threats.length, 2);
  // Burst a missile right between them: both go.
  const [a, b] = game.threats;
  b.position = [a.position[0] + 4, a.position[1], a.position[2]];
  game.missiles.push({
    id: 99,
    position: [a.position[0] + 2, a.position[1], a.position[2]],
    velocity: [0, 0, 1],
    target: null,
    age: 1,
    alive: true,
  });
  const kills = stepStrike(game, flat, 1 / 120).filter(
    (e) => e.kind === "kill",
  );
  assert.equal(kills.length, 2);
  assert.equal(game.kills, 1);
  assert.equal(game.decoysHit, 1);
  assert.equal(game.points, KINDS.jet.points);
});

test("gun: a round aimed at the lead point hits a crossing drone; one aimed straight at it misses", () => {
  const run = (lead: boolean) => {
    const game = newStrike({
      ...spec,
      waves: [
        {
          groups: [
            {
              from: 0,
              spread: 0,
              count: 1,
              interval: 1,
              speed: 50,
              cruise: 80,
              weave: 0,
            },
          ],
        },
      ],
    });
    stepStrike(game, flat, 3.01);
    const t = game.threats[0];
    // Put it 600 m ahead, crossing at 50 m/s, and freeze its steering by flying it level and straight.
    t.position = [0, 600, 200];
    t.velocity = [50, 0, 0];
    t.diving = false;
    game.spec.site = [1e6, 600, 200];
    t.cruise = 200;
    const from: Vec3 = [0, 0, 200];
    const aim = lead
      ? leadPoint(from, [0, 0, 0], t.position, t.velocity).point
      : t.position;
    assert.ok(shoot(game, from, [0, 0, 0], sub(aim, from), 0));
    let killed = false;
    for (let i = 0; i < 240 && !killed; i++)
      killed = stepStrike(game, flat, 1 / 120).some(
        (e) => e.kind === "kill" && e.by === "gun",
      );
    return killed;
  };
  assert.equal(run(true), true);
  assert.equal(run(false), false);
});

test("gun: fires at its rate, runs dry, refills each wave; gun kills do not count towards missile accuracy", () => {
  const game = newStrike({ ...spec, rounds: 5 });
  let fired = 0;
  for (let i = 0; i < 120; i++) {
    if (shoot(game, [0, 0, 100], [0, 0, 0], [0, 1, 0.2])) fired++;
    stepStrike(game, flat, 1 / 60);
  }
  assert.equal(fired, 5, "five rounds");
  assert.equal(game.ammo, 0);
  // Wave 1 starts at 3 s and refills.
  stepStrike(game, flat, 2);
  assert.equal(game.ammo, 5);
  assert.ok(1 / GUN.rate < 0.1);
  game.kills = 3;
  game.missileKills = 1;
  game.fired = 2;
  assert.equal(scoreStrike(game).accuracy, 250);
});
