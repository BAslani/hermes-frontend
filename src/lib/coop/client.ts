import {
  type ClientMessage,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES_PER_SECOND,
  type Role,
  type ServerMessage,
} from "./protocol";

/** The co-op relay; NEXT_PUBLIC_* values are inlined at build time. */
export const COOP_SERVER_URL =
  process.env.NEXT_PUBLIC_COOP_SERVER_URL?.trim() || "ws://localhost:4000/ws";

export interface CoopClient {
  send(message: ClientMessage): void;
  /** Every message from the server; returns the unsubscribe. */
  on(listener: (message: ServerMessage) => void): () => void;
  /** The socket closed (by either side, or it dropped). */
  onClose(listener: () => void): () => void;
  close(): void;
  readonly open: boolean;
}

/** A room both players are in: what this browser flies, and whether it runs the game. */
export interface CoopSession {
  client: CoopClient;
  code: string;
  scenario: string;
  role: Role;
  partnerRole: Role;
  host: boolean;
}

/**
 * Open the relay socket. No automatic reconnect: a dropped host closes the
 * room anyway, so the lobby starts again instead.
 */
export function connectCoop(url = COOP_SERVER_URL): Promise<CoopClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const listeners = new Set<(message: ServerMessage) => void>();
    const closers = new Set<() => void>();
    // Stay under the server's rate limit: it drops the rest of a second past it.
    let second = 0;
    let sent = 0;
    const client: CoopClient = {
      send(message) {
        if (socket.readyState !== WebSocket.OPEN) return;
        const now = Math.floor(performance.now() / 1000);
        if (now !== second) {
          second = now;
          sent = 0;
        }
        if (sent >= MAX_MESSAGES_PER_SECOND - 5) return;
        const text = JSON.stringify(message);
        if (text.length > MAX_MESSAGE_BYTES) {
          console.warn(
            `co-op: ${message.type} too large (${text.length} bytes), not sent`,
          );
          return;
        }
        sent += 1;
        socket.send(text);
      },
      on(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onClose(listener) {
        closers.add(listener);
        return () => closers.delete(listener);
      },
      close() {
        socket.close();
      },
      get open() {
        return socket.readyState === WebSocket.OPEN;
      },
    };
    socket.onopen = () => resolve(client);
    socket.onerror = () => reject(new Error(`Could not reach ${url}`));
    socket.onclose = () => {
      for (const listener of closers) listener();
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      for (const listener of listeners) listener(message);
    };
  });
}
