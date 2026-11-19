/**
 * Shared helpers for the design scripts: small geodesy, and the 141 DEM
 * (Terrain-RGB tiles at zoom 12, cached on disk) as an elevation lookup.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { TILE_SERVER_URL } from "../../src/config/map.ts";

export const ROOT = path.resolve(import.meta.dirname, "../..");
/** DEM tiles are cached here (git-ignored). */
const CACHE_DIR = path.join(ROOT, "scripts/courses/.cache");
export const R = 6371008.8;
export const RAD = Math.PI / 180;
export type LngLat = [number, number];

export const offset = (
  [lng, lat]: LngLat,
  east: number,
  north: number,
): LngLat => [
  lng + east / (R * Math.cos(lat * RAD) * RAD),
  lat + north / (R * RAD),
];
export const ahead = (p: LngLat, heading: number, d: number) =>
  offset(p, Math.sin(heading * RAD) * d, Math.cos(heading * RAD) * d);
export const dist = (a: LngLat, b: LngLat) =>
  Math.hypot((b[0] - a[0]) * RAD * Math.cos(a[1] * RAD), (b[1] - a[1]) * RAD) *
  R;
export const bearing = (a: LngLat, b: LngLat) =>
  (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * RAD), b[1] - a[1]) / RAD + 360) %
  360;
export const round = (v: number, d = 5) => Number(v.toFixed(d));

/* ------------------------------------------------------------------------ */
/* DEM                                                                       */
/* ------------------------------------------------------------------------ */

export const DZ = 12;
export const TILE = 512;
export const tileX = (lng: number, z: number) => ((lng + 180) / 360) * 2 ** z;
export const tileY = (lat: number, z: number) =>
  ((1 - Math.log(Math.tan(lat * RAD) + 1 / Math.cos(lat * RAD)) / Math.PI) /
    2) *
  2 ** z;

export interface Dem {
  elev(p: LngLat): number;
}

const CACHE = CACHE_DIR;
async function demTile(tx: number, ty: number): Promise<Buffer> {
  const file = path.join(CACHE, `${DZ}-${tx}-${ty}.png`);
  try {
    return await readFile(file);
  } catch {
    /* not cached yet */
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(
        `${TILE_SERVER_URL}/data/terrain/${DZ}/${tx}/${ty}.png`,
      );
      if (!res.ok) throw new Error(`DEM tile ${tx}/${ty}: HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      await mkdir(CACHE, { recursive: true });
      await writeFile(file, buffer);
      return buffer;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

export async function loadDem(center: LngLat, radius: number): Promise<Dem> {
  const [west, south] = offset(center, -radius, -radius);
  const [east, north] = offset(center, radius, radius);
  const tx0 = Math.floor(tileX(west, DZ));
  const tx1 = Math.floor(tileX(east, DZ));
  const ty0 = Math.floor(tileY(north, DZ));
  const ty1 = Math.floor(tileY(south, DZ));
  const W = (tx1 - tx0 + 1) * TILE;
  const H = (ty1 - ty0 + 1) * TILE;
  const grid = new Float32Array(W * H);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const { data, info } = await sharp(await demTile(tx, ty))
        .raw()
        .toBuffer({ resolveWithObject: true });
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const i = (y * TILE + x) * info.channels;
          grid[((ty - ty0) * TILE + y) * W + (tx - tx0) * TILE + x] =
            -10000 + (data[i] * 65536 + data[i + 1] * 256 + data[i + 2]) * 0.1;
        }
      }
    }
  }
  return {
    elev([lng, lat]) {
      const x = tileX(lng, DZ) * TILE - tx0 * TILE;
      const y = tileY(lat, DZ) * TILE - ty0 * TILE;
      const x0 = Math.max(0, Math.min(W - 2, Math.floor(x)));
      const y0 = Math.max(0, Math.min(H - 2, Math.floor(y)));
      const fx = x - x0;
      const fy = y - y0;
      const g = (xx: number, yy: number) => grid[yy * W + xx];
      return (
        g(x0, y0) * (1 - fx) * (1 - fy) +
        g(x0 + 1, y0) * fx * (1 - fy) +
        g(x0, y0 + 1) * (1 - fx) * fy +
        g(x0 + 1, y0 + 1) * fx * fy
      );
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Course shapes                                                             */
/* ------------------------------------------------------------------------ */
