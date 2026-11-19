/**
 * Messages between Hermes and hermes-server (the co-op relay), copied from
 * hermes-server/src/protocol.ts: the two projects share no code. Every
 * message is a JSON text frame, `{ type, ...payload }`; vectors are [x,y,z]
 * and quaternions [x,y,z,w], in the game frame (metres from the site).
 *
 * The server only relays. The host (the room's creator) runs the game and
 * sends `snapshot`, `event`, `start` and `restart`; the guest sends `fire`.
 *
 * Only imports sibling modules by relative path with their .ts extension, so
 * Node runs the tests on it directly.
 */
import type { Quat, Vec3 } from "../flight/vec.ts";

export type Role = "drone" | "jet";

/** Kept under the server's 32 KB message limit (it refuses larger ones). */
export const MAX_MESSAGE_BYTES = 32 * 1024;
/** The server drops messages past this many a second. */
export const MAX_MESSAGES_PER_SECOND = 60;

export interface AircraftReport {
  position: Vec3;
  velocity: Vec3;
  orientation: Quat;
  /** Sender's clock, seconds. */
  t: number;
}

export interface FireCommand {
  weapon: "missile" | "gun";
  /** Launch point, the shooter's velocity and the aim, as fire()/addMissile() take them. */
  position: Vec3;
  velocity: Vec3;
  forward: Vec3;
  /** Threat id of a missile lock; null flies straight. */
  target?: number | null;
  /** Launcher index a missile steers for instead of a threat. */
  launcher?: number;
}

export type ClientMessage =
  | { type: "create"; scenario: string; role: Role }
  | { type: "join"; code: string; role: Role }
  | { type: "leave" }
  | ({ type: "state" } & AircraftReport)
  | ({ type: "fire" } & FireCommand)
  | { type: "snapshot"; state: Record<string, unknown> }
  | { type: "event"; event: Record<string, unknown> }
  | { type: "start"; seed: number; scenario: string }
  | { type: "restart"; seed: number; scenario: string };

export type ErrorCode =
  | "room-not-found"
  | "room-full"
  | "role-taken"
  | "bad-message";

type Relayed<T> = T & { from: Role };

export type ServerMessage =
  | { type: "created"; code: string; playerId: string }
  | {
      type: "joined";
      code: string;
      playerId: string;
      scenario: string;
      hostRole: Role;
    }
  | { type: "peer-joined"; role: Role }
  | { type: "peer-left"; role: Role }
  | { type: "room-closed"; reason: "host-left" | "expired" }
  | { type: "error"; code: ErrorCode; message: string }
  | Relayed<{ type: "state" } & AircraftReport>
  | Relayed<{ type: "fire" } & FireCommand>
  | Relayed<{ type: "snapshot"; state: Record<string, unknown> }>
  | Relayed<{ type: "event"; event: Record<string, unknown> }>
  | Relayed<{ type: "start"; seed: number; scenario: string }>
  | Relayed<{ type: "restart"; seed: number; scenario: string }>;

/** Room codes: six characters, no 0/O/1/I; input is not case-sensitive. */
export const normaliseCode = (code: string) =>
  code.trim().toUpperCase().replace(/\s+/g, "");
