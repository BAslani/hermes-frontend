# Handoff: wire Hermes co-op to hermes-server

For the session building the online co-op client in **Hermes**
(`D:\work\Behzad\hermes`, Next.js). The server is done and committed in
`D:\work\Behzad\hermes-server` (NestJS). Read that repo but don't change it. If
the protocol needs a change, note it and ask.

## Where things stand

- Co-op works on one machine. The "Co-op" setting (`settings.partner`) puts
  both aircraft in one world, with a **stand-in** partner that flies a pattern
  and doesn't fight:
  - Drone defence: `src/components/playground/sims/strike-sim.ts` uses
    `standInJet`, drawn with the aircraft layer `flight-partner`.
  - F-14 strike missions: `src/components/playground/sims/airplane-sim.ts` uses
    `standInDrone` (`mission.partner`). Hunter drones chase it.
- `src/lib/flight/partner.ts` defines `Partner { step(dt); state(): PartnerState }`.
  `PartnerState` is `{ role, position, velocity, orientation }` in the game frame
  (metres from the site). The stand-in comments say online play feeds the
  same interface, so a "network partner" should just be another `Partner`.
- The game rules live in `src/lib/flight/strike.ts` (`StrikeGame`,
  `StrikeEvent`, `newStrike(spec, seed)`, `fire`, `addMissile`). They are pure
  and seeded.
- Scenario ids are in `src/config/strikes.ts` (e.g. `karaj-launchers`).

## The model

The server is only a relay and never runs game logic.

- **Host** (the room's creator): its browser runs the `StrikeGame`. It sends
  its own aircraft (`state`), match state (`snapshot`), game events (`event`)
  and `start`/`restart`.
- **Guest**: it sends its own aircraft (`state`) and fire commands (`fire`).
  The host applies those fire commands to its game. The guest draws the match
  from snapshots and events instead of stepping its own `StrikeGame`.
- Either role (drone or jet) can be the host.

## Server

- WebSocket: `ws://localhost:4000/ws`. Use the native browser `WebSocket`, not
  socket.io.
- `GET /health` returns `{ ok: true, rooms }`.
- Run it with `pnpm start:dev` in `hermes-server`. `PORT` defaults to 4000.
- `ALLOWED_ORIGINS` defaults to `http://localhost:3000`. Other origins get a
  403 on upgrade, so set it if Hermes runs on another port.
- Suggested client env var: `NEXT_PUBLIC_COOP_SERVER_URL` (default
  `ws://localhost:4000/ws`), following the style of `src/config/site.ts`.

## Protocol

Every message is a JSON text frame: `{ type, ...payload }`. Vectors are
`[x,y,z]` and quaternions `[x,y,z,w]`, in the game frame.

### Rooms

| Send                       | Reply / push                                             |
| -------------------------- | -------------------------------------------------------- |
| `create { scenario, role }` | `created { code, playerId }`. You are the host.         |
| `join { code, role }`       | `joined { code, playerId, scenario, hostRole }`         |
| `leave {}`                  | (none). Leaves the room and keeps the socket.            |
|                             | `peer-joined { role }` to both players on join           |
|                             | `peer-left { role }` to the host when the guest leaves   |
|                             | `room-closed { reason: "host-left" \| "expired" }`       |
|                             | `error { code, message }`                                |

- `role` is `"drone"` or `"jet"`.
- Codes are 6 characters with no 0/O/1/I. Input isn't case-sensitive.
- Error codes: `room-not-found`, `room-full`, `role-taken`, `bad-message`.
- A room holds one host and one guest with different roles. It closes when the
  host leaves and expires after 10 minutes with no traffic.

### Relay

The other player receives these unchanged, plus `from: "drone" | "jet"`.
Nothing is echoed back to the sender.

| Type       | Sender, rate         | Payload                                                         |
| ---------- | -------------------- | --------------------------------------------------------------- |
| `state`    | either player, ~15 Hz | `{ position, velocity, orientation, t }`                        |
| `fire`     | guest only            | `{ weapon: "missile" \| "gun", position, velocity, forward, target?, launcher? }` |
| `snapshot` | host only, ~10 Hz     | `{ state: <object> }`                                           |
| `event`    | host only             | `{ event: <StrikeEvent> }`                                      |
| `start`    | host only             | `{ seed, scenario }`                                            |
| `restart`  | host only             | `{ seed, scenario }`                                            |

- In `fire`, `position` is the launch point, `velocity` is the shooter's
  velocity, and `forward` is the aim direction. These match the `from`,
  `carrier` and `forward` arguments of `fire()`/`addMissile()` in `strike.ts`.
- `target` is a threat id, or `null` for no lock. `launcher` is a launcher
  index for a missile aimed at a launcher.
- `snapshot` and `event` wrap the object (`state: game`, `event: e`). They are
  not spread into the message.
- Wrong-role messages are dropped silently: host-only types from the guest, or
  `fire` from the host.

### Limits the client must respect

- **Message size:** keep messages under 32 KB, or the server replies
  `bad-message`. Over 64 KB, it closes the socket (code 1009).
- **Snapshot size:** check the size of a full `StrikeGame`. `spec` and
  `pending` may not need sending every tick, and dead missiles and threats can
  be trimmed. Sending only what the guest draws is a good start.
- **Message rate:** stay under 60 messages/s per connection. The server drops
  the rest of that second. 15 Hz state + 10 Hz snapshot + events is fine.
- **Strict fields:** unknown fields are refused with `bad-message`. Numbers
  must be finite, and vectors must be exactly 3 or 4 long.
- **Heartbeat:** the server pings every 15 s. Browsers answer pings
  automatically. A dead connection is closed and counts as leaving.

## Suggested shape (not decided; check with the user)

1. **`src/lib/coop/protocol.ts`**: TypeScript types for the messages above.
   They are copied from `hermes-server/src/protocol.ts`. Hermes doesn't share
   code with the server.
2. **`src/lib/coop/client.ts`**: a small wrapper around `WebSocket`.
   - Covers connect, create, join, leave and send, plus typed listeners.
   - Handles the close/error states.
   - Doesn't reconnect automatically: a dropped host closes the room anyway.
3. **`networkPartner()`**: implements `Partner` from incoming `state`
   messages.
   - It extrapolates position with velocity between updates, and blends
     towards each new report so the partner doesn't jump.
   - It drops in where `standInJet`/`standInDrone` are chosen today.
4. **Host loop**:
   - Send `state` at about 15 Hz and `snapshot` at about 10 Hz.
   - Send each `StrikeEvent` as it happens.
   - Apply incoming `fire` to the game with `fire`/`addMissile`.
5. **Guest loop**:
   - Send `state` at about 15 Hz, and send `fire` on the fire input.
   - Replace the local `StrikeGame` with the latest snapshot, interpolated for
     drawing.
   - Play effects from `event` messages.
6. **Lobby UI**: choose create or join.
   - Show the room code, and wait for `peer-joined`.
   - Then the host sends `start`.
   - Text goes in `src/content/en.ts`, like other playground strings.

## Open question for the user

**Which sim hosts.** Today drone defence (`strike-sim.ts`) and F-14 strike
(`airplane-sim.ts`) each create their own `StrikeGame`, possibly with different
spec options (the `jet` scenario config). Online, both players must play one
game, run by the host. Settle which spec the shared game uses before writing
the host/guest split.

## Checks

- Run both apps (`pnpm dev` in Hermes, `pnpm start:dev` in hermes-server).
- Open two browser tabs: one creates a room, the other joins with the other
  role.
- Confirm in both tabs:
  - each sees the other aircraft move
  - guest fire reaches the host game
  - snapshots and events show on the guest
  - closing the host tab shows "room closed" on the guest
