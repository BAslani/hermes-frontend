# Hermes

Flight games over 141 satellite imagery and 3D terrain of Iran, split out of
map-witel's playground. English only.

- `/` – game picker
- `/play/drone` – drone free flight (also kept in map-witel)
- `/play/strike` – drone defence
- `/play/helicopter` – rescue helicopter missions
- `/play/airplane` – trainer / jet, air races

## Develop

```sh
pnpm install
pnpm dev                 # copies the MapLibre worker, proxies /sat to the tile server
pnpm typecheck && pnpm test && pnpm lint
```

`NEXT_PUBLIC_TILE_SERVER_URL` (see `.env.example`) picks the tile server,
default `https://map.141.ir`.

## Imagery off map.141.ir

Raw `/sat` tiles only allow the 141.ir origin. In dev, `next.config.ts`
proxies them. In production on any other origin, `src/lib/imagery.ts` falls
back to tileserver-gl's rendered satellite tiles (lower quality, with labels).
For full imagery, serve Hermes from a 141.ir origin or proxy `/sat` there too.

## Scripts

- `pnpm capture-previews` – landing card images from the running dev server
- `node scripts/design-courses.mts` / `design-missions.mts` / `design-strikes.mts` – level design renders
- `pnpm render-flight`, `node scripts/jet-takeoff-diag.mts` – flight renders and diagnostics

`maplibre-gl` is pinned exactly: the sims reach into `map._camera`, a private API.
