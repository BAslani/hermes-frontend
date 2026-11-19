"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Dictionary, Locale } from "@/content";
import type {
  StrikeMedal,
  StrikePhase,
  StrikeScore,
} from "@/lib/flight/strike";

type Strings = Dictionary["playgroundPage"]["strike"];

/** Changes on game events only. */
export interface StrikeStatus {
  name: string;
  site: string;
  phase: StrikePhase;
  /** Current wave (0-based; -1 before the first) and how many there are. */
  wave: number;
  waveCount: number;
  hitsLeft: number;
  hitsAllowed: number;
  /** Hits the interceptor can still take, of how many; shown when the scenario has hunters. */
  armourLeft: number;
  armour: number;
  hunters: boolean;
  lostBy: "site" | "interceptor" | null;
  kills: number;
  total: number;
  /** A notice to flash; `seq` changes each time so the same one can flash again. */
  /** For a kill, `n` is the points; for a hit or damage, what is left. */
  banner: {
    kind: "wave" | "clear" | "hit" | "kill" | "decoy" | "damage" | "launcher";
    n: number;
    seq: number;
  } | null;
  result: { score: StrikeScore; medal: StrikeMedal; newBest: boolean } | null;
  /** Launchers still standing, of how many: shown when they are targets (the F-14's strike). */
  launchers?: { left: number; total: number };
}

/** Most target boxes drawn. */
export const MAX_BOXES = 32;

/** Changes every frame: written straight into the DOM. */
export interface StrikeFrame {
  magazine: number;
  magazineSize: number;
  threatsLeft: number;
  /** Seconds to the next wave, in a break. */
  breakLeft: number | null;
  lock: { progress: number; locked: boolean; hunting: boolean };
  /** The seeker's circle: radius as a fraction of the viewport height. */
  cone: number;
  /** Drones on screen, x and y from -1 to 1 (up is +1). */
  boxes: {
    x: number;
    y: number;
    distance: number;
    state: "locked" | "locking" | "none";
    tag: "jet" | "hunter" | "decoy" | "launcher" | null;
  }[];
  /** The drone nearest the site, when it is off screen: which way, and how far from the player. */
  arrow: { angle: number; distance: number } | null;
  /** How far the drone nearest the site is from it, metres. */
  closest: number | null;
  /** The nearest hunter, when it is close enough to warn about, metres. */
  hunter: number | null;
  /** 1 → 0 as the jolt of a hit fades. */
  shake: number;
  /** Gun rounds left, of how many. */
  ammo: number;
  ammoSize: number;
  /** Where to aim the gun to hit the drone nearest the crosshair, x and y from -1 to 1. */
  pipper: { x: number; y: number } | null;
  /** Flown from the F-14: its missiles do not refill between waves. */
  jet?: boolean;
}

export interface StrikeBridge {
  status(): StrikeStatus | null;
  setStatus(next: StrikeStatus | null): void;
  subscribe(listener: () => void): () => void;
  push(frame: StrikeFrame): void;
  attach(draw: ((frame: StrikeFrame) => void) | null): void;
}

export function createStrikeBridge(): StrikeBridge {
  let status: StrikeStatus | null = null;
  let draw: ((frame: StrikeFrame) => void) | null = null;
  let last: StrikeFrame | null = null;
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

const MEDAL_COLOUR: Record<Exclude<StrikeMedal, null>, string> = {
  gold: "text-[#ffcf5a] border-[#ffcf5a]/60",
  silver: "text-[#dfe6ee] border-[#dfe6ee]/60",
  bronze: "text-[#e09a62] border-[#e09a62]/60",
};

/** The drone nearest the site is this close: warn, metres. */
const WARN_AT = 2000;

const getNothing = () => null;

/**
 * Drone-defence read-outs: wave, drones left, the site's hits left, the
 * missiles, the seeker circle with a box on every drone in view (amber
 * while locking, red once locked), an arrow to the most urgent drone off
 * screen, notices, and the result card.
 */
export function StrikeHud({
  bridge,
  locale,
  t,
  dir,
}: {
  bridge: StrikeBridge;
  locale: Locale;
  t: Strings;
  dir: "ltr" | "rtl";
}) {
  const status = useSyncExternalStore(
    bridge.subscribe,
    bridge.status,
    getNothing,
  );
  const boxRefs = useRef<(HTMLDivElement | null)[]>([]);
  const coneRef = useRef<HTMLDivElement>(null);
  const magazineRef = useRef<HTMLSpanElement>(null);
  const pipsRef = useRef<HTMLDivElement>(null);
  const lockRef = useRef<HTMLSpanElement>(null);
  const leftRef = useRef<HTMLSpanElement>(null);
  const breakRef = useRef<HTMLDivElement>(null);
  const warnRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLDivElement>(null);
  const arrowTextRef = useRef<HTMLSpanElement>(null);
  const hunterRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const pipperRef = useRef<HTMLDivElement>(null);
  const ammoRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const { plain, one } = numbers(locale);
    const distanceText = (m: number) =>
      m >= 1000
        ? `${one.format(m / 1000)} ${t.km}`
        : `${plain.format(Math.round(m / 10) * 10)} ${t.m}`;
    bridge.attach((frame) => {
      if (coneRef.current) {
        coneRef.current.style.width =
          coneRef.current.style.height = `${frame.cone * 200}vh`;
        coneRef.current.dataset.state = frame.lock.locked
          ? "locked"
          : frame.lock.hunting
            ? "locking"
            : "none";
      }
      boxRefs.current.forEach((box, i) => {
        if (!box) return;
        const b = frame.boxes[i];
        if (!b) {
          box.style.display = "none";
          return;
        }
        box.style.display = "block";
        box.style.left = `${((b.x + 1) / 2) * 100}%`;
        box.style.top = `${((1 - b.y) / 2) * 100}%`;
        box.dataset.state = b.state;
        box.dataset.tag = b.tag ?? "";
        // Nearer drones get bigger boxes.
        const size = Math.max(18, Math.min(56, 9000 / Math.max(b.distance, 1)));
        box.style.width = box.style.height = `${size}px`;
        const label = box.firstElementChild as HTMLElement | null;
        if (label)
          label.textContent = `${b.tag ? `${t.tags[b.tag]} ` : ""}${b.state === "locked" ? t.lockShort : distanceText(b.distance)}`;
        const bar = box.lastElementChild as HTMLElement | null;
        if (bar)
          bar.style.width =
            b.state === "locking" ? `${frame.lock.progress * 100}%` : "0";
      });
      if (magazineRef.current)
        magazineRef.current.textContent = `${plain.format(frame.magazine)}/${plain.format(frame.magazineSize)}`;
      const pips = pipsRef.current;
      if (pips) {
        while (pips.childElementCount < frame.magazineSize) {
          const pip = document.createElement("span");
          pip.className =
            "h-3 w-1.5 rounded-sm bg-white data-[spent=true]:bg-white/15";
          pips.appendChild(pip);
        }
        Array.from(pips.children).forEach((pip, i) => {
          (pip as HTMLElement).style.display =
            i < frame.magazineSize ? "block" : "none";
          (pip as HTMLElement).dataset.spent = String(i >= frame.magazine);
        });
      }
      if (lockRef.current) {
        lockRef.current.textContent =
          frame.magazine === 0
            ? frame.jet
              ? t.jetEmpty
              : t.empty
            : frame.lock.locked
              ? t.locked
              : frame.lock.hunting
                ? t.locking
                : t.noLock;
        lockRef.current.dataset.state =
          frame.magazine === 0
            ? "empty"
            : frame.lock.locked
              ? "locked"
              : frame.lock.hunting
                ? "locking"
                : "none";
      }
      if (leftRef.current)
        leftRef.current.textContent = t.left.replace(
          "{n}",
          plain.format(frame.threatsLeft),
        );
      if (breakRef.current) {
        breakRef.current.style.display =
          frame.breakLeft === null ? "none" : "block";
        if (frame.breakLeft !== null)
          breakRef.current.textContent = t.nextWave.replace(
            "{s}",
            plain.format(Math.ceil(frame.breakLeft)),
          );
      }
      if (hunterRef.current) {
        hunterRef.current.style.display =
          frame.hunter === null ? "none" : "block";
        if (frame.hunter !== null)
          hunterRef.current.textContent = t.hunterWarning.replace(
            "{d}",
            distanceText(frame.hunter),
          );
      }
      if (flashRef.current)
        flashRef.current.style.opacity = String(frame.shake * 0.55);
      if (pipperRef.current) {
        const p = frame.pipper;
        pipperRef.current.style.display = p ? "block" : "none";
        if (p) {
          pipperRef.current.style.left = `${((p.x + 1) / 2) * 100}%`;
          pipperRef.current.style.top = `${((1 - p.y) / 2) * 100}%`;
        }
      }
      if (ammoRef.current) {
        ammoRef.current.textContent = `${plain.format(frame.ammo)}`;
        ammoRef.current.dataset.low = String(
          frame.ammo < frame.ammoSize * 0.15,
        );
      }
      if (warnRef.current) {
        const warn = frame.closest !== null && frame.closest < WARN_AT;
        warnRef.current.style.display = warn ? "block" : "none";
        if (warn)
          warnRef.current.textContent = t.warning.replace(
            "{d}",
            distanceText(frame.closest!),
          );
      }
      const arrow = arrowRef.current;
      if (arrow) {
        const a = frame.arrow;
        if (!a) {
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
  const playing = status.phase === "wave" || status.phase === "break";
  const banner = status.banner;

  return (
    <>
      {playing && (
        // Below the camera's heading scale.
        <div className="pointer-events-none absolute inset-x-0 top-24 z-10 flex justify-center px-4">
          <div
            className="w-full max-w-md rounded-2xl bg-night/80 px-5 py-3 backdrop-blur"
            dir={dir}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-semibold text-night-body">
                {status.name}
              </span>
              <span className="text-xs font-semibold text-[#ffb547]">
                {status.wave >= 0
                  ? t.wave
                      .replace("{n}", plain.format(status.wave + 1))
                      .replace("{count}", plain.format(status.waveCount))
                  : t.getReady}
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-3 text-sm">
              <span ref={leftRef} className="font-semibold text-white" />
              <span className="text-night-body">
                {t.kills.replace("{n}", plain.format(status.kills))}
              </span>
              <span className="ms-auto text-xs text-night-body">
                {status.site}
              </span>
              <div className="flex gap-1" aria-label={t.hits}>
                {Array.from({ length: status.hitsAllowed }, (_, i) => (
                  <span
                    key={i}
                    className={`h-2.5 w-4 rounded-sm ${i < status.hitsLeft ? "bg-accent-bright" : "bg-red-500/40"}`}
                  />
                ))}
              </div>
            </div>
            {status.launchers && (
              <div className="mt-1 flex items-center justify-end gap-2 text-xs text-night-body">
                {t.launchers}
                <div className="flex gap-1" aria-label={t.launchers}>
                  {Array.from({ length: status.launchers.total }, (_, i) => (
                    <span
                      key={i}
                      className={`h-2.5 w-4 rounded-sm ${i < (status.launchers?.left ?? 0) ? "bg-[#ff8a2a]" : "bg-white/15"}`}
                    />
                  ))}
                </div>
              </div>
            )}
            {status.hunters && (
              <div className="mt-1 flex items-center justify-end gap-2 text-xs text-night-body">
                {t.armour}
                <div className="flex gap-1" aria-label={t.armour}>
                  {Array.from({ length: status.armour }, (_, i) => (
                    <span
                      key={i}
                      className={`h-2.5 w-4 rounded-sm ${i < status.armourLeft ? "bg-sky-300" : "bg-red-500/40"}`}
                    />
                  ))}
                </div>
              </div>
            )}
            <div
              ref={breakRef}
              className="mt-1 hidden text-xs font-semibold text-[#ffcf8a]"
            />
          </div>
        </div>
      )}

      {/* The seeker circle and the target boxes. */}
      {playing && (
        <div
          className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
          aria-hidden
        >
          <div
            ref={coneRef}
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-white/35 data-[state=locked]:border-solid data-[state=locked]:border-red-400/80 data-[state=locking]:border-[#ffb547]/70"
          />
          <div className="absolute top-1/2 left-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/80" />
          {Array.from({ length: MAX_BOXES }, (_, i) => (
            <div
              key={i}
              ref={(el) => {
                boxRefs.current[i] = el;
              }}
              className="absolute hidden -translate-x-1/2 -translate-y-1/2 border-2 border-white/60 data-[tag=decoy]:border-dashed data-[tag=decoy]:border-white/35 data-[tag=hunter]:border-sky-300 data-[tag=launcher]:border-[#ff8a2a] data-[state=locked]:border-red-500 data-[state=locking]:border-[#ffb547]"
            >
              <span
                dir="ltr"
                className="absolute top-full left-1/2 mt-0.5 -translate-x-1/2 font-mono text-[0.65rem] whitespace-nowrap text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]"
              />
              <span className="absolute -bottom-2.5 left-0 h-0.5 bg-[#ffb547]" />
            </div>
          ))}
          {/* The gun's pipper: aim the reticle here to hit with the gun. */}
          <div
            ref={pipperRef}
            className="absolute hidden size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#ffd27a]"
          >
            <span className="absolute top-1/2 left-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#ffd27a]" />
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
                fill="#ff4d4d"
                stroke="#1b0606"
                strokeWidth="1.5"
              />
            </svg>
            <span
              ref={arrowTextRef}
              dir="ltr"
              className="rounded bg-night/70 px-1.5 py-0.5 font-mono text-xs text-red-200"
            />
          </div>
        </div>
      )}

      {/* Missiles and the seeker's state, bottom centre. */}
      {playing && (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 z-10 flex flex-col items-center gap-2 px-4">
          <div
            ref={hunterRef}
            className="hidden rounded-full bg-sky-500/85 px-4 py-1 text-sm font-bold text-white"
          />
          <div
            ref={warnRef}
            className="hidden rounded-full bg-red-600/85 px-4 py-1 text-sm font-bold text-white"
          />
          <div
            className="flex items-center gap-3 rounded-xl bg-night/75 px-4 py-2 backdrop-blur"
            dir={dir}
          >
            <span className="text-xs text-night-body">{t.missiles}</span>
            <div ref={pipsRef} className="flex gap-1" dir="ltr" />
            <span
              ref={magazineRef}
              dir="ltr"
              className="font-mono text-xs tabular-nums text-white"
            />
            <span className="ms-2 text-xs text-night-body">{t.gun}</span>
            <span
              ref={ammoRef}
              dir="ltr"
              className="font-mono text-xs tabular-nums text-white data-[low=true]:text-red-300"
            />
            <span
              ref={lockRef}
              className="ms-2 text-xs font-semibold text-night-body data-[state=empty]:text-red-300 data-[state=locked]:text-red-300 data-[state=locking]:text-[#ffb547]"
            />
          </div>
        </div>
      )}

      {/* A red flash as a hunter's hit lands, fading with the jolt. */}
      <div
        ref={flashRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 z-10 bg-[radial-gradient(ellipse_at_center,transparent_35%,rgba(220,30,30,0.9)_100%)] opacity-0"
      />

      {playing && banner && (
        <div
          key={banner.seq}
          className="race-flash pointer-events-none absolute inset-x-0 top-1/4 z-10 flex justify-center"
        >
          <span
            className={`rounded-full px-5 py-2 font-bold tracking-wide ${
              banner.kind === "hit" || banner.kind === "damage"
                ? "bg-red-600/90 text-lg text-white uppercase"
                : banner.kind === "kill"
                  ? "bg-night/70 text-base text-[#ffcf8a]"
                  : banner.kind === "launcher"
                    ? "bg-[#ff8a2a]/90 text-lg text-night"
                    : "bg-night/80 text-lg text-white"
            }`}
          >
            {banner.kind === "wave"
              ? t.waveStart.replace("{n}", plain.format(banner.n + 1))
              : banner.kind === "clear"
                ? t.waveClear
                : banner.kind === "hit"
                  ? t.siteHit
                      .replace("{site}", status.site)
                      .replace("{n}", plain.format(banner.n))
                  : banner.kind === "damage"
                    ? t.damage.replace("{n}", plain.format(banner.n))
                    : banner.kind === "decoy"
                      ? t.decoyDown
                      : banner.kind === "launcher"
                        ? banner.n > 0
                          ? t.launcherDown.replace(
                              "{n}",
                              plain.format(banner.n),
                            )
                          : t.lastLauncher
                        : `+${plain.format(banner.n)}`}
          </span>
        </div>
      )}

      {!playing && (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-0 top-1/4 z-10 flex justify-center px-4"
        >
          <div className="race-pop w-full max-w-sm rounded-2xl border border-night-line bg-night-2/95 p-6 text-center shadow-2xl">
            <p
              className={`t-eyebrow mb-1 ${status.phase === "won" ? "text-accent-bright" : "text-red-300"}`}
            >
              {(status.phase === "won"
                ? t.won
                : status.lostBy === "interceptor"
                  ? t.shotDown
                  : t.lost
              ).replace("{site}", status.site)}
            </p>
            {status.result && (
              <>
                <p
                  dir="ltr"
                  className="mb-1 font-mono text-5xl font-bold tabular-nums text-white"
                >
                  {plain.format(status.result.score.total)}
                </p>
                <dl className="mx-auto my-3 grid max-w-60 grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-start text-sm text-night-body">
                  <dt>
                    {t.score.kills} ({plain.format(status.kills)}/
                    {plain.format(status.total)})
                  </dt>
                  <dd className="text-end tabular-nums">
                    {plain.format(status.result.score.kills)}
                  </dd>
                  <dt>{t.score.site}</dt>
                  <dd className="text-end tabular-nums">
                    +{plain.format(status.result.score.site)}
                  </dd>
                  <dt>{t.score.accuracy}</dt>
                  <dd className="text-end tabular-nums">
                    +{plain.format(status.result.score.accuracy)}
                  </dd>
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
