import Link from "next/link";
import type { Vehicle } from "@/components/playground/PlaygroundCard";
import { en } from "@/content/en";

const t = en.home;
const games = Object.entries(en.games) as [
  Vehicle,
  (typeof en.games)[Vehicle],
][];

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-16 sm:px-8 sm:py-24">
      <h1 className="t-h3 text-white">{t.title}</h1>
      <p className="mt-3 max-w-xl text-lg">{t.tagline}</p>
      <p className="mt-1 text-sm text-night-muted">{t.desktopNote}</p>

      <ul className="mt-10 grid gap-4 sm:grid-cols-2">
        {games.map(([id, game]) => (
          <li key={id}>
            <Link
              href={`/play/${id}`}
              className="group flex h-full flex-col overflow-hidden rounded-2xl border border-night-line bg-night-2 hover:border-accent-bright"
            >
              {/* biome-ignore lint/performance/noImgElement: static previews, no optimisation needed */}
              <img
                src={`/games/${id}.webp`}
                alt=""
                width={640}
                height={360}
                className="aspect-video w-full bg-night-3 object-cover"
              />
              <span className="flex flex-1 flex-col gap-1 p-5">
                <span className="font-semibold text-white">{game.title}</span>
                <span className="text-sm">{game.blurb}</span>
                <span className="mt-3 text-sm font-semibold text-accent-bright">
                  {t.play} <span aria-hidden>→</span>
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
