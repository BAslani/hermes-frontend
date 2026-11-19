/**
 * Captures the landing-page card images (public/games/<id>.webp) from the
 * running dev server: opens each game, waits for its start card, hides the
 * card and screenshots the map behind it.
 *
 *   pnpm dev   # in another terminal
 *   pnpm capture-previews [baseUrl]
 *
 * CHROME_PATH overrides the browser (defaults to Chrome's Windows location).
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { en } from "../src/content/en.ts";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = path.join(import.meta.dirname, "../public/games");
const CHROME =
  process.env.CHROME_PATH ??
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ["--use-angle=default", "--enable-unsafe-swiftshader"],
  defaultViewport: { width: 1280, height: 720 },
});
try {
  for (const id of Object.keys(en.games)) {
    const page = await browser.newPage();
    await page.goto(`${BASE}/play/${id}`);
    // The start card appears once the map and the vehicle are ready.
    await page.waitForSelector("h1", { timeout: 120_000 });
    // Let the last imagery tiles arrive, then hide every overlay but the map.
    await new Promise((r) => setTimeout(r, 4000));
    await page.addStyleTag({
      content: ".z-10, .z-20, nextjs-portal { display: none !important; }",
    });
    await new Promise((r) => setTimeout(r, 500));
    const png = await page.screenshot();
    await sharp(png)
      .resize(640, 360)
      .webp({ quality: 78 })
      .toFile(path.join(OUT, `${id}.webp`));
    console.log(`games/${id}.webp`);
    await page.close();
  }
} finally {
  await browser.close();
}
