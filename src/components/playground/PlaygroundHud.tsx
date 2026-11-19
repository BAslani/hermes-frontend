"use client";

import { useSyncExternalStore } from "react";
import type { Dictionary, Locale } from "@/content";
import type { HudStore } from "./hud-store";

type Strings = Dictionary["playgroundPage"];

/** One pair of formatters per locale, shared by every render. */
const formatters = new Map<
  Locale,
  { whole: Intl.NumberFormat; coord: Intl.NumberFormat }
>();
function formattersFor(locale: Locale) {
  let found = formatters.get(locale);
  if (!found) {
    const tag = "en-US";
    found = {
      whole: new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }),
      coord: new Intl.NumberFormat(tag, {
        minimumFractionDigits: 4,
        maximumFractionDigits: 4,
      }),
    };
    formatters.set(locale, found);
  }
  return found;
}

const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const cardinal = (heading: number) => CARDINALS[Math.round(heading / 45) % 8];

const getNothing = () => null;

/**
 * The flight readout and its notices. It subscribes to the HUD store itself,
 * so values changing ten times a second never re-render the page around it.
 */
export function PlaygroundHud({
  store,
  locale,
  t,
  flying,
  readout = true,
}: {
  store: HudStore;
  locale: Locale;
  t: Strings;
  flying: boolean;
  /** The speed / height / heading cells; off when the camera read-outs show them instead. */
  readout?: boolean;
}) {
  const hud = useSyncExternalStore(store.subscribe, store.get, getNothing);
  if (!hud) return null;
  const { whole, coord } = formattersFor(locale);

  return (
    <>
      <div
        role="status"
        aria-live="off"
        className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 flex-wrap items-end justify-center gap-2 p-4 pb-10 sm:gap-3 ${readout ? "flex" : "hidden"}`}
      >
        <HudCell
          label={t.hud.speed}
          value={whole.format(hud.speed)}
          unit={t.hud.kmh}
        />
        <HudCell
          label={t.hud.height}
          value={whole.format(hud.height)}
          unit={t.hud.metres}
        />
        <HudCell
          label={t.hud.heading}
          value={`${whole.format(hud.heading)}°`}
          unit={cardinal(hud.heading)}
        />
        <HudCell
          label={t.hud.ground}
          value={whole.format(hud.ground)}
          unit={t.hud.metres}
        />
        <div
          className="hidden rounded-xl bg-night/70 px-3 py-2 font-mono text-xs text-night-body backdrop-blur md:block"
          dir="ltr"
        >
          {coord.format(hud.lat)}, {coord.format(hud.lng)}
        </div>
        {hud.mode !== "cruise" && (
          <div className="rounded-xl bg-accent-bright px-3 py-2 text-xs font-semibold text-night">
            {hud.mode === "boost" ? t.hud.boost : t.hud.precise}
          </div>
        )}
      </div>

      {flying && hud.tilesLoading && (
        <div
          role="status"
          className="pointer-events-none absolute top-16 inset-s-4 z-10 flex items-center gap-2 rounded-full bg-night/70 px-3 py-1.5 text-xs font-medium backdrop-blur"
        >
          <span
            className="size-1.5 animate-pulse rounded-full bg-accent-bright"
            aria-hidden
          />
          {t.loadingTiles}
        </div>
      )}

      {hud.edge !== "clear" && (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-0 top-28 z-10 flex justify-center px-4"
        >
          <div
            className={`rounded-full px-4 py-2 text-sm font-semibold backdrop-blur ${
              hud.edge === "edge"
                ? "bg-accent-bright text-night"
                : "bg-night/75 text-white"
            }`}
          >
            {hud.edge === "edge" ? t.edgeReached : t.edgeNear}
          </div>
        </div>
      )}
    </>
  );
}

function HudCell({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit: string;
}) {
  return (
    <div className="min-w-24 rounded-xl bg-night/70 px-3 py-2 backdrop-blur">
      <div className="text-[0.65rem] font-semibold tracking-wide text-night-muted uppercase">
        {label}
      </div>
      <div className="font-mono text-lg leading-tight tabular-nums">
        {value} <span className="text-xs text-night-body">{unit}</span>
      </div>
    </div>
  );
}
