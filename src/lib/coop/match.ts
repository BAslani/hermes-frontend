/**
 * The shared co-op match over the relay. The host's browser steps the one
 * StrikeGame; the guest draws it from snapshots, carrying everything on along
 * its velocity between them, and its shots go to the host as fire commands.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import {
  addMissile,
  addRound,
  fire,
  LAUNCHER,
  type StrikeGame,
  shoot,
} from "../flight/strike.ts";
import { add, scale } from "../flight/vec.ts";
import type { FireCommand, Role } from "./protocol.ts";

/** The parts of a game that change while it is played (the spec both sides build themselves). */
const DYNAMIC = [
  "time",
  "wave",
  "phase",
  "breakLeft",
  "threats",
  "missiles",
  "rounds",
  "hits",
  "kills",
  "missileKills",
  "launcherMissileHits",
  "launchers",
  "ammo",
  "magazine",
  "cooldown",
  "gunCooldown",
  "points",
  "decoysHit",
  "damage",
  "lostBy",
  "fired",
] as const satisfies readonly (keyof StrikeGame)[];

/** Centimetres are plenty: halves the size of a snapshot. */
const round = (_key: string, value: unknown) =>
  typeof value === "number" && !Number.isInteger(value)
    ? Math.round(value * 100) / 100
    : value;

/** What the host sends about ten times a second: only what the guest draws, rounded. */
export function snapshotOf(game: StrikeGame): Record<string, unknown> {
  const out: Record<string, unknown> = { pendingCount: game.pending.length };
  for (const key of DYNAMIC) out[key] = game[key];
  // Dead missiles, rounds and drones are dropped at the end of every step already.
  return JSON.parse(JSON.stringify(out, round));
}

/** The guest takes a snapshot into its own game (built from the same scenario). */
export function applySnapshot(
  game: StrikeGame,
  snapshot: Record<string, unknown>,
) {
  const target = game as unknown as Record<string, unknown>;
  for (const key of DYNAMIC) if (key in snapshot) target[key] = snapshot[key];
  // The guest never steps the game: the drones still to come only count (threatsLeft).
  const count = Number(snapshot.pendingCount) || 0;
  game.pending = Array.from(
    { length: count },
    () => ({ at: Number.POSITIVE_INFINITY }) as StrikeGame["pending"][number],
  );
}

/** Between snapshots: drones, missiles and rounds carry on along their velocities. */
export function coast(game: StrikeGame, dt: number) {
  game.time += dt;
  for (const list of [game.threats, game.missiles, game.rounds])
    for (const item of list) {
      item.position = add(item.position, scale(item.velocity, dt));
      item.age += dt;
    }
}

/**
 * The host applies a shot from the partner. The drone's use the game's own
 * magazine and gun (fire/shoot, as if flown here); the F-14 keeps its own
 * stores, and its missiles destroy a launcher in one burst.
 */
export function applyFire(game: StrikeGame, from: Role, shot: FireCommand) {
  const { position, velocity, forward } = shot;
  if (from === "drone") {
    if (shot.weapon === "gun") shoot(game, position, velocity, forward);
    else fire(game, position, velocity, forward, shot.target ?? null);
    return;
  }
  if (game.phase === "won" || game.phase === "lost") return;
  if (shot.weapon === "gun") addRound(game, position, velocity, forward);
  else
    addMissile(
      game,
      position,
      velocity,
      forward,
      shot.target ?? null,
      shot.launcher,
      LAUNCHER.health,
    );
}
