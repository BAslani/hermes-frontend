"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Dictionary, Locale } from "@/content";

type Strings = Dictionary["playgroundPage"]["instruments"];

/** One frame of read-outs, SI units. */
export interface PanelData {
  /** Indicated airspeed, m/s. */
  ias: number;
  /** Metres above sea level. */
  altitude: number;
  /** m/s. */
  climb: number;
  /** Degrees. */
  heading: number;
  pitch: number;
  roll: number;
  rpm: number;
  /** Degrees. */
  flaps: number;
  /** −1…1. */
  trim: number;
  /** 0…1. */
  throttle: number;
  /** Virtual stick, −1…1: x right, y back. */
  stickX: number;
  stickY: number;
  stall: boolean;
  brake: boolean;
  parkingBrake: boolean;
}

/**
 * Carries read-outs from the frame loop to the panel without React: the panel
 * registers a function that writes straight to its SVG nodes.
 */
export interface PanelBridge {
  push(data: PanelData): void;
  attach(draw: ((data: PanelData) => void) | null): void;
}

export function createPanelBridge(): PanelBridge {
  let draw: ((data: PanelData) => void) | null = null;
  let last: PanelData | null = null;
  return {
    push(data) {
      last = data;
      draw?.(data);
    },
    attach(next) {
      draw = next;
      if (next && last) next(last);
    },
  };
}

const KNOT = 0.514444;
const FOOT = 0.3048;

/** Scale of each dial for the two unit systems. */
const UNITS = {
  imperial: {
    speed: 1 / KNOT,
    speedMax: 160,
    speedStep: 20,
    alt: 1 / FOOT,
    climb: 60 / FOOT / 100,
    climbMax: 20,
    climbStep: 5,
  },
  metric: {
    speed: 3.6,
    speedMax: 300,
    speedStep: 50,
    alt: 1,
    climb: 1,
    climbMax: 10,
    climbStep: 5,
  },
} as const;
/** Faster aircraft get longer airspeed scales. */
const SPEED_SCALES = {
  light: null,
  race: {
    imperial: { speedMax: 260, speedStep: 20 },
    metric: { speedMax: 480, speedStep: 40 },
  },
  jet: {
    imperial: { speedMax: 700, speedStep: 50 },
    metric: { speedMax: 1300, speedStep: 100 },
  },
  heli: null,
} as const;
export type PanelKind = keyof typeof SPEED_SCALES;

const SIZE = 104;
const C = SIZE / 2;
const R = 46;
const polar = (angleDeg: number, radius: number): [number, number] => {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return [C + Math.cos(a) * radius, C + Math.sin(a) * radius];
};

/** Tick marks and numbers around a dial: `value` → angle through `angleOf`. */
function Scale({
  values,
  minor = [],
  angleOf,
  label,
}: {
  values: number[];
  minor?: number[];
  angleOf: (value: number) => number;
  label: (value: number) => string;
}) {
  return (
    <g>
      {minor.map((v) => {
        const [x1, y1] = polar(angleOf(v), R - 2);
        const [x2, y2] = polar(angleOf(v), R - 6);
        return (
          <line
            key={`m${v}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="#7f8b98"
            strokeWidth={1}
          />
        );
      })}
      {values.map((v) => {
        const [x1, y1] = polar(angleOf(v), R - 2);
        const [x2, y2] = polar(angleOf(v), R - 9);
        const [tx, ty] = polar(angleOf(v), R - 17);
        return (
          <g key={v}>
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#fff"
              strokeWidth={1.6}
            />
            <text
              x={tx}
              y={ty}
              fill="#e8edf2"
              fontSize={8.5}
              textAnchor="middle"
              dominantBaseline="central"
            >
              {label(v)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function Dial({
  title,
  unit,
  children,
}: {
  title: string;
  unit?: string;
  children: React.ReactNode;
}) {
  return (
    <figure className="m-0 flex flex-col items-center gap-1">
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={title}
      >
        <circle
          cx={C}
          cy={C}
          r={R + 4}
          fill="#0b1118"
          stroke="#263241"
          strokeWidth={2}
        />
        {children}
      </svg>
      <figcaption className="text-[0.62rem] font-semibold tracking-wide text-night-muted uppercase">
        {title}
        {unit ? (
          <span className="ms-1 font-normal normal-case text-night-body">
            {unit}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

const Needle = ({ innerRef }: { innerRef: React.Ref<SVGGElement> }) => (
  <g ref={innerRef}>
    <line
      x1={C}
      y1={C + 8}
      x2={C}
      y2={C - R + 8}
      stroke="#fff"
      strokeWidth={2.2}
      strokeLinecap="round"
    />
    <circle cx={C} cy={C} r={3.2} fill="#fff" />
  </g>
);

const range = (from: number, to: number, step: number) =>
  Array.from(
    { length: Math.floor((to - from) / step + 1e-9) + 1 },
    (_, i) => from + i * step,
  );

/**
 * The airplane's instruments: airspeed, attitude, altimeter, vertical speed,
 * heading and rpm, with flaps, trim, throttle, the yoke position and the
 * stall and brake lights. Drawn once by React; the frame loop then moves the
 * needles through the bridge. Always laid out left to right, in either locale.
 */
export function InstrumentPanel({
  bridge,
  t,
  locale,
  metric,
  kind = "light",
}: {
  bridge: PanelBridge;
  t: Strings;
  locale: Locale;
  metric: boolean;
  /** Light trainer, race plane or jet: the airspeed scale, and engine rpm or %. */
  kind?: PanelKind;
}) {
  const base = metric ? UNITS.metric : UNITS.imperial;
  const scale = SPEED_SCALES[kind];
  const u = scale
    ? { ...base, ...(metric ? scale.metric : scale.imperial) }
    : base;
  // A jet's engine reads in % of full speed, a helicopter's rotor too (to
  // 120 %): shown on the same dial as rpm × 30 or × 25.
  const engineScale = kind === "jet" ? 30 : kind === "heli" ? 25 : 1;
  const format = useMemo(
    () =>
      new Intl.NumberFormat("en-US", {
        maximumFractionDigits: 0,
        useGrouping: false,
      }),
    [locale],
  );
  const n = (value: number) => format.format(value);

  const speedNeedle = useRef<SVGGElement>(null);
  const horizon = useRef<SVGGElement>(null);
  const altNeedle = useRef<SVGGElement>(null);
  const altText = useRef<SVGTextElement>(null);
  const climbNeedle = useRef<SVGGElement>(null);
  const compass = useRef<SVGGElement>(null);
  const headingText = useRef<SVGTextElement>(null);
  const rpmNeedle = useRef<SVGGElement>(null);
  const throttleBar = useRef<SVGRectElement>(null);
  const trimMark = useRef<SVGRectElement>(null);
  const flapMark = useRef<SVGRectElement>(null);
  const stickDot = useRef<SVGCircleElement>(null);
  const stallLamp = useRef<HTMLSpanElement>(null);
  const brakeLamp = useRef<HTMLSpanElement>(null);

  const speedAngle = (v: number) =>
    -150 + 300 * Math.min(1, Math.max(0, v / u.speedMax));
  const climbAngle = (v: number) =>
    -90 + 160 * Math.min(1, Math.max(-1, v / u.climbMax));
  const rpmAngle = (v: number) =>
    -135 + 270 * Math.min(1, Math.max(0, v / 3000));

  useEffect(() => {
    let lastText = 0;
    const turn = (el: SVGGElement | null, angle: number) =>
      el?.setAttribute("transform", `rotate(${angle.toFixed(1)} ${C} ${C})`);
    bridge.attach((d) => {
      turn(speedNeedle.current, speedAngle(d.ias * u.speed));
      const altitude = d.altitude * u.alt;
      turn(altNeedle.current, ((altitude % 1000) / 1000) * 360);
      turn(climbNeedle.current, climbAngle(d.climb * u.climb));
      turn(compass.current, -d.heading);
      turn(rpmNeedle.current, rpmAngle(d.rpm * engineScale));
      // Nose up moves the horizon down; banking right turns it anticlockwise.
      const shift = Math.max(-40, Math.min(40, d.pitch * 1.3));
      horizon.current?.setAttribute(
        "transform",
        `rotate(${(-d.roll).toFixed(1)} ${C} ${C}) translate(0 ${shift.toFixed(1)})`,
      );

      throttleBar.current?.setAttribute("height", (d.throttle * 60).toFixed(1));
      throttleBar.current?.setAttribute("y", (64 - d.throttle * 60).toFixed(1));
      trimMark.current?.setAttribute("y", (33 - d.trim * 28).toFixed(1));
      flapMark.current?.setAttribute("y", (5 + (d.flaps / 30) * 56).toFixed(1));
      stickDot.current?.setAttribute("cx", (32 + d.stickX * 26).toFixed(1));
      stickDot.current?.setAttribute("cy", (32 + d.stickY * 26).toFixed(1));
      if (stallLamp.current) stallLamp.current.dataset.on = String(d.stall);
      if (brakeLamp.current) {
        brakeLamp.current.dataset.on = String(d.brake || d.parkingBrake);
        brakeLamp.current.textContent =
          kind === "heli"
            ? t.vortexRing
            : d.parkingBrake
              ? t.parkingBrake
              : t.brake;
      }

      // Digits change too fast to read every frame.
      const now = performance.now();
      if (now - lastText > 150) {
        lastText = now;
        if (altText.current)
          altText.current.textContent = format.format(
            Math.round(altitude / 10) * 10,
          );
        if (headingText.current)
          headingText.current.textContent = format
            .format(Math.round(d.heading) % 360)
            .padStart(3, format.format(0));
      }
    });
    return () => bridge.attach(null);
    // The angle helpers only depend on the unit system.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, format, metric, kind, t.brake, t.parkingBrake, t.vortexRing]);

  const lamp =
    "rounded-md border border-night-line px-2 py-1 text-center text-[0.65rem] font-bold tracking-wide uppercase text-night-muted";

  return (
    <div
      dir="ltr"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-wrap items-end justify-center gap-x-3 gap-y-2 p-3 pb-8"
    >
      {/* Yoke position, with the lights above it */}
      <div className="flex flex-col items-stretch gap-1.5 rounded-xl bg-night/75 p-2 backdrop-blur">
        <span
          ref={stallLamp}
          className={`${lamp} data-[on=true]:border-red-400 data-[on=true]:bg-red-500 data-[on=true]:text-white`}
        >
          {kind === "heli" ? t.lowRotor : t.stall}
        </span>
        <span
          ref={brakeLamp}
          className={`${lamp} data-[on=true]:border-amber-300 data-[on=true]:bg-amber-400 data-[on=true]:text-night`}
        >
          {kind === "heli" ? t.vortexRing : t.brake}
        </span>
        <svg
          width={64}
          height={64}
          viewBox="0 0 64 64"
          role="img"
          aria-label={t.yoke}
        >
          <rect
            x={4}
            y={4}
            width={56}
            height={56}
            rx={6}
            fill="#0b1118"
            stroke="#263241"
            strokeWidth={1.5}
          />
          <line x1={32} y1={8} x2={32} y2={56} stroke="#263241" />
          <line x1={8} y1={32} x2={56} y2={32} stroke="#263241" />
          <circle ref={stickDot} cx={32} cy={32} r={4.5} fill="#2cc4ae" />
        </svg>
      </div>

      <div className="flex flex-wrap items-end justify-center gap-2 rounded-2xl bg-night/75 p-2.5 backdrop-blur">
        <Dial title={t.airspeed} unit={metric ? t.kmh : t.knots}>
          <Scale
            values={range(0, u.speedMax, u.speedStep * 2)}
            minor={range(0, u.speedMax, u.speedStep)}
            angleOf={speedAngle}
            label={n}
          />
          <Needle innerRef={speedNeedle} />
        </Dial>

        <Dial title={t.attitude}>
          <clipPath id="attitude-clip">
            <circle cx={C} cy={C} r={R} />
          </clipPath>
          <g clipPath="url(#attitude-clip)">
            <g ref={horizon}>
              <rect
                x={-100}
                y={-200}
                width={SIZE + 200}
                height={C + 200}
                fill="#3d7fc4"
              />
              <rect
                x={-100}
                y={C}
                width={SIZE + 200}
                height={300}
                fill="#7a5a3a"
              />
              <line
                x1={-100}
                y1={C}
                x2={SIZE + 100}
                y2={C}
                stroke="#fff"
                strokeWidth={1.2}
              />
              {[-20, -10, 10, 20].map((deg) => (
                <line
                  key={deg}
                  x1={C - (deg % 20 ? 9 : 14)}
                  x2={C + (deg % 20 ? 9 : 14)}
                  y1={C - deg * 1.3}
                  y2={C - deg * 1.3}
                  stroke="#fff"
                  strokeWidth={1}
                />
              ))}
            </g>
          </g>
          <path
            d={`M ${C - 22} ${C} h 12 l 5 5 M ${C + 22} ${C} h -12 l -5 5`}
            stroke="#ffd166"
            strokeWidth={2.4}
            fill="none"
            strokeLinecap="round"
          />
          <circle cx={C} cy={C} r={1.8} fill="#ffd166" />
          <path d={`M ${C} ${C - R + 1} l -4 7 h 8 z`} fill="#ffd166" />
        </Dial>

        <Dial title={t.altitude} unit={metric ? t.metres : t.feet}>
          <Scale values={range(0, 9, 1)} angleOf={(v) => v * 36} label={n} />
          <text
            ref={altText}
            x={C}
            y={C + 20}
            fill="#fff"
            fontSize={11}
            fontWeight={700}
            textAnchor="middle"
          />
          <Needle innerRef={altNeedle} />
        </Dial>

        <Dial
          title={t.climb}
          unit={metric ? t.metresPerSecond : t.feetPerMinute}
        >
          <Scale
            values={range(-u.climbMax, u.climbMax, u.climbStep * 2)}
            minor={range(-u.climbMax, u.climbMax, u.climbStep)}
            angleOf={climbAngle}
            label={(v) => n(Math.abs(v))}
          />
          <Needle innerRef={climbNeedle} />
        </Dial>

        <Dial title={t.heading}>
          <g ref={compass}>
            <Scale
              values={[0, 90, 180, 270]}
              minor={range(0, 330, 30)}
              angleOf={(v) => v}
              label={(v) =>
                ({ 0: t.north, 90: t.east, 180: t.south, 270: t.west })[v] ?? ""
              }
            />
          </g>
          <path
            d={`M ${C} ${C - R + 1} l -4 -6 h 8 z`}
            fill="#ffd166"
            transform={`translate(0 6)`}
          />
          <text
            ref={headingText}
            x={C}
            y={C + 1}
            fill="#fff"
            fontSize={13}
            fontWeight={700}
            textAnchor="middle"
            dominantBaseline="central"
          />
        </Dial>

        <Dial
          title={kind === "jet" ? t.engine : kind === "heli" ? t.rotor : t.rpm}
          unit={kind === "jet" || kind === "heli" ? "%" : "×100"}
        >
          <Scale
            values={range(0, 3000, 500)}
            minor={range(0, 3000, 250)}
            angleOf={rpmAngle}
            label={(v) =>
              n(
                kind === "jet" || kind === "heli"
                  ? Math.round(v / engineScale)
                  : v / 100,
              )
            }
          />
          <path
            d={`M ${polar(rpmAngle(kind === "heli" ? 2375 : 2100), R - 1).join(" ")} A ${R - 1} ${R - 1} 0 0 1 ${polar(rpmAngle(kind === "heli" ? 2625 : 2700), R - 1).join(" ")}`}
            stroke="#2cc4ae"
            strokeWidth={2.5}
            fill="none"
          />
          <Needle innerRef={rpmNeedle} />
        </Dial>
      </div>

      {/* Levers: throttle, flaps, trim */}
      <div className="flex items-end gap-2 rounded-xl bg-night/75 p-2 backdrop-blur">
        {(
          [
            [
              kind === "heli" ? t.collective : t.throttle,
              <rect
                key="b"
                ref={throttleBar}
                x={5}
                y={64}
                width={10}
                height={0}
                rx={2}
                fill="#2cc4ae"
              />,
            ],
            [
              kind === "heli" ? t.torque : t.flaps,
              <rect
                key="b"
                ref={flapMark}
                x={3}
                y={5}
                width={14}
                height={4}
                rx={1.5}
                fill="#ffd166"
              />,
            ],
            [
              t.trim,
              <rect
                key="b"
                ref={trimMark}
                x={3}
                y={33}
                width={14}
                height={3}
                rx={1.5}
                fill="#fff"
              />,
            ],
          ] as const
        ).map(([label, mark]) => (
          <figure key={label} className="m-0 flex flex-col items-center gap-1">
            <svg
              width={20}
              height={68}
              viewBox="0 0 20 68"
              role="img"
              aria-label={label}
            >
              <rect
                x={5}
                y={4}
                width={10}
                height={60}
                rx={2}
                fill="#0b1118"
                stroke="#263241"
              />
              {label === t.flaps &&
                [0, 1, 2, 3].map((i) => (
                  <line
                    key={i}
                    x1={1}
                    x2={19}
                    y1={7 + (i / 3) * 56}
                    y2={7 + (i / 3) * 56}
                    stroke="#263241"
                  />
                ))}
              {label === t.trim && (
                <line x1={1} x2={19} y1={34.5} y2={34.5} stroke="#7f8b98" />
              )}
              {mark}
            </svg>
            <figcaption className="text-[0.58rem] font-semibold tracking-wide text-night-muted uppercase">
              {label}
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
