"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Dictionary, Locale } from "@/content";
import { type Medal, MISSED_PENALTY } from "@/lib/flight/race";

type Strings = Dictionary["playgroundPage"]["race"];

/** What changes a few times per race: published on race events only. */
export interface RaceStatus {
  courseName: string;
  phase: "countdown" | "racing" | "finished";
  /** Whole seconds left in the countdown. */
  countdown: number;
  /** Gates resolved so far (passed or missed). */
  done: number;
  gateCount: number;
  /** The latest gate passed, with the difference to the best run there (negative = ahead). */
  split: { index: number; time: number; delta: number | null } | null;
  /** Bumped each time a gate is missed, so the notice can flash again. */
  missed: number;
  finish: {
    time: number;
    penalty: number;
    total: number;
    medal: Medal;
    newBest: boolean;
    previousBest: number | null;
  } | null;
  hasGhost: boolean;
}

/** What changes every frame: written straight into the DOM. */
export interface RaceFrame {
  time: number;
  penalty: number;
  /** Where the next gate is on screen, or null when there is none. */
  arrow: {
    x: number;
    y: number;
    visible: boolean;
    angle: number;
    distance: number;
  } | null;
}

export interface RaceBridge {
  status(): RaceStatus | null;
  setStatus(next: RaceStatus | null): void;
  subscribe(listener: () => void): () => void;
  push(frame: RaceFrame): void;
  attach(draw: ((frame: RaceFrame) => void) | null): void;
}

export function createRaceBridge(): RaceBridge {
  let status: RaceStatus | null = null;
  let draw: ((frame: RaceFrame) => void) | null = null;
  let last: RaceFrame | null = null;
  const listeners = new Set<() => void>();
  return {
    status: () => status,
    setStatus(next) {
      status = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push(frame) {
      last = frame;
      draw?.(frame);
    },
    attach(next) {
      draw = next;
      if (next && last) next(last);
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Formatting                                                                */
/* ------------------------------------------------------------------------ */

const digitFormats = new Map<
  Locale,
  { two: Intl.NumberFormat; plain: Intl.NumberFormat; one: Intl.NumberFormat }
>();
function digits(locale: Locale) {
  let found = digitFormats.get(locale);
  if (!found) {
    const tag = "en-US";
    found = {
      two: new Intl.NumberFormat(tag, {
        minimumIntegerDigits: 2,
        useGrouping: false,
      }),
      plain: new Intl.NumberFormat(tag, { useGrouping: false }),
      one: new Intl.NumberFormat(tag, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    };
    digitFormats.set(locale, found);
  }
  return found;
}

/** m:ss.cc in the locale's digits. */
export function formatRaceTime(locale: Locale, seconds: number) {
  const { two, plain } = digits(locale);
  const hundredths = Math.max(0, Math.round(seconds * 100));
  const m = Math.floor(hundredths / 6000);
  const s = Math.floor((hundredths % 6000) / 100);
  const c = hundredths % 100;
  return `${plain.format(m)}:${two.format(s)}.${two.format(c)}`;
}

/** +1.23 / −0.45 against the best run. */
function formatDelta(locale: Locale, seconds: number) {
  const { two, plain } = digits(locale);
  const hundredths = Math.round(Math.abs(seconds) * 100);
  const sign = seconds < 0 ? "−" : "+";
  return `${sign}${plain.format(Math.floor(hundredths / 100))}.${two.format(hundredths % 100)}`;
}

function formatDistance(locale: Locale, metres: number, t: Strings) {
  const { plain, one } = digits(locale);
  return metres >= 1000
    ? `${one.format(metres / 1000)} ${t.kilometres}`
    : `${plain.format(Math.round(metres / 10) * 10)} ${t.metres}`;
}

const MEDAL_COLOUR: Record<Exclude<Medal, null>, string> = {
  gold: "text-[#ffcf5a] border-[#ffcf5a]/60",
  silver: "text-[#dfe6ee] border-[#dfe6ee]/60",
  bronze: "text-[#e09a62] border-[#e09a62]/60",
};

/* ------------------------------------------------------------------------ */
/* The HUD                                                                   */
/* ------------------------------------------------------------------------ */

const getNothing = () => null;

/**
 * Race read-outs over the map: the clock, gate count, split against the best
 * run, an arrow to the next gate when it is off screen, the countdown and the
 * finish card. The clock and arrow are written straight to the DOM every
 * frame; everything else re-renders only on race events.
 */
export function RaceHud({
  bridge,
  locale,
  t,
  dir,
}: {
  bridge: RaceBridge;
  locale: Locale;
  t: Strings;
  dir: "ltr" | "rtl";
}) {
  const status = useSyncExternalStore(
    bridge.subscribe,
    bridge.status,
    getNothing,
  );
  const clockRef = useRef<HTMLSpanElement>(null);
  const penaltyRef = useRef<HTMLSpanElement>(null);
  const arrowRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const distanceRef = useRef<HTMLSpanElement>(null);
  const markerDistanceRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    bridge.attach((frame) => {
      if (clockRef.current)
        clockRef.current.textContent = formatRaceTime(
          locale,
          Math.max(0, frame.time),
        );
      if (penaltyRef.current) {
        penaltyRef.current.textContent =
          frame.penalty > 0
            ? `+${digits(locale).plain.format(frame.penalty)}`
            : "";
      }
      const arrow = arrowRef.current;
      const marker = markerRef.current;
      if (!arrow || !marker) return;
      const a = frame.arrow;
      if (!a) {
        arrow.style.display = "none";
        marker.style.display = "none";
        return;
      }
      const distance = formatDistance(locale, a.distance, t);
      if (a.visible) {
        // A small distance tag under the gate.
        arrow.style.display = "none";
        marker.style.display = "block";
        marker.style.left = `${50 + a.x * 50}%`;
        marker.style.top = `${50 - a.y * 50}%`;
        if (markerDistanceRef.current)
          markerDistanceRef.current.textContent = distance;
      } else {
        // An arrow on an ellipse inside the screen edge, pointing at the gate.
        marker.style.display = "none";
        arrow.style.display = "flex";
        const cx = 50 + Math.cos(a.angle) * 40;
        const cy = 50 - Math.sin(a.angle) * 38;
        arrow.style.left = `${cx}%`;
        arrow.style.top = `${cy}%`;
        const chevron = arrow.firstElementChild as HTMLElement | null;
        if (chevron) chevron.style.transform = `rotate(${-a.angle}rad)`;
        if (distanceRef.current) distanceRef.current.textContent = distance;
      }
    });
    return () => bridge.attach(null);
  }, [bridge, locale, t]);

  if (!status) return null;
  const { plain } = digits(locale);
  const racing = status.phase === "racing";

  return (
    <>
      {/* Clock and gate count, top centre. Kept left-to-right in both locales. */}
      {status.phase !== "finished" && (
        <div className="pointer-events-none absolute inset-x-0 top-16 z-10 flex justify-center px-4">
          <div
            className="flex items-center gap-4 rounded-2xl bg-night/75 px-5 py-2.5 backdrop-blur"
            dir={dir}
          >
            <div className="text-xs text-night-muted">
              <div className="font-semibold text-night-body">
                {status.courseName}
              </div>
              <div>
                {t.gate}{" "}
                {plain.format(Math.min(status.done + 1, status.gateCount))}{" "}
                {t.of} {plain.format(status.gateCount)}
              </div>
              {status.hasGhost && (
                <div className="text-[#9fe3d8]">{t.ghost}</div>
              )}
            </div>
            <div dir="ltr" className="flex items-baseline gap-2">
              <span
                ref={clockRef}
                className="font-mono text-3xl font-semibold tabular-nums text-white"
              >
                {formatRaceTime(locale, 0)}
              </span>
              <span
                ref={penaltyRef}
                className="font-mono text-sm font-semibold text-red-300"
              />
            </div>
          </div>
        </div>
      )}

      {/* Split against the best run, under the clock: re-keyed per gate so it animates in. */}
      {racing && status.split && (
        <div
          key={`split-${status.split.index}`}
          className="race-pop pointer-events-none absolute inset-x-0 top-36 z-10 flex justify-center"
        >
          <span
            dir="ltr"
            className={`rounded-full px-3 py-1 font-mono text-sm font-semibold tabular-nums backdrop-blur ${
              status.split.delta === null
                ? "bg-night/70 text-white"
                : status.split.delta <= 0
                  ? "bg-emerald-500/25 text-emerald-200"
                  : "bg-red-500/25 text-red-200"
            }`}
          >
            {status.split.delta === null
              ? formatRaceTime(locale, status.split.time)
              : formatDelta(locale, status.split.delta)}
          </span>
        </div>
      )}

      {racing && status.missed > 0 && (
        <div
          key={`missed-${status.missed}`}
          className="race-flash pointer-events-none absolute inset-x-0 top-1/4 z-10 flex justify-center"
        >
          <span className="rounded-full bg-red-500/80 px-4 py-1.5 text-sm font-semibold text-white">
            {t.missed.replace("{seconds}", plain.format(MISSED_PENALTY))}
          </span>
        </div>
      )}

      {/* Countdown. */}
      {status.phase === "countdown" && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center">
          <span
            key={status.countdown}
            className="race-count font-mono text-8xl font-bold text-white drop-shadow-[0_4px_24px_rgba(0,0,0,0.6)]"
          >
            {status.countdown > 0 ? plain.format(status.countdown) : t.go}
          </span>
        </div>
      )}
      {racing && status.done === 0 && (
        <div
          key="go"
          className="race-flash pointer-events-none absolute inset-0 z-10 grid place-items-center"
        >
          <span className="font-mono text-7xl font-bold text-[#ffb547] drop-shadow-[0_4px_24px_rgba(0,0,0,0.6)]">
            {t.go}
          </span>
        </div>
      )}

      {/* Next gate: distance tag on screen, or an arrow at the edge. */}
      <div
        className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
        aria-hidden
      >
        <div
          ref={markerRef}
          className="absolute hidden -translate-x-1/2 translate-y-6"
        >
          <span
            ref={markerDistanceRef}
            dir="ltr"
            className="rounded bg-night/70 px-1.5 py-0.5 font-mono text-xs text-[#ffcf8a]"
          />
        </div>
        <div
          ref={arrowRef}
          className="absolute hidden -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
        >
          <svg
            width="34"
            height="34"
            viewBox="-17 -17 34 34"
            className="drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]"
          >
            <path
              d="M -9 -11 L 13 0 L -9 11 L -4 0 Z"
              fill="#ffb547"
              stroke="#1b1206"
              strokeWidth="1.5"
            />
          </svg>
          <span
            ref={distanceRef}
            dir="ltr"
            className="rounded bg-night/70 px-1.5 py-0.5 font-mono text-xs text-[#ffcf8a]"
          />
        </div>
      </div>

      {status.finish && (
        <FinishCard
          finish={status.finish}
          courseName={status.courseName}
          locale={locale}
          t={t}
        />
      )}
    </>
  );
}

function FinishCard({
  finish,
  courseName,
  locale,
  t,
}: {
  finish: NonNullable<RaceStatus["finish"]>;
  courseName: string;
  locale: Locale;
  t: Strings;
}) {
  const { plain } = digits(locale);
  return (
    <div
      role="status"
      className="pointer-events-none absolute inset-x-0 top-1/4 z-10 flex justify-center px-4"
    >
      <div className="race-pop w-full max-w-sm rounded-2xl border border-night-line bg-night-2/95 p-6 text-center shadow-2xl">
        <p className="t-eyebrow mb-1 text-accent-bright">
          {t.finish} · {courseName}
        </p>
        <p
          dir="ltr"
          className="mb-1 font-mono text-5xl font-bold tabular-nums text-white"
        >
          {formatRaceTime(locale, finish.total)}
        </p>
        {finish.penalty > 0 && (
          <p className="mb-2 text-sm text-night-body">
            {t.time} {formatRaceTime(locale, finish.time)} · {t.penalty} +
            {plain.format(finish.penalty)}
          </p>
        )}
        <div className="my-3 flex flex-wrap items-center justify-center gap-2">
          {finish.medal && (
            <span
              className={`rounded-full border px-3 py-1 text-sm font-semibold ${MEDAL_COLOUR[finish.medal]}`}
            >
              {t.medals[finish.medal]}
            </span>
          )}
          {finish.newBest && (
            <span className="rounded-full bg-accent-bright px-3 py-1 text-sm font-semibold text-night">
              {t.newBest}
            </span>
          )}
        </div>
        {finish.previousBest !== null && (
          <p className="mb-2 text-sm text-night-muted">
            {t.previousBest.replace(
              "{time}",
              formatRaceTime(locale, finish.previousBest),
            )}
          </p>
        )}
        <p className="text-sm font-semibold text-white">{t.restart}</p>
      </div>
    </div>
  );
}
