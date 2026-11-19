"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Dictionary, Locale } from "@/content";
import type { MissionFailure, MissionMedal, Score } from "@/lib/flight/mission";
import { formatRaceTime } from "./RaceHud";

type Strings = Dictionary["playgroundPage"]["mission"];

/** Changes on mission events only. */
export interface MissionStatus {
  name: string;
  /** What to do now: the step's role and the place's name. */
  role:
    | "load-cargo"
    | "drop-cargo"
    | "pick-patient"
    | "drop-patient"
    | "return"
    | null;
  place: string;
  stepIndex: number;
  stepCount: number;
  kind: "land" | "hoist" | null;
  phase: "flying" | "done" | "failed";
  failure: MissionFailure | null;
  patientOnBoard: boolean;
  cargoOnBoard: boolean;
  patientLate: boolean;
  /** Bumped on each touchdown harder than comfortable, so the notice can flash again. */
  hardTouchdowns: number;
  /** An avalanche has broken loose. */
  avalanche: boolean;
  result: {
    score: Score;
    time: number;
    medal: MissionMedal;
    newBest: boolean;
    previousBest: number | null;
  } | null;
}

export type HoistHint =
  | "ready"
  | "too-high"
  | "too-low"
  | "drifting"
  | "not-over"
  | "landed"
  | null;

/** Changes every frame: written straight into the DOM. */
export interface MissionFrame {
  time: number;
  /** 0–1 of the starting fuel, and kg. */
  fuel: number;
  fuelKg: number;
  /** Wind speed in a storm, m/s; null in calm missions. */
  wind: number | null;
  distance: number;
  /** Seconds to the target at the current ground speed, or null when hovering. */
  eta: number | null;
  /** 0–1 along the current step's hold. */
  progress: number;
  hint: HoistHint;
  arrow: {
    x: number;
    y: number;
    visible: boolean;
    angle: number;
    distance: number;
  } | null;
}

export interface MissionBridge {
  status(): MissionStatus | null;
  setStatus(next: MissionStatus | null): void;
  subscribe(listener: () => void): () => void;
  push(frame: MissionFrame): void;
  attach(draw: ((frame: MissionFrame) => void) | null): void;
}

export function createMissionBridge(): MissionBridge {
  let status: MissionStatus | null = null;
  let draw: ((frame: MissionFrame) => void) | null = null;
  let last: MissionFrame | null = null;
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

const formats = new Map<
  Locale,
  { plain: Intl.NumberFormat; one: Intl.NumberFormat }
>();
function numbers(locale: Locale) {
  let found = formats.get(locale);
  if (!found) {
    const tag = "en-US";
    found = {
      plain: new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }),
      one: new Intl.NumberFormat(tag, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    };
    formats.set(locale, found);
  }
  return found;
}

const MEDAL_COLOUR: Record<Exclude<MissionMedal, null>, string> = {
  gold: "text-[#ffcf5a] border-[#ffcf5a]/60",
  silver: "text-[#dfe6ee] border-[#dfe6ee]/60",
  bronze: "text-[#e09a62] border-[#e09a62]/60",
};

const getNothing = () => null;

/**
 * Mission read-outs: the task, distance and time to the target, fuel, the
 * hoist or landing progress with what to fix, an arrow to the target when
 * it is off screen, and the result card.
 */
export function MissionHud({
  bridge,
  locale,
  t,
  dir,
}: {
  bridge: MissionBridge;
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
  const distanceRef = useRef<HTMLSpanElement>(null);
  const fuelBarRef = useRef<HTMLDivElement>(null);
  const fuelTextRef = useRef<HTMLSpanElement>(null);
  const windRef = useRef<HTMLSpanElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLSpanElement>(null);
  const arrowRef = useRef<HTMLDivElement>(null);
  const arrowTextRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const { plain, one } = numbers(locale);
    const distanceText = (m: number) =>
      m >= 1000
        ? `${one.format(m / 1000)} ${t.km}`
        : `${plain.format(Math.round(m / 10) * 10)} ${t.m}`;
    bridge.attach((frame) => {
      if (clockRef.current)
        clockRef.current.textContent = formatRaceTime(locale, frame.time);
      if (distanceRef.current) {
        distanceRef.current.textContent =
          distanceText(frame.distance) +
          (frame.eta !== null && frame.distance > 300
            ? ` · ${formatRaceTime(locale, frame.eta).replace(/\.\d+$/, "")}`
            : "");
      }
      if (fuelBarRef.current) {
        fuelBarRef.current.style.width = `${Math.max(0, Math.min(1, frame.fuel)) * 100}%`;
        fuelBarRef.current.dataset.low = String(frame.fuel < 0.2);
      }
      if (fuelTextRef.current)
        fuelTextRef.current.textContent = `${plain.format(frame.fuelKg)} ${t.kg}`;
      if (windRef.current) {
        windRef.current.style.display = frame.wind === null ? "none" : "inline";
        // Knots, as pilots read wind.
        if (frame.wind !== null)
          windRef.current.textContent = t.wind.replace(
            "{speed}",
            plain.format(frame.wind / 0.514444),
          );
      }
      if (progressRef.current && progressBarRef.current) {
        const showing = frame.progress > 0 || frame.hint !== null;
        progressRef.current.style.display = showing ? "flex" : "none";
        progressBarRef.current.style.width = `${frame.progress * 100}%`;
      }
      if (hintRef.current)
        hintRef.current.textContent = frame.hint ? t.hints[frame.hint] : "";
      const arrow = arrowRef.current;
      if (arrow) {
        const a = frame.arrow;
        if (!a || a.visible) {
          arrow.style.display = "none";
        } else {
          arrow.style.display = "flex";
          arrow.style.left = `${50 + Math.cos(a.angle) * 40}%`;
          arrow.style.top = `${50 - Math.sin(a.angle) * 38}%`;
          const chevron = arrow.firstElementChild as HTMLElement | null;
          if (chevron) chevron.style.transform = `rotate(${-a.angle}rad)`;
          if (arrowTextRef.current)
            arrowTextRef.current.textContent = distanceText(a.distance);
        }
      }
    });
    return () => bridge.attach(null);
  }, [bridge, locale, t]);

  if (!status) return null;
  const { plain } = numbers(locale);

  return (
    <>
      {status.phase === "flying" && (
        <div className="pointer-events-none absolute inset-x-0 top-16 z-10 flex justify-center px-4">
          <div
            className="w-full max-w-md rounded-2xl bg-night/80 px-5 py-3 backdrop-blur"
            dir={dir}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-semibold text-night-body">
                {status.name}
              </span>
              <span
                ref={clockRef}
                dir="ltr"
                className="font-mono text-sm tabular-nums text-white"
              />
            </div>
            <p className="mt-1 text-base font-semibold text-white">
              <span className="text-[#ffb547]">
                {plain.format(status.stepIndex + 1)}/
                {plain.format(status.stepCount)}
              </span>{" "}
              {status.role
                ? t.tasks[
                    status.kind === "hoist" ? "hoist" : status.role
                  ].replace("{place}", status.place)
                : ""}
            </p>
            <div className="mt-2 flex items-center gap-3 text-xs text-night-body">
              <span
                ref={distanceRef}
                dir="ltr"
                className="font-mono tabular-nums text-[#ffcf8a]"
              />
              <span className="ms-auto">{t.fuel}</span>
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-night-3">
                <div
                  ref={fuelBarRef}
                  className="h-full bg-accent-bright data-[low=true]:bg-red-400"
                />
              </div>
              <span
                ref={fuelTextRef}
                dir="ltr"
                className="font-mono tabular-nums"
              />
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5 text-[0.7rem] font-semibold">
              {status.cargoOnBoard && (
                <span className="rounded-full bg-night-3 px-2 py-0.5 text-night-body">
                  {t.cargo}
                </span>
              )}
              {status.patientOnBoard && (
                <span className="rounded-full bg-red-500/30 px-2 py-0.5 text-red-100">
                  {t.patientAboard}
                </span>
              )}
              {status.patientLate && (
                <span className="rounded-full bg-red-500/70 px-2 py-0.5 text-white">
                  {t.patientLate}
                </span>
              )}
              <span
                ref={windRef}
                className="hidden rounded-full bg-sky-400/25 px-2 py-0.5 text-sky-100"
              />
            </div>
          </div>
        </div>
      )}

      {/* Hold progress and what to fix, centre-low. */}
      {status.phase === "flying" && (
        <div className="pointer-events-none absolute inset-x-0 bottom-44 z-10 flex justify-center px-4">
          <div
            ref={progressRef}
            className="hidden flex-col items-center gap-1.5 rounded-xl bg-night/75 px-4 py-2 backdrop-blur"
          >
            <span className="text-xs font-semibold text-white">
              {status.kind === "hoist" ? t.winching : t.holding}
            </span>
            <div className="h-2 w-56 overflow-hidden rounded-full bg-night-3">
              <div ref={progressBarRef} className="h-full bg-[#ffb547]" />
            </div>
            <span ref={hintRef} className="text-xs text-[#ffcf8a]" />
          </div>
        </div>
      )}

      {status.phase === "flying" && status.avalanche && (
        <div
          key="avalanche"
          className="race-flash pointer-events-none absolute inset-x-0 top-1/4 z-10 flex justify-center"
        >
          <span className="rounded-full bg-red-600/90 px-5 py-2 text-lg font-bold tracking-wide text-white uppercase">
            {t.avalanche}
          </span>
        </div>
      )}

      {status.phase === "flying" && status.hardTouchdowns > 0 && (
        <div
          key={`hard-${status.hardTouchdowns}`}
          className="race-flash pointer-events-none absolute inset-x-0 top-1/3 z-10 flex justify-center"
        >
          <span className="rounded-full bg-amber-500/85 px-4 py-1.5 text-sm font-semibold text-night">
            {t.hardTouchdown}
          </span>
        </div>
      )}

      <div
        className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
        aria-hidden
      >
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
              fill="#ff7a2a"
              stroke="#1b1206"
              strokeWidth="1.5"
            />
          </svg>
          <span
            ref={arrowTextRef}
            dir="ltr"
            className="rounded bg-night/70 px-1.5 py-0.5 font-mono text-xs text-[#ffcf8a]"
          />
        </div>
      </div>

      {status.phase !== "flying" && (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-0 top-1/4 z-10 flex justify-center px-4"
        >
          <div className="race-pop w-full max-w-sm rounded-2xl border border-night-line bg-night-2/95 p-6 text-center shadow-2xl">
            <p
              className={`t-eyebrow mb-1 ${status.phase === "done" ? "text-accent-bright" : "text-red-300"}`}
            >
              {status.phase === "done" ? t.complete : t.failed} · {status.name}
            </p>
            {status.phase === "failed" && (
              <p className="mb-3 text-night-body">
                {status.failure === "out-of-fuel"
                  ? t.outOfFuel
                  : status.failure === "avalanche"
                    ? t.avalancheLost
                    : t.crashed}
              </p>
            )}
            {status.result && status.phase === "done" && (
              <>
                <p
                  dir="ltr"
                  className="mb-1 font-mono text-5xl font-bold tabular-nums text-white"
                >
                  {plain.format(status.result.score.total)}
                </p>
                <dl className="mx-auto my-3 grid max-w-60 grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-start text-sm text-night-body">
                  <dt>{t.score.base}</dt>
                  <dd className="text-end tabular-nums">
                    {plain.format(status.result.score.base)}
                  </dd>
                  <dt>
                    {t.score.time} ({formatRaceTime(locale, status.result.time)}
                    )
                  </dt>
                  <dd className="text-end tabular-nums">
                    +{plain.format(status.result.score.time)}
                  </dd>
                  <dt>{t.score.fuel}</dt>
                  <dd className="text-end tabular-nums">
                    +{plain.format(status.result.score.fuel)}
                  </dd>
                  {status.result.score.smoothness < 0 && (
                    <>
                      <dt>{t.score.smoothness}</dt>
                      <dd className="text-end tabular-nums">
                        {plain.format(status.result.score.smoothness)}
                      </dd>
                    </>
                  )}
                  {status.result.score.patient < 0 && (
                    <>
                      <dt>{t.score.patient}</dt>
                      <dd className="text-end tabular-nums">
                        {plain.format(status.result.score.patient)}
                      </dd>
                    </>
                  )}
                </dl>
                <div className="my-3 flex flex-wrap items-center justify-center gap-2">
                  {status.result.medal && (
                    <span
                      className={`rounded-full border px-3 py-1 text-sm font-semibold ${MEDAL_COLOUR[status.result.medal]}`}
                    >
                      {t.medals[status.result.medal]}
                    </span>
                  )}
                  {status.result.newBest && (
                    <span className="rounded-full bg-accent-bright px-3 py-1 text-sm font-semibold text-night">
                      {t.newBest}
                    </span>
                  )}
                </div>
              </>
            )}
            <p className="text-sm font-semibold text-white">{t.restart}</p>
          </div>
        </div>
      )}
    </>
  );
}
