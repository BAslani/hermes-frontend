import type { GroundFn } from "@/lib/flight/contact";
import {
  LAUNCHER,
  launcherPosition,
  lineOfSight,
  MISSILE,
  type StrikeEvent,
  type StrikeGame,
} from "@/lib/flight/strike";
import { Trail } from "@/lib/flight/trail";
import { length, normalize, scale, sub, type Vec3 } from "@/lib/flight/vec";
import { PuffBuffer } from "../three/eye-space";
import {
  MAX_DEBRIS,
  MAX_FIRE_PUFFS,
  MAX_SMOKE_PUFFS,
  MAX_TRACERS,
  MAX_TRAIL_PUFFS,
  type StrikeView,
} from "../three/strike-layer";

/** Seconds an explosion's fire and smoke last. */
const FIRE_LIFE = 1.1;
const SMOKE_LIFE = 7;
/** Pieces flung from a downed drone, and how many of them smoke. */
const PIECES = 9;
const SMOKING_PIECES = 3;
/** Each tracer is drawn as the stretch it flew in the last this long, s (never back past the muzzle). */
const TRACER_LENGTH = 0.03;
/** The line of sight goes to this far above a launcher's aim point, metres: the top of the truck, clear of the ground it stands on. */
const SIGHT_ABOVE = 3;

/** A falling piece of a downed drone. */
interface Piece {
  position: Vec3;
  velocity: Vec3;
  /** Only some pieces trail smoke. */
  trail: Trail | null;
}

/** A hit on the site or a launcher destroyed: smoke rising from it, a fire at its foot. */
interface Column {
  at: Vec3;
  trail: Trail;
}

interface Blast {
  at: Vec3;
  born: number;
  /** Scale of the fireball: 1 for a missile, more for a drone or the site. */
  size: number;
  seed: number;
}

/** A fixed pseudo-random unit-ish vector for puff `i` of blast `seed`. */
function scatter(seed: number, i: number): Vec3 {
  const h = (n: number) => {
    const x = Math.sin(seed * 12.9898 + i * 78.233 + n * 37.719) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  };
  return [h(1), h(2), h(3) * 0.7 + 0.3];
}

/** The part of a strike-layer view that comes from the game: what is drawn, camera-relative. */
export type StrikeWorld = Pick<
  StrikeView,
  | "threats"
  | "debris"
  | "tracers"
  | "missiles"
  | "trails"
  | "smoke"
  | "fire"
  | "site"
  | "launchers"
>;

/**
 * The look of a drone-defence game, shared by everything that flies in one:
 * fireballs, wreckage, smoke columns, missile trails and tracers. Positions
 * are in the game's own frame (metres from the site); the view comes out
 * camera-relative.
 */
export function createStrikeEffects() {
  const trails = new Map<number, Trail>();
  const blasts: Blast[] = [];
  const pieces: Piece[] = [];
  const columns: Column[] = [];
  const trailPuffs = new PuffBuffer(MAX_TRAIL_PUFFS);
  const smokePuffs = new PuffBuffer(MAX_SMOKE_PUFFS);
  const firePuffs = new PuffBuffer(MAX_FIRE_PUFFS);
  const debrisOffsets = new Float32Array(MAX_DEBRIS * 3);
  const tracerOffsets = new Float32Array(MAX_TRACERS * 6);

  /**
   * Whether the camera sees a launcher, its top a few metres above its aim
   * point: the ground sampled along the line at most ~80 times, however far.
   */
  const inSight = (camera: Vec3, at: Vec3, ground: GroundFn) => {
    const top: Vec3 = [at[0], at[1], at[2] + SIGHT_ABOVE];
    return lineOfSight(
      camera,
      top,
      ground,
      Math.max(60, length(sub(top, camera)) / 80),
    );
  };

  /** A column of smoke rising from the ground at `at`. */
  const column = (at: Vec3, ground: GroundFn) =>
    columns.push({
      at: [at[0], at[1], ground(at[0], at[1]) + 2],
      trail: new Trail(22, 0.12, 190),
    });

  return {
    clear() {
      trails.clear();
      blasts.length = 0;
      pieces.length = 0;
      columns.length = 0;
    },

    /** What the game's events look like: fireballs, wreckage flung out, smoke columns. */
    onEvents(events: StrikeEvent[], time: number, ground: GroundFn) {
      for (const e of events) {
        switch (e.kind) {
          case "kill": {
            blasts.push({
              at: e.at,
              born: time,
              size: e.type === "jet" ? 2 : e.type === "hunter" ? 1.1 : 1.6,
              seed: e.threat,
            });
            // The wreck comes apart: pieces flung out, carried on a little by what it was doing.
            const carry = scale(e.velocity, 0.35);
            for (let i = 0; i < PIECES; i++) {
              const d = scatter(e.threat, i + 20);
              pieces.push({
                position: [...e.at],
                velocity: [
                  carry[0] + d[0] * 22,
                  carry[1] + d[1] * 22,
                  carry[2] + Math.abs(d[2]) * 14 + 4,
                ],
                trail: i < SMOKING_PIECES ? new Trail(2.5, 0.04, 70) : null,
              });
            }
            break;
          }
          case "player-hit":
            blasts.push({ at: e.at, born: time, size: 1.2, seed: time * 1000 });
            break;
          case "burst":
            blasts.push({
              at: e.at,
              born: time,
              size: e.ground ? 1.2 : 0.8,
              seed: time * 1000,
            });
            break;
          case "crash":
            blasts.push({ at: e.at, born: time, size: 1.2, seed: e.threat });
            break;
          case "site-hit":
            blasts.push({ at: e.at, born: time, size: 3.5, seed: time * 1000 });
            column(e.at, ground);
            break;
          case "launcher-down":
            blasts.push({
              at: e.at,
              born: time,
              size: 3,
              seed: e.index + 300,
            });
            column(e.at, ground);
            break;
        }
      }
    },

    /** Debris falls, smoking pieces trail, and pieces that reach the ground are gone. */
    step(dt: number, time: number, ground: GroundFn) {
      for (let i = pieces.length - 1; i >= 0; i--) {
        const piece = pieces[i];
        const v = piece.velocity;
        const drag = 1 - Math.min(1, 0.25 * dt);
        piece.velocity = [v[0] * drag, v[1] * drag, (v[2] - 9.81 * dt) * drag];
        piece.position = [
          piece.position[0] + piece.velocity[0] * dt,
          piece.position[1] + piece.velocity[1] * dt,
          piece.position[2] + piece.velocity[2] * dt,
        ];
        piece.trail?.emit(time, piece.position, [0, 0, 0]);
        if (piece.position[2] < ground(piece.position[0], piece.position[1]))
          pieces.splice(i, 1);
      }
    },

    /** Everything the game draws this frame, relative to `camera` (in the game's frame). */
    view(game: StrikeGame, camera: Vec3, ground: GroundFn): StrikeWorld {
      const now = game.time;
      trailPuffs.clear();
      smokePuffs.clear();
      firePuffs.clear();
      const rel = (p: Vec3) => sub(p, camera);
      for (const m of game.missiles) {
        const dir = normalize(m.velocity);
        const tail = sub(m.position, scale(dir, 1));
        let trail = trails.get(m.id);
        if (!trail) {
          trail = new Trail(5, 0.025, 260);
          trails.set(m.id, trail);
        }
        // Smoke for the whole flight, not just the 2.8 s burn, so a missile can
        // be followed all the way to its target. The motor glows only while it burns.
        trail.emit(now, tail, [0, 0, 0]);
        if (m.age < MISSILE.burn) firePuffs.put(rel(tail), 0.12);
      }
      for (const [id, trail] of trails) {
        const live = trail.live(now);
        if (!live.length && !game.missiles.some((m) => m.id === id)) {
          trails.delete(id);
          continue;
        }
        for (const puff of live) trailPuffs.put(rel(puff.position), puff.age);
      }
      for (const piece of pieces)
        if (piece.trail)
          for (const puff of piece.trail.live(now))
            trailPuffs.put(rel(puff.position), puff.age);
      // Smoke columns, leaning with a light breeze, a fire flickering at each foot.
      columns.forEach((c, n) => {
        c.trail.emit(now, c.at, [1.6, 0.9, 4.5]);
        for (const puff of c.trail.live(now))
          smokePuffs.put(rel(puff.position), 0.15 + puff.age * 0.85);
        for (let i = 0; i < 4; i++) {
          const d = scatter(n + 50, i);
          const flicker = 0.25 + 0.2 * Math.sin(now * 11 + i * 1.7 + n);
          firePuffs.put(
            rel([
              c.at[0] + d[0] * 4,
              c.at[1] + d[1] * 4,
              c.at[2] + Math.abs(d[2]) * 3,
            ]),
            flicker,
          );
        }
      });
      for (let b = blasts.length - 1; b >= 0; b--) {
        const blast = blasts[b];
        const t = now - blast.born;
        if (t > SMOKE_LIFE) {
          blasts.splice(b, 1);
          continue;
        }
        if (t < FIRE_LIFE) {
          for (let i = 0; i < 10; i++) {
            const d = scatter(blast.seed, i);
            const r = blast.size * 5 * Math.sqrt(t / FIRE_LIFE);
            firePuffs.put(
              rel([
                blast.at[0] + d[0] * r,
                blast.at[1] + d[1] * r,
                blast.at[2] + d[2] * r,
              ]),
              t / FIRE_LIFE,
            );
          }
        }
        for (let i = 0; i < 12; i++) {
          const born = i * 0.05;
          if (t < born) continue;
          const d = scatter(blast.seed + 7, i);
          const age = (t - born) / SMOKE_LIFE;
          const r = blast.size * (3 + 9 * Math.sqrt(age));
          smokePuffs.put(
            rel([
              blast.at[0] + d[0] * r,
              blast.at[1] + d[1] * r,
              blast.at[2] + d[2] * r * 0.5 + 4 * (t - born),
            ]),
            age,
          );
        }
      }

      const tracers = Math.min(game.rounds.length, MAX_TRACERS);
      for (let i = 0; i < tracers; i++) {
        const r = game.rounds[i];
        tracerOffsets.set(rel(r.position), i * 6);
        // A round just fired streaks back only to where it left the gun, not
        // behind the aircraft that fired it.
        tracerOffsets.set(
          rel(
            sub(r.position, scale(r.velocity, Math.min(TRACER_LENGTH, r.age))),
          ),
          i * 6 + 3,
        );
      }
      const debris = Math.min(pieces.length, MAX_DEBRIS);
      for (let i = 0; i < debris; i++)
        debrisOffsets.set(rel(pieces[i].position), i * 3);
      const site = game.spec.site;
      return {
        threats: game.threats.map((t) => ({
          offset: rel(t.position),
          forward: t.velocity,
          model:
            t.kind === "jet"
              ? ("jet" as const)
              : t.kind === "hunter"
                ? ("quad" as const)
                : ("delta" as const),
        })),
        tracers: tracers ? { offsets: tracerOffsets, count: tracers } : null,
        debris: debris ? { offsets: debrisOffsets, count: debris } : null,
        missiles: game.missiles.map((m) => ({
          offset: rel(m.position),
          forward: m.velocity,
        })),
        trails: trailPuffs.data(),
        smoke: smokePuffs.data(),
        fire: firePuffs.data(),
        site: {
          offset: rel(site),
          radius: game.spec.siteRadius,
          health: (game.spec.hitsAllowed - game.hits) / game.spec.hitsAllowed,
        },
        // Standing launchers; a destroyed one is left to its smoke column.
        launchers: game.launchers.flatMap((l, i) => {
          if (!l.alive) return [];
          const at = launcherPosition(game, i, ground);
          return [
            {
              offset: rel([at[0], at[1], at[2] - LAUNCHER.height]),
              forward: [site[0] - at[0], site[1] - at[1], 0] as Vec3,
              // Its beam shows only when nothing stands between it and the camera.
              inSight: inSight(camera, at, ground),
            },
          ];
        }),
      };
    },
  };
}

export type StrikeEffects = ReturnType<typeof createStrikeEffects>;
