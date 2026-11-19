/**
 * Copies MapLibre's self-contained web worker into public/vendor under a
 * version-pinned name. The bundled library otherwise looks for the worker
 * next to its own (hashed) chunk, which does not exist under Next.js.
 */
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkgDir = path.join(root, "node_modules/maplibre-gl");
const { version } = JSON.parse(
  await readFile(path.join(pkgDir, "package.json"), "utf8"),
);
const outDir = path.join(root, "public/vendor");
const target = `maplibre-gl-worker-${version}.mjs`;

await mkdir(outDir, { recursive: true });
for (const file of await readdir(outDir)) {
  if (file.startsWith("maplibre-gl-worker-") && file !== target)
    await rm(path.join(outDir, file));
}
await copyFile(
  path.join(pkgDir, "dist/maplibre-gl-worker.mjs"),
  path.join(outDir, target),
);
console.log(`maplibre worker → public/vendor/${target}`);
