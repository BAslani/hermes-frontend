/**
 * The tile stack the games fly over, served from map.141.ir: tileserver-gl
 * for styles, fonts, rendered raster and the terrain DEM, plus raw imagery
 * under /sat.
 *
 * This file must stay free of imports: the level-design scripts load it
 * directly with Node's type stripping.
 */

export const TILE_SERVER_URL = (
  process.env.NEXT_PUBLIC_TILE_SERVER_URL ?? "https://map.141.ir"
).replace(/\/$/, "");

/** Style ids exactly as registered in tileserver-gl's config.json. */
export type ServerStyleId =
  | "bright"
  | "dark"
  | "dark-night"
  | "bright-terrain"
  | "dark-terrain"
  | "satellite"
  | "satellite-terrain"
  | "bright-classified"
  | "dark-classified";

export const styleUrl = (id: ServerStyleId) =>
  `${TILE_SERVER_URL}/styles/${id}/style.json`;

/** Server-side rendered raster tiles of a style (256px tiles, @2x for crisp displays). */
export const rasterTilesUrl = (id: ServerStyleId) =>
  `${TILE_SERVER_URL}/styles/${id}/{z}/{x}/{y}@2x.png`;

export const TERRAIN_TILEJSON_URL = `${TILE_SERVER_URL}/data/terrain.json`;
export const BASEMAP_TILEJSON_URL = `${TILE_SERVER_URL}/data/141.json`;
export const GLYPHS_URL = `${TILE_SERVER_URL}/fonts/{fontstack}/{range}.pbf`;

/** Attribution required by the underlying data licences, for the client-side assembled style. */
export const BASEMAP_ATTRIBUTION =
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>';
export const TERRAIN_ATTRIBUTION = "Elevation: Copernicus DEM";

/** Elevation data coverage, from https://map.141.ir/data/terrain.json */
export const TERRAIN_BOUNDS: [number, number, number, number] = [
  44.0, 25.0, 65.0, 41.0,
];
export const TERRAIN_MAX_ZOOM = 12;

/**
 * Raw imagery tiles. They send `Access-Control-Allow-Origin: https://141.ir`,
 * so browsers can only use them from the same origin (map.141.ir itself) or
 * the dev proxy; see `imageryTilesUrl()` in src/lib/imagery.ts for the fallback.
 */
export const SATELLITE_TILE_PATH = "/sat/{z}/{x}/{y}.jpg";

/** Zoom tiers exactly as declared by the served `satellite` style. */
export const SATELLITE_TIERS = [
  { id: "base", minzoom: 0, maxzoom: 16 },
  { id: "hi", minzoom: 17, maxzoom: 18 },
  { id: "z19", minzoom: 19, maxzoom: 19 },
] as const;

/** Where the map opens before a game starts: north-east of Tehran, looking at the Alborz. */
export const START_CAMERA = {
  center: [51.68064, 35.78821] as [number, number],
  zoom: 15.07,
  bearing: 142.5,
  pitch: 65,
};
