"use client";

import { useEffect, useRef } from "react";

/** The drone camera's image: true colour, monochrome electro-optical, or white-hot thermal. */
export type OpticsMode = "tv" | "eo" | "ir";
export const OPTICS_MODES: OpticsMode[] = ["tv", "eo", "ir"];

/** CSS filters on the map that give each image mode its look (the read-outs stay sharp on top). */
export const OPTICS_FILTER: Record<OpticsMode, string> = {
  tv: "none",
  eo: "grayscale(1) contrast(1.22) brightness(1.04)",
  // Grey ground; what is hot (drones, missiles, fire) is drawn glowing white by the interceptor's layer.
  ir: "grayscale(1) brightness(1.2) contrast(1.35)",
};

/** Everything the camera read-outs show, every frame. Heights in real metres. */
export interface OpticsFrame {
  /** Degrees, 0 = north. */
  heading: number;
  /** Camera elevation, degrees: 0 level, negative looking down. */
  pitch: number;
  /** Degrees, positive banking right. */
  roll: number;
  /** Vertical field of view, degrees. */
  fov: number;
  /** Ground speed and climb, m/s. */
  speed: number;
  climb: number;
  agl: number;
  msl: number;
  lat: number;
  lng: number;
  /** Laser rangefinder return under the crosshair. */
  target: {
    range: number;
    lat: number;
    lng: number;
    elevation: number;
    bearing: number;
  } | null;
  mode: "cruise" | "boost" | "precise";
}

export interface OpticsBridge {
  push(frame: OpticsFrame): void;
  attach(draw: ((frame: OpticsFrame) => void) | null): void;
}

export function createOpticsBridge(): OpticsBridge {
  let draw: ((frame: OpticsFrame) => void) | null = null;
  let last: OpticsFrame | null = null;
  return {
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

const pad = (n: number, width: number) =>
  String(Math.round(Math.abs(n))).padStart(width, "0");
const signed = (n: number, digits = 1) =>
  `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}`;
const thousands = (n: number) => Math.round(n).toLocaleString("en-US");

/** 35°57'23.4"N */
function dms(value: number, positive: string, negative: string) {
  const v = Math.abs(value);
  const d = Math.floor(v);
  const m = Math.floor((v - d) * 60);
  const s = ((v - d) * 60 - m) * 60;
  return `${pad(d, 2)}°${pad(m, 2)}'${s.toFixed(1).padStart(4, "0")}"${value >= 0 ? positive : negative}`;
}

const CARDINAL: Record<number, string> = {
  0: "N",
  45: "NE",
  90: "E",
  135: "SE",
  180: "S",
  225: "SW",
  270: "W",
  315: "NW",
};

/** Read-out colour: phosphor green-white, with a dark edge so it reads over snow and sky alike. */
const INK = "#d9ffe6";
const SHADOW = "0 0 2px rgba(0,0,0,0.95), 0 0 6px rgba(0,0,0,0.6)";

/**
 * A moving scale: tick marks every `step`, labels every `label`, slid so the
 * current value sits at the centre. Ticks come from a fixed pool and are
 * re-labelled as the scale moves, so any range works.
 */
function createTape(
  parent: HTMLElement,
  opts: {
    vertical: boolean;
    length: number;
    pxPer: number;
    step: number;
    label: number;
    wrap?: number;
    side?: "start" | "end";
  },
) {
  const count = Math.ceil(opts.length / (opts.step * opts.pxPer)) + 3;
  const ticks = Array.from({ length: count }, () => {
    const tick = document.createElement("div");
    tick.style.position = "absolute";
    tick.style.background = INK;
    tick.style.boxShadow = SHADOW;
    const text = document.createElement("span");
    text.style.position = "absolute";
    text.style.whiteSpace = "nowrap";
    text.style.fontSize = "11px";
    text.style.textShadow = SHADOW;
    tick.appendChild(text);
    parent.appendChild(tick);
    return { tick, text };
  });
  return (value: number, format: (v: number) => string) => {
    const first =
      Math.floor((value - opts.length / 2 / opts.pxPer) / opts.step) *
      opts.step;
    ticks.forEach(({ tick, text }, i) => {
      const v = first + i * opts.step;
      const offset = (v - value) * opts.pxPer + opts.length / 2;
      const shown = offset >= 0 && offset <= opts.length;
      tick.style.display = shown ? "block" : "none";
      if (!shown) return;
      const labelled =
        Math.round(v / opts.step) % Math.round(opts.label / opts.step) === 0;
      const size = labelled ? 10 : 5;
      const wrapped = opts.wrap ? ((v % opts.wrap) + opts.wrap) % opts.wrap : v;
      if (opts.vertical) {
        tick.style.top = `${opts.length - offset}px`;
        tick.style.width = `${size}px`;
        tick.style.height = "1px";
        if (opts.side === "end") tick.style.left = "0";
        else tick.style.right = "0";
        text.style.top = "-7px";
        if (opts.side === "end") {
          text.style.left = "14px";
          text.style.right = "";
        } else {
          text.style.right = "14px";
          text.style.left = "";
        }
      } else {
        tick.style.left = `${offset}px`;
        tick.style.width = "1px";
        tick.style.height = `${size}px`;
        tick.style.bottom = "0";
        text.style.bottom = "13px";
        text.style.left = "0";
        text.style.transform = "translateX(-50%)";
      }
      text.textContent =
        labelled && v >= (opts.wrap ? -Infinity : 0) ? format(wrapped) : "";
    });
  };
}

/**
 * The drone camera's technical read-outs, laid over the map like a gimbal
 * camera feed: heading tape, pitch ladder turning with the roll, speed and
 * height scales, the reticle, corner brackets, position and time, and the
 * rangefinder's return under the crosshair. Built once and written straight
 * into the DOM every frame.
 */
export function DroneOptics({
  bridge,
  mode,
  visible,
}: {
  bridge: OpticsBridge;
  mode: OpticsMode;
  visible: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const el = (
      css: Partial<CSSStyleDeclaration>,
      parent: HTMLElement = root,
    ) => {
      const node = document.createElement("div");
      Object.assign(
        node.style,
        { position: "absolute", color: INK, textShadow: SHADOW },
        css,
      );
      parent.appendChild(node);
      return node;
    };

    // Heading tape, top centre.
    const headingBox = el({
      left: "50%",
      top: "18px",
      width: "420px",
      height: "34px",
      transform: "translateX(-50%)",
      overflow: "hidden",
    });
    const heading = createTape(headingBox, {
      vertical: false,
      length: 420,
      pxPer: 4,
      step: 5,
      label: 15,
      wrap: 360,
    });
    const headingValue = el({
      left: "50%",
      top: "54px",
      transform: "translateX(-50%)",
      padding: "1px 6px",
      border: `1px solid ${INK}`,
      fontSize: "13px",
      background: "rgba(0,0,0,0.35)",
    });
    el({
      left: "50%",
      top: "48px",
      width: "0",
      height: "0",
      transform: "translateX(-50%)",
      borderLeft: "5px solid transparent",
      borderRight: "5px solid transparent",
      borderBottom: `6px solid ${INK}`,
    });

    // Speed (left) and height (right) scales.
    const tapeLength = 240;
    const speedBox = el({
      left: "max(16px, calc(50% - 330px))",
      top: "50%",
      width: "70px",
      height: `${tapeLength}px`,
      transform: "translateY(-50%)",
      overflow: "hidden",
      borderRight: `1px solid ${INK}`,
    });
    const speed = createTape(speedBox, {
      vertical: true,
      length: tapeLength,
      pxPer: 2,
      step: 10,
      label: 50,
      side: "start",
    });
    const speedValue = el({
      left: "max(16px, calc(50% - 330px))",
      top: "50%",
      transform: "translate(-6px, -50%)",
      padding: "1px 5px",
      border: `1px solid ${INK}`,
      background: "rgba(0,0,0,0.45)",
      fontSize: "13px",
    });
    const speedLabel = el({
      left: "max(16px, calc(50% - 330px))",
      top: `calc(50% - ${tapeLength / 2 + 20}px)`,
      fontSize: "11px",
    });
    const heightBox = el({
      right: "max(16px, calc(50% - 330px))",
      top: "50%",
      width: "70px",
      height: `${tapeLength}px`,
      transform: "translateY(-50%)",
      overflow: "hidden",
      borderLeft: `1px solid ${INK}`,
    });
    const height = createTape(heightBox, {
      vertical: true,
      length: tapeLength,
      pxPer: 1,
      step: 20,
      label: 100,
      side: "end",
    });
    const heightValue = el({
      right: "max(16px, calc(50% - 330px))",
      top: "50%",
      transform: "translate(6px, -50%)",
      padding: "1px 5px",
      border: `1px solid ${INK}`,
      background: "rgba(0,0,0,0.45)",
      fontSize: "13px",
    });
    const heightLabel = el({
      right: "max(16px, calc(50% - 330px))",
      top: `calc(50% - ${tapeLength / 2 + 20}px)`,
      fontSize: "11px",
      textAlign: "right",
    });
    const climbLabel = el({
      right: "max(16px, calc(50% - 330px))",
      top: `calc(50% + ${tapeLength / 2 + 6}px)`,
      fontSize: "11px",
      textAlign: "right",
    });

    // Pitch ladder: rungs every 10°, turned with the roll.
    const ladder = el({ left: "50%", top: "50%", width: "0", height: "0" });
    const rungs = Array.from({ length: 19 }, (_, i) => {
      const angle = (i - 9) * 10;
      const rung = el(
        {
          left: "0",
          width: angle === 0 ? "300px" : "120px",
          height: "0",
          borderTop: `1px ${angle < 0 ? "dashed" : "solid"} ${INK}`,
          opacity: angle === 0 ? "0.75" : "0.55",
        },
        ladder,
      );
      if (angle !== 0) {
        // A gap in the middle for the reticle: two halves with the angle at each end.
        rung.style.borderTop = "none";
        for (const side of [-1, 1]) {
          const half = el(
            {
              top: "0",
              width: "42px",
              height: "0",
              borderTop: `1px ${angle < 0 ? "dashed" : "solid"} ${INK}`,
              [side < 0 ? "left" : "right"]: "0",
            },
            rung,
          );
          const label = el(
            {
              top: "-7px",
              fontSize: "10px",
              [side < 0 ? "left" : "right"]: "-26px",
            },
            half,
          );
          label.textContent = String(angle);
        }
      }
      return { rung, angle };
    });

    // Reticle.
    const reticle = el({ left: "50%", top: "50%", width: "0", height: "0" });
    for (const [x, y, w, h] of [
      [-46, 0, 30, 1],
      [16, 0, 30, 1],
      [0, -46, 1, 30],
      [0, 16, 1, 30],
    ]) {
      el(
        {
          left: `${x}px`,
          top: `${y}px`,
          width: `${w}px`,
          height: `${h}px`,
          background: INK,
          boxShadow: SHADOW,
        },
        reticle,
      );
    }
    for (const [x, y] of [
      [-24, -24],
      [24, -24],
      [-24, 24],
      [24, 24],
    ]) {
      el(
        {
          left: `${x - 3}px`,
          top: `${y - 3}px`,
          width: "6px",
          height: "6px",
          borderTop: y < 0 ? `1px solid ${INK}` : "none",
          borderBottom: y > 0 ? `1px solid ${INK}` : "none",
          borderLeft: x < 0 ? `1px solid ${INK}` : "none",
          borderRight: x > 0 ? `1px solid ${INK}` : "none",
        },
        reticle,
      );
    }

    // Corner brackets.
    for (const [v, h] of [
      ["top", "left"],
      ["top", "right"],
      ["bottom", "left"],
      ["bottom", "right"],
    ] as const) {
      el({
        [v]: "12px",
        [h]: "12px",
        width: "38px",
        height: "38px",
        [`border${v === "top" ? "Top" : "Bottom"}`]: `2px solid ${INK}`,
        [`border${h === "left" ? "Left" : "Right"}`]: `2px solid ${INK}`,
        opacity: "0.8",
      });
    }

    // Data blocks.
    const block = (css: Partial<CSSStyleDeclaration>) =>
      el({ fontSize: "12px", lineHeight: "1.45", whiteSpace: "pre", ...css });
    const topLeft = block({ left: "26px", top: "76px" });
    const topRight = block({ right: "26px", top: "76px", textAlign: "right" });
    const bottomLeft = block({ left: "26px", bottom: "26px" });
    const bottomRight = block({
      right: "26px",
      bottom: "26px",
      textAlign: "right",
    });

    bridge.attach((f) => {
      const pxPerDeg = root.clientHeight / f.fov;
      heading(f.heading, (v) => CARDINAL[v] ?? pad(v, 3));
      headingValue.textContent = `${pad(f.heading % 360, 3)}°`;
      speed(f.speed * 3.6, (v) => String(v));
      speedValue.textContent = String(Math.round(f.speed * 3.6));
      speedLabel.textContent =
        f.mode === "cruise"
          ? "GS KM/H"
          : `GS KM/H · ${f.mode === "boost" ? "BST" : "PRC"}`;
      height(f.agl, (v) => String(v));
      heightValue.textContent = thousands(f.agl);
      heightLabel.textContent = "AGL M";
      climbLabel.textContent = `VS ${signed(f.climb)}`;

      ladder.style.transform = `rotate(${-f.roll}deg)`;
      for (const { rung, angle } of rungs) {
        const y = (f.pitch - angle) * pxPerDeg;
        const shown = Math.abs(y) < root.clientHeight * 0.32;
        rung.style.display = shown ? "block" : "none";
        if (!shown) continue;
        const width = angle === 0 ? 300 : 120;
        rung.style.left = `${-width / 2}px`;
        rung.style.top = `${y}px`;
      }

      const zoom = 37 / f.fov;
      topLeft.textContent = [
        `141 UAV · ${mode === "tv" ? "TV COLOUR" : mode === "eo" ? "EO MONO" : "IR WHT"}`,
        `FOV ${f.fov.toFixed(1)}° · ×${zoom.toFixed(1)}`,
        `PITCH ${signed(f.pitch)}°  ROLL ${signed(f.roll)}°`,
      ].join("\n");
      topRight.textContent = [
        dms(f.lat, "N", "S"),
        dms(f.lng, "E", "W"),
        `MSL ${thousands(f.msl)} M`,
      ].join("\n");
      const t = f.target;
      bottomLeft.textContent = t
        ? [
            `LRF ${thousands(t.range)} M`,
            `TGT ${dms(t.lat, "N", "S")}`,
            `    ${dms(t.lng, "E", "W")}`,
            `ELV ${thousands(t.elevation)} M · BRG ${pad(t.bearing, 3)}°`,
          ].join("\n")
        : ["LRF ----- M", "TGT NO RETURN", "", ""].join("\n");
      bottomRight.textContent = [
        `HDG ${pad(f.heading % 360, 3)}° ${CARDINAL[(Math.round(f.heading / 45) * 45) % 360]}`,
        `GS ${Math.round(f.speed * 3.6)} KM/H`,
        `AGL ${thousands(f.agl)} M`,
      ].join("\n");
    });

    return () => {
      bridge.attach(null);
      root.replaceChildren();
    };
  }, [bridge, mode]);

  // A clock that keeps running when the drone (and its frames) are still.
  useEffect(() => {
    const tick = () => {
      if (clockRef.current)
        clockRef.current.textContent =
          new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 z-[9] font-mono ${visible ? "" : "hidden"}`}
      dir="ltr"
    >
      {/* Scan lines and a vignette for the sensor modes. */}
      {mode !== "tv" && (
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, rgba(0,0,0,0.13) 0px, rgba(0,0,0,0.13) 1px, transparent 1px, transparent 3px), radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.45) 100%)",
          }}
        />
      )}
      <div ref={rootRef} className="absolute inset-0" />
      <span
        ref={clockRef}
        className="absolute top-[58px] left-[26px] text-xs"
        style={{ color: INK, textShadow: SHADOW }}
      />
    </div>
  );
}
