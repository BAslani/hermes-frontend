/**
 * External destinations used by the landing page. Every default below was
 * verified against the live 141 properties; each can be overridden at build
 * time without touching components (e.g. when the APK version changes).
 */

const env = (value: string | undefined, fallback: string) =>
  value && value.trim() !== "" ? value.trim() : fallback;

export const SITE_URL = env(
  process.env.NEXT_PUBLIC_SITE_URL,
  "https://map.141.ir",
).replace(/\/$/, "");

export const LINKS = {
  /** The full interactive 141 map. */
  exploreMap: env(process.env.NEXT_PUBLIC_EXPLORE_MAP_URL, "https://141.ir/"),
  /** Official page of the 141 mobile application. */
  appPage: env(
    process.env.NEXT_PUBLIC_APP_PAGE_URL,
    "https://141.ir/application",
  ),
  about141: env(process.env.NEXT_PUBLIC_ABOUT_URL, "https://141.ir/about-us"),
  home141: "https://141.ir/",
  blog: "https://blog.141.ir/",
  complaints: "https://141.ir/complaints",
  instagram: "https://www.instagram.com/141.ir",
  aparat: "https://www.aparat.com/141",
} as const;

export type StoreId = "bazaar" | "myket" | "apk";

/**
 * App stores listed on https://141.ir/application. Google Play is linked as
 * "#" there, so it is intentionally omitted until a real listing exists.
 */
export const APP_STORES: { id: StoreId; href: string }[] = [
  {
    id: "bazaar",
    href: env(
      process.env.NEXT_PUBLIC_APP_BAZAAR_URL,
      "https://cafebazaar.ir/app/witel.app.v141",
    ),
  },
  {
    id: "myket",
    href: env(
      process.env.NEXT_PUBLIC_APP_MYKET_URL,
      "https://myket.ir/app/witel.app.v141",
    ),
  },
  {
    id: "apk",
    // Versioned file name — update NEXT_PUBLIC_APP_APK_URL on each release.
    href: env(
      process.env.NEXT_PUBLIC_APP_APK_URL,
      "https://api.141.ir/storage/apk-files/141-v110.apk",
    ),
  },
];
