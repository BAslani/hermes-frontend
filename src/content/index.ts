import { type Dictionary, en } from "./en";

/** English only for now; components still take a locale so another language can be added later. */
export type Locale = "en";

export const LOCALES: Record<Locale, { dict: Dictionary; dir: "ltr" | "rtl" }> =
  {
    en: { dict: en, dir: "ltr" },
  };

export type { Dictionary };

/** Title and description of a game page under /play. */
export const gameMetadata = (game: keyof typeof en.games) => ({
  title: `${en.games[game].title} — Hermes`,
  description: en.games[game].blurb,
});
