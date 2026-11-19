import type { CoopSession } from "@/lib/coop/client";
import { applyFire, applySnapshot, snapshotOf } from "@/lib/coop/match";
import {
  type NetworkPartner,
  networkPartner,
} from "@/lib/coop/network-partner";
import type { AircraftReport, FireCommand } from "@/lib/coop/protocol";
import type { PartnerState } from "@/lib/flight/partner";
import type { StrikeEvent, StrikeGame } from "@/lib/flight/strike";
import type { Quat, Vec3 } from "@/lib/flight/vec";

/** How often each side reports its own aircraft, and the host the match, s. */
const STATE_INTERVAL = 1 / 15;
const SNAPSHOT_INTERVAL = 1 / 10;

const NOWHERE: PartnerState = {
  role: "jet",
  position: [0, 0, 0],
  velocity: [0, 0, 0],
  orientation: [0, 0, 0, 1],
};

/**
 * One sim's end of an online co-op match: reports its own aircraft, draws the
 * partner's from the reports, and does the host's or the guest's share. The
 * host steps the game, applies the partner's shots and sends snapshots and
 * events; the guest takes the game from those and sends its shots instead of
 * firing them itself.
 */
export function createCoopLink(
  session: CoopSession,
  hooks: {
    /** The game being played here, if one has started. */
    game(): StrikeGame | null;
    /** Guest: events from the host's game, to show (effects, HUD, sound). */
    onEvents(events: StrikeEvent[]): void;
    /** Guest: the host started (or restarted) the match. */
    onStart(): void;
  },
) {
  const { client, host } = session;
  let partner: NetworkPartner = networkPartner(session.partnerRole, {
    ...NOWHERE,
    role: session.partnerRole,
  });
  const shots: FireCommand[] = [];
  let sinceState = Number.POSITIVE_INFINITY;
  let sinceSnapshot = Number.POSITIVE_INFINITY;
  let clock = 0;

  const unsubscribe = client.on((message) => {
    switch (message.type) {
      case "state":
        partner.report(message);
        break;
      case "peer-left":
        // Gone: drawn no more until a new partner reports.
        partner = networkPartner(session.partnerRole, {
          ...NOWHERE,
          role: session.partnerRole,
        });
        break;
      case "fire":
        if (host) {
          const { type: _type, from: _from, ...shot } = message;
          shots.push(shot);
        }
        break;
      case "snapshot": {
        const game = hooks.game();
        if (!host && game) applySnapshot(game, message.state);
        break;
      }
      case "event":
        if (!host) hooks.onEvents([message.event as unknown as StrikeEvent]);
        break;
      case "start":
      case "restart":
        if (!host) hooks.onStart();
        break;
    }
  });

  return {
    host,
    /** The partner's aircraft once it has reported, for drawing; null before. */
    partner(): PartnerState | null {
      return partner.heard ? partner.state() : null;
    },
    /** Once a frame: move the partner on, report this aircraft, and (host) send the match. */
    tick(
      dt: number,
      own: { position: Vec3; velocity: Vec3; orientation: Quat },
    ) {
      clock += dt;
      partner.step(dt);
      sinceState += dt;
      if (sinceState >= STATE_INTERVAL) {
        sinceState = 0;
        const report: AircraftReport = { ...own, t: clock };
        client.send({ type: "state", ...report });
      }
      const game = hooks.game();
      if (host && game) {
        sinceSnapshot += dt;
        if (sinceSnapshot >= SNAPSHOT_INTERVAL) {
          sinceSnapshot = 0;
          client.send({ type: "snapshot", state: snapshotOf(game) });
        }
      }
    },
    /** Host: apply the partner's shots that arrived, before stepping the game. */
    applyShots(game: StrikeGame) {
      if (!host) return;
      for (const shot of shots.splice(0))
        applyFire(game, session.partnerRole, shot);
    },
    /** Host: pass the game's events on to the guest. */
    sendEvents(events: StrikeEvent[]) {
      if (!host) return;
      for (const event of events)
        client.send({
          type: "event",
          event: event as unknown as Record<string, unknown>,
        });
    },
    /** Guest: a shot goes to the host's game instead of this one. */
    fire(shot: FireCommand) {
      if (!host) client.send({ type: "fire", ...shot });
    },
    /** Host: the match (re)started here; the guest starts over with it. */
    started(seed: number, restart: boolean) {
      if (host)
        client.send({
          type: restart ? "restart" : "start",
          seed,
          scenario: session.scenario,
        });
      sinceSnapshot = Number.POSITIVE_INFINITY;
    },
    dispose() {
      unsubscribe();
    },
  };
}

export type CoopLink = ReturnType<typeof createCoopLink>;
