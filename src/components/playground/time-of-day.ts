import type { Map as MapLibreMap, SkySpecification } from "maplibre-gl";
import type { Vec3 } from "@/lib/flight/vec";
import { DAY_SKY } from "@/lib/map-effects";

/**
 * Light for a race: the sky and haze, a grade on the satellite imagery, and
 * the sun the three.js models are lit by. The imagery is a daytime photo, so
 * dawn and sunset come from a low, coloured sun on the models, a coloured
 * horizon and haze, and a darker, warmer or cooler grade on the ground.
 */
export type TimeOfDay = "day" | "dawn" | "sunset" | "night";

export interface SceneLight {
  /** Towards the sun, east-north-up. */
  sun: Vec3;
  sunColor: number;
  sunIntensity: number;
  skyColor: number;
  groundColor: number;
  skyIntensity: number;
}

interface Look {
  sky: SkySpecification;
  raster: {
    "raster-brightness-max": number;
    "raster-brightness-min": number;
    "raster-saturation": number;
    "raster-contrast": number;
    "raster-hue-rotate": number;
  };
  light: SceneLight;
}

export const DAY_LIGHT: SceneLight = {
  sun: [0.45, -0.35, 0.82],
  sunColor: 0xfff4e0,
  sunIntensity: 2.4,
  skyColor: 0xdfeaf5,
  groundColor: 0x6f6a5c,
  skyIntensity: 1.5,
};

const NEUTRAL = {
  "raster-brightness-max": 1,
  "raster-brightness-min": 0,
  "raster-saturation": 0,
  "raster-contrast": 0,
  "raster-hue-rotate": 0,
};

export const LOOKS: Record<TimeOfDay, Look> = {
  day: { sky: DAY_SKY, raster: NEUTRAL, light: DAY_LIGHT },
  sunset: {
    sky: {
      "sky-color": "#55709f",
      "horizon-color": "#ffae66",
      "fog-color": "#e99a63",
      "sky-horizon-blend": 0.8,
      "horizon-fog-blend": 0.8,
      "fog-ground-blend": 0.3,
      "atmosphere-blend": 0,
    },
    raster: {
      "raster-brightness-max": 0.84,
      "raster-brightness-min": 0.03,
      "raster-saturation": 0.15,
      "raster-contrast": 0.14,
      "raster-hue-rotate": -7,
    },
    light: {
      // Low in the west.
      sun: [-0.9, 0.12, 0.2],
      sunColor: 0xff9f55,
      sunIntensity: 2.8,
      skyColor: 0xf2c49a,
      groundColor: 0x46372b,
      skyIntensity: 1.05,
    },
  },
  // Moonlight: a dark blue sky, the imagery dim and cold, the models lit faintly from above.
  night: {
    sky: {
      "sky-color": "#060b1a",
      "horizon-color": "#1b2740",
      "fog-color": "#0f1626",
      "sky-horizon-blend": 0.7,
      "horizon-fog-blend": 0.8,
      "fog-ground-blend": 0.35,
      "atmosphere-blend": 0,
    },
    raster: {
      "raster-brightness-max": 0.3,
      "raster-brightness-min": 0,
      "raster-saturation": -0.6,
      "raster-contrast": 0.12,
      "raster-hue-rotate": 12,
    },
    light: {
      sun: [-0.3, 0.4, 0.86],
      sunColor: 0x9fb4ff,
      sunIntensity: 0.45,
      skyColor: 0x2a3a5e,
      groundColor: 0x0c0f16,
      skyIntensity: 0.4,
    },
  },
  dawn: {
    sky: {
      "sky-color": "#7489bd",
      "horizon-color": "#f7c2c4",
      "fog-color": "#e6c6cf",
      "sky-horizon-blend": 0.75,
      "horizon-fog-blend": 0.85,
      "fog-ground-blend": 0.4,
      "atmosphere-blend": 0,
    },
    raster: {
      "raster-brightness-max": 0.9,
      "raster-brightness-min": 0.04,
      "raster-saturation": -0.08,
      "raster-contrast": 0.06,
      "raster-hue-rotate": 5,
    },
    light: {
      // Low in the east.
      sun: [0.88, 0.25, 0.28],
      sunColor: 0xffc6a8,
      sunIntensity: 2.3,
      skyColor: 0xd6d6f2,
      groundColor: 0x5a5260,
      skyIntensity: 1.2,
    },
  },
};

type RasterProperty = keyof Look["raster"];

/** A full storm: grey sky and thick haze close in; the ground goes pale and washed out under snow. */
const STORM_SKY = {
  "sky-color": "#8b949d",
  "horizon-color": "#c7ccd1",
  "fog-color": "#d3d7db",
  "sky-horizon-blend": 1,
  "horizon-fog-blend": 1,
  "fog-ground-blend": 0.92,
};
const STORM_RASTER = {
  "raster-saturation": -0.55,
  "raster-brightness-min": 0.22,
  "raster-contrast": -0.15,
};

const hex = (c: string) =>
  [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mixColour = (a: string, b: string, t: number) =>
  `#${hex(a)
    .map((v, i) =>
      Math.round(v + (hex(b)[i] - v) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/**
 * The storm closing in on the map, by strength 0–1: the sky and haze blend
 * towards STORM_SKY, the imagery towards STORM_RASTER. Returns a setter (call
 * it a few times a second as the storm builds) and a restore.
 */
export function stormLook(map: MapLibreMap) {
  const base = { ...DAY_SKY, ...(map.getSky() ?? {}) } as Record<
    string,
    unknown
  >;
  const rasters = (map.getStyle().layers ?? [])
    .filter((layer) => layer.type === "raster")
    .map((layer) => layer.id);
  const saved = rasters.map((id) => ({
    id,
    values: Object.fromEntries(
      (Object.keys(STORM_RASTER) as (keyof typeof STORM_RASTER)[]).map(
        (key) => [key, map.getPaintProperty(id, key)],
      ),
    ) as Record<keyof typeof STORM_RASTER, number | undefined>,
  }));
  let last = -1;
  return {
    set(strength: number) {
      const t = Math.round(Math.min(1, Math.max(0, strength)) * 40) / 40;
      if (t === last) return;
      last = t;
      const sky: Record<string, unknown> = { ...base };
      for (const [key, value] of Object.entries(STORM_SKY)) {
        const from = base[key];
        sky[key] =
          typeof value === "string" &&
          typeof from === "string" &&
          from.startsWith("#") &&
          from.length === 7
            ? mixColour(from, value, t)
            : typeof value === "number"
              ? (typeof from === "number" ? from : 0) +
                (value - (typeof from === "number" ? from : 0)) * t
              : value;
      }
      try {
        map.setSky(sky as SkySpecification);
        for (const { id, values } of saved) {
          for (const key of Object.keys(
            STORM_RASTER,
          ) as (keyof typeof STORM_RASTER)[]) {
            const from = values[key] ?? 0;
            map.setPaintProperty(
              id,
              key,
              from + (STORM_RASTER[key] - from) * t,
            );
          }
        }
      } catch {
        /* the map is gone */
      }
    },
    restore() {
      try {
        map.setSky(base as SkySpecification);
        for (const { id, values } of saved) {
          if (!map.getLayer(id)) continue;
          for (const key of Object.keys(
            STORM_RASTER,
          ) as (keyof typeof STORM_RASTER)[])
            map.setPaintProperty(id, key, values[key] ?? undefined);
        }
      } catch {
        /* the map is gone */
      }
    },
  };
}

/** Apply a look to the map; returns a function that puts the previous one back. */
export function applyLook(map: MapLibreMap, time: TimeOfDay): () => void {
  const look = LOOKS[time];
  const previousSky = map.getSky();
  const rasters = (map.getStyle().layers ?? [])
    .filter((layer) => layer.type === "raster")
    .map((layer) => layer.id);
  const saved = rasters.map((id) => ({
    id,
    values: Object.fromEntries(
      (Object.keys(look.raster) as RasterProperty[]).map((key) => [
        key,
        map.getPaintProperty(id, key),
      ]),
    ) as Record<RasterProperty, number | undefined>,
  }));
  map.setSky(look.sky);
  const keys = Object.keys(look.raster) as RasterProperty[];
  for (const id of rasters) {
    for (const key of keys) map.setPaintProperty(id, key, look.raster[key]);
  }
  return () => {
    try {
      map.setSky(previousSky ?? DAY_SKY);
      for (const { id, values } of saved) {
        if (!map.getLayer(id)) continue;
        for (const key of keys)
          map.setPaintProperty(id, key, values[key] ?? undefined);
      }
    } catch {
      /* the map is gone */
    }
  };
}
