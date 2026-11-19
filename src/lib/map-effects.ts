import type { SkySpecification } from "maplibre-gl";

export const DAY_SKY: SkySpecification = {
  "sky-color": "#a9cbe6",
  "horizon-color": "#eef1f2",
  "fog-color": "#f1eee8",
  "sky-horizon-blend": 0.6,
  "horizon-fog-blend": 0.7,
  "fog-ground-blend": 0.35,
  "atmosphere-blend": 0,
};

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let workerConfigured = false;
/** Use the worker copied to public/vendor by scripts/copy-maplibre-worker.mjs. */
export function configureWorker(maplibre: typeof import("maplibre-gl")) {
  if (workerConfigured) return;
  maplibre.setWorkerUrl(
    `${window.location.origin}/vendor/maplibre-gl-worker-${maplibre.getVersion()}.mjs`,
  );
  workerConfigured = true;
}

export function hasWebGL() {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}
