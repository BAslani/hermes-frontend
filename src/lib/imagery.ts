import type {
  LayerSpecification,
  SourceSpecification,
  StyleSpecification,
} from "maplibre-gl";
import {
  BASEMAP_ATTRIBUTION,
  BASEMAP_TILEJSON_URL,
  GLYPHS_URL,
  rasterTilesUrl,
  SATELLITE_TIERS,
  SATELLITE_TILE_PATH,
  TERRAIN_ATTRIBUTION,
  TERRAIN_MAX_ZOOM,
  TERRAIN_TILEJSON_URL,
  TILE_SERVER_URL,
} from "@/config/map";

/**
 * Where the browser can read raw imagery tiles from, or null if it cannot.
 *
 * /sat only allows the https://141.ir origin, so raw tiles work when this
 * page is served from the tile server's own origin (map.141.ir in
 * production), and in development through the /sat rewrite in
 * next.config.ts. Anywhere else, callers fall back to imagery rendered by
 * tileserver-gl (which bakes in the satellite style's labels).
 */
export function imageryTilesUrl(): string | null {
  if (typeof window === "undefined") return null;
  const sameOrigin = window.location.origin === new URL(TILE_SERVER_URL).origin;
  if (sameOrigin || process.env.NODE_ENV === "development") {
    return `${window.location.origin}${SATELLITE_TILE_PATH}`;
  }
  return null;
}

/**
 * Served styles reference imagery as absolute https://map.141.ir/sat/… URLs.
 * When the page is not on that origin but can reach /sat itself (the dev
 * proxy), route those requests through it. Returns null to leave a URL as is.
 */
export function rewriteImageryRequest(url: string): string | null {
  const remote = `${TILE_SERVER_URL}/sat/`;
  if (!url.startsWith(remote) || imageryTilesUrl() === null) return null;
  if (window.location.origin === new URL(TILE_SERVER_URL).origin) return null;
  return `${window.location.origin}${url.slice(TILE_SERVER_URL.length)}`;
}

/** Imagery sources + layers, tiered like the served `satellite` style. */
export function imageryLayers(): {
  sources: Record<string, SourceSpecification>;
  layers: LayerSpecification[];
  raw: boolean;
} {
  const tiles = imageryTilesUrl();
  if (!tiles) {
    return {
      raw: false,
      sources: {
        imagery: {
          type: "raster",
          tiles: [rasterTilesUrl("satellite")],
          tileSize: 256,
          maxzoom: 19,
          attribution: BASEMAP_ATTRIBUTION,
        },
      },
      layers: [{ id: "imagery", type: "raster", source: "imagery" }],
    };
  }
  const sources: Record<string, SourceSpecification> = {};
  const layers: LayerSpecification[] = [];
  for (const tier of SATELLITE_TIERS) {
    const id = `imagery-${tier.id}`;
    sources[id] = {
      type: "raster",
      tiles: [tiles],
      tileSize: 256,
      minzoom: tier.minzoom,
      maxzoom: tier.maxzoom,
    };
    // Higher tiers only exist in some areas; lower tiers overzoom beneath them.
    layers.push({
      id,
      type: "raster",
      source: id,
      minzoom: tier.minzoom,
      paint: { "raster-fade-duration": 200 },
    });
  }
  return { raw: true, sources, layers };
}

/** Roads and place names from the 141 basemap, drawn over imagery. */
export function streetsOverlay(visible: boolean): LayerSpecification[] {
  const visibility = visible ? "visible" : "none";
  return [
    {
      id: "streets-casing",
      type: "line",
      source: "basemap",
      "source-layer": "transportation",
      filter: [
        "in",
        ["get", "class"],
        ["literal", ["motorway", "trunk", "primary", "secondary", "tertiary"]],
      ],
      layout: { visibility, "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": "rgba(0,0,0,0.55)",
        "line-width": [
          "interpolate",
          ["exponential", 1.5],
          ["zoom"],
          8,
          2,
          16,
          11,
        ],
      },
    },
    {
      id: "streets",
      type: "line",
      source: "basemap",
      "source-layer": "transportation",
      filter: [
        "in",
        ["get", "class"],
        ["literal", ["motorway", "trunk", "primary", "secondary", "tertiary"]],
      ],
      layout: { visibility, "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": [
          "match",
          ["get", "class"],
          ["motorway", "trunk"],
          "#ffd166",
          ["primary", "secondary"],
          "#ffffff",
          "rgba(255,255,255,0.8)",
        ],
        "line-width": [
          "interpolate",
          ["exponential", 1.5],
          ["zoom"],
          8,
          0.8,
          16,
          6.5,
        ],
      },
    },
    {
      id: "street-names",
      type: "symbol",
      source: "basemap",
      "source-layer": "transportation_name",
      minzoom: 13,
      layout: {
        visibility,
        "symbol-placement": "line",
        "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
        "text-font": ["Ravi Regular"],
        "text-size": 12,
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(0,0,0,0.75)",
        "text-halo-width": 1.4,
      },
    },
    {
      id: "place-names",
      type: "symbol",
      source: "basemap",
      "source-layer": "place",
      layout: {
        visibility,
        "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
        "text-font": ["Ravi Black"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 6, 11, 14, 17],
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "rgba(0,0,0,0.8)",
        "text-halo-width": 1.6,
      },
    },
  ];
}

/** Imagery draped over the 141 terrain model. */
export function satellite3dStyle(): StyleSpecification {
  const imagery = imageryLayers();
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      ...imagery.sources,
      basemap: {
        type: "vector",
        url: BASEMAP_TILEJSON_URL,
        attribution: BASEMAP_ATTRIBUTION,
      },
      dem: {
        type: "raster-dem",
        url: TERRAIN_TILEJSON_URL,
        tileSize: 512,
        maxzoom: TERRAIN_MAX_ZOOM,
        encoding: "mapbox",
        attribution: TERRAIN_ATTRIBUTION,
      },
    },
    terrain: { source: "dem", exaggeration: 1.5 },
    layers: [
      {
        id: "space",
        type: "background",
        paint: { "background-color": "#05080c" },
      },
      ...imagery.layers,
      // Place names only; rendered fallback imagery already carries labels.
      ...(imagery.raw
        ? streetsOverlay(true).filter((l) => l.id === "place-names")
        : []),
    ],
  };
}
