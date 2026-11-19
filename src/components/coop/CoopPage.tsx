"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PlaygroundPage } from "@/components/playground/PlaygroundPage";
import { STRIKES } from "@/config/strikes";
import { en } from "@/content/en";
import {
  type CoopClient,
  type CoopSession,
  connectCoop,
} from "@/lib/coop/client";
import { normaliseCode, type Role } from "@/lib/coop/protocol";

const t = en.coopPage;
/** Missions both aircraft can fly: launch sites the F-14 can strike. */
const MISSIONS = STRIKES.filter((s) => s.launchers && s.jet);
const other = (role: Role): Role => (role === "drone" ? "jet" : "drone");

type Stage =
  | { kind: "lobby" }
  | { kind: "connecting" }
  | { kind: "waiting"; code: string }
  | { kind: "playing"; session: CoopSession };

/**
 * The co-op page: pick an aircraft and a mission, create a room (and share
 * its code) or join one, then fly. The drone plays drone defence and the F-14
 * the strike mission, in one game run by whoever created the room.
 */
export function CoopPage() {
  const [role, setRole] = useState<Role>("drone");
  const [mission, setMission] = useState(MISSIONS[0]?.id ?? "");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "lobby" });
  const [error, setError] = useState<string | null>(null);
  /** Something that happened to the room while playing. */
  const [notice, setNotice] = useState<string | null>(null);
  const clientRef = useRef<CoopClient | null>(null);

  // Leave the room when the page goes.
  useEffect(() => () => clientRef.current?.close(), []);

  const reset = (message: string | null) => {
    clientRef.current?.close();
    clientRef.current = null;
    setStage({ kind: "lobby" });
    setNotice(null);
    setError(message);
  };

  /** Connect and send `create` or `join`; the replies move the stages on. */
  const begin = async (join: boolean) => {
    setError(null);
    setStage({ kind: "connecting" });
    let client: CoopClient;
    try {
      client = await connectCoop();
    } catch {
      setStage({ kind: "lobby" });
      setError(t.errors.unreachable);
      return;
    }
    clientRef.current = client;
    let session: Omit<CoopSession, "client"> | null = null;
    client.onClose(() => {
      if (clientRef.current === client) setNotice(t.notices.disconnected);
    });
    client.on((message) => {
      switch (message.type) {
        case "created":
          session = {
            code: message.code,
            scenario: mission,
            role,
            partnerRole: other(role),
            host: true,
          };
          setStage({ kind: "waiting", code: message.code });
          break;
        case "joined":
          session = {
            code: message.code,
            scenario: message.scenario,
            role,
            partnerRole: message.hostRole,
            host: false,
          };
          break;
        case "peer-joined":
          // Both are in: fly. (The guest hears this right after "joined".)
          if (session) {
            const ready = { ...session, client };
            setNotice(null);
            setStage({ kind: "playing", session: ready });
          }
          break;
        case "peer-left":
          setNotice(t.notices.partnerLeft);
          break;
        case "room-closed":
          setNotice(
            message.reason === "host-left"
              ? t.notices.hostLeft
              : t.notices.expired,
          );
          break;
        case "error":
          if (!session || message.code !== "bad-message")
            reset(t.errors[message.code] ?? message.message);
          else console.warn("co-op:", message.message);
          break;
      }
    });
    client.send(
      join
        ? { type: "join", code: normaliseCode(code), role }
        : { type: "create", scenario: mission, role },
    );
  };

  if (stage.kind === "playing") {
    const { session } = stage;
    return (
      <>
        <PlaygroundPage
          vehicle={session.role === "drone" ? "strike" : "airplane"}
          coop={session}
        />
        {notice && (
          <div
            role="alert"
            className="fixed inset-x-0 top-16 z-40 flex justify-center px-4"
          >
            <div className="flex items-center gap-3 rounded-full bg-night-2/95 px-5 py-2 text-sm text-white shadow-2xl">
              {notice}
              <button
                type="button"
                className="font-semibold text-accent-bright"
                onClick={() => reset(null)}
              >
                {t.backToLobby}
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  const busy = stage.kind !== "lobby";
  const roleButton = (r: Role) => (
    <button
      key={r}
      type="button"
      aria-pressed={role === r}
      disabled={busy}
      onClick={() => setRole(r)}
      className={`flex-1 rounded-xl border px-4 py-3 text-start ${
        role === r
          ? "border-accent-bright bg-night-3 text-white"
          : "border-night-line text-night-body hover:border-night-muted"
      }`}
    >
      <span className="block font-semibold">{t.roles[r].name}</span>
      <span className="block text-xs text-night-muted">{t.roles[r].job}</span>
    </button>
  );

  return (
    <main className="mx-auto max-w-2xl px-4 py-12 sm:py-20">
      <Link href="/" className="text-sm text-night-body hover:text-white">
        <span aria-hidden>←</span> {en.playgroundPage.back}
      </Link>
      <h1 className="t-h3 mt-6 text-white">{t.title}</h1>
      <p className="mt-2 text-night-body">{t.intro}</p>

      <fieldset className="mt-8">
        <legend className="mb-2 text-sm font-semibold text-night-muted">
          {t.youFly}
        </legend>
        <div className="flex gap-3">
          {(["drone", "jet"] as const).map(roleButton)}
        </div>
      </fieldset>

      {stage.kind === "waiting" ? (
        <div className="mt-8 rounded-2xl border border-night-line bg-night-2 p-6 text-center">
          <p className="text-sm text-night-body">{t.shareCode}</p>
          <p
            dir="ltr"
            className="my-3 font-mono text-4xl font-bold tracking-[0.3em] text-white"
          >
            {stage.code}
          </p>
          <p className="flex items-center justify-center gap-2 text-sm text-night-muted">
            <span
              className="size-2 animate-pulse rounded-full bg-accent-bright"
              aria-hidden
            />
            {t.waiting.replace("{role}", t.roles[other(role)].name)}
          </p>
          <button
            type="button"
            className="btn btn-night-secondary mt-5"
            onClick={() => reset(null)}
          >
            {t.cancel}
          </button>
        </div>
      ) : (
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <section className="rounded-2xl border border-night-line bg-night-2 p-5">
            <h2 className="mb-3 font-semibold text-white">{t.create}</h2>
            <label className="grid gap-1 text-sm text-night-body">
              {t.mission}
              <select
                className="rounded-lg border border-night-line bg-night-3 px-3 py-2 text-white"
                value={mission}
                disabled={busy}
                onChange={(e) => setMission(e.target.value)}
              >
                {MISSIONS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name.en}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-night-primary mt-4 w-full"
              disabled={busy || !mission}
              onClick={() => begin(false)}
            >
              {t.createButton}
            </button>
          </section>
          <section className="rounded-2xl border border-night-line bg-night-2 p-5">
            <h2 className="mb-3 font-semibold text-white">{t.join}</h2>
            <label className="grid gap-1 text-sm text-night-body">
              {t.code}
              <input
                className="rounded-lg border border-night-line bg-night-3 px-3 py-2 font-mono tracking-widest text-white uppercase"
                value={code}
                maxLength={6}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn btn-night-primary mt-4 w-full"
              disabled={busy || normaliseCode(code).length !== 6}
              onClick={() => begin(true)}
            >
              {t.joinButton}
            </button>
          </section>
        </div>
      )}

      {stage.kind === "connecting" && (
        <output className="mt-4 block text-sm text-night-muted">
          {t.connecting}
        </output>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-300">
          {error}
        </p>
      )}
      <p className="mt-8 text-xs text-night-muted">{en.home.desktopNote}</p>
    </main>
  );
}
