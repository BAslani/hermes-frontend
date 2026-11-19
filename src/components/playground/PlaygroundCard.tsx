"use client";

import { COURSES, type Course } from "@/config/courses";
import { MISSIONS, type MissionConfig } from "@/config/missions";
import {
  AIRPORTS,
  type Airport,
  PLACES,
  type Place,
} from "@/config/playground";
import { STRIKES, type StrikeScenario } from "@/config/strikes";
import type { Dictionary, Locale } from "@/content";
import { en } from "@/content/en";
import { missionMedal } from "@/lib/flight/mission";
import { MISSED_PENALTY, medalFor } from "@/lib/flight/race";
import { strikeMedal } from "@/lib/flight/strike";
import { loadMissionRecord } from "./mission-records";
import { formatRaceTime } from "./RaceHud";
import { loadRecord } from "./race-records";
import { type FlightSettings, MAX_WIND_KNOTS } from "./settings";
import { PLACE_KEYS } from "./sims/drone-sim";
import { loadStrikeRecord } from "./strike-records";

type Strings = Dictionary["playgroundPage"];
/** One per game page. "strike" is the drone flown as an interceptor in a drone-defence scenario. */
export type Vehicle = "drone" | "airplane" | "helicopter" | "strike";

const kbd =
  "min-w-7 rounded-md border border-night-line bg-night-3 px-1.5 py-0.5 text-center font-mono text-xs";
const heading = "mb-3 text-sm font-semibold text-night-muted";
const row =
  "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-start text-night-body hover:bg-night-3 hover:text-white focus-visible:bg-night-3 disabled:pointer-events-none disabled:opacity-50";

/** The start / pause card: controls, places, runways, scenarios and settings. */
export function PlaygroundCard({
  t,
  locale,
  paused,
  touchOnly,
  vehicle,
  settings,
  onSettings,
  onStart,
  onReset,
  onPlace,
  onAirport,
  onCourse,
  onMission,
  onStrike,
}: {
  t: Strings;
  locale: Locale;
  paused: boolean;
  touchOnly: boolean;
  vehicle: Vehicle;
  settings: FlightSettings;
  onSettings(settings: FlightSettings): void;
  onStart(): void;
  onReset(): void;
  onPlace(place: Place): void;
  onAirport(airport: Airport): void;
  onCourse(course: Course): void;
  onMission(mission: MissionConfig): void;
  onStrike(scenario: StrikeScenario): void;
}) {
  const a = t.airplane.controls;
  const h = t.helicopter.controls;
  const s = t.strike.controls;
  const controls: { keys: string[]; action: string }[] =
    vehicle === "strike"
      ? [
          { keys: ["W", "A", "S", "D"], action: t.controls.move },
          { keys: ["Space", "C"], action: t.controls.lift },
          { keys: [t.mouse], action: t.controls.look },
          { keys: ["◎"], action: s.lock },
          { keys: [t.strike.click, "F"], action: s.fire },
          { keys: [t.strike.rightButton, "G"], action: s.gun },
          { keys: ["Shift"], action: t.controls.boost },
          { keys: ["V"], action: t.optics.mode },
          { keys: ["R"], action: s.restart },
          { keys: ["Esc"], action: t.controls.pause },
        ]
      : vehicle === "helicopter"
        ? [
            { keys: [t.mouse], action: h.cyclic },
            {
              keys: ["W", "S"],
              action: settings.assists ? h.collectiveAssisted : h.collective,
            },
            { keys: ["A", "D"], action: h.pedals },
            { keys: ["C"], action: a.camera },
            { keys: [t.airplane.mouseRight], action: a.orbit },
            { keys: ["1–9", "0"], action: h.places },
            { keys: ["R"], action: a.reset },
            { keys: ["Esc"], action: a.pause },
          ]
        : vehicle === "drone"
          ? [
              { keys: ["W", "A", "S", "D"], action: t.controls.move },
              { keys: ["Space", "C"], action: t.controls.lift },
              { keys: [t.mouse], action: t.controls.look },
              { keys: ["←", "→", "↑", "↓"], action: t.controls.turn },
              { keys: ["Shift"], action: t.controls.boost },
              { keys: ["Alt"], action: t.controls.precise },
              { keys: ["V"], action: t.optics.mode },
              { keys: ["1–9", "0"], action: t.controls.places },
              { keys: ["R"], action: t.controls.reset },
              { keys: ["Esc"], action: t.controls.pause },
            ]
          : [
              { keys: [t.mouse], action: a.yoke },
              { keys: ["W", "S"], action: a.throttle },
              { keys: ["A", "D"], action: a.rudder },
              { keys: ["F", "V"], action: a.flaps },
              { keys: ["B"], action: a.brake },
              { keys: ["Shift", "B"], action: a.parkingBrake },
              { keys: ["[", "]"], action: a.trim },
              ...(settings.aircraft === "jet"
                ? [{ keys: ["G"], action: t.aircraft.gear }]
                : []),
              { keys: ["X"], action: t.race.controls.smoke },
              { keys: ["C"], action: a.camera },
              { keys: [t.airplane.mouseRight], action: a.orbit },
              { keys: ["1–9", "0"], action: a.places },
              { keys: ["R"], action: a.reset },
              { keys: ["Esc"], action: a.pause },
            ];
  const toggles = (
    [
      ["assists", t.settings.assists],
      ["selfCentring", t.settings.selfCentring],
      ["metric", t.settings.metric],
      ["sound", t.settings.sound],
    ] as const
  ).filter(([key]) => vehicle !== "strike" || key === "sound");
  const freeFlight = vehicle === "drone" || vehicle === "strike";
  const number = new Intl.NumberFormat("en-US");

  return (
    <div className="absolute inset-0 z-20 flex overflow-y-auto bg-night/40 p-4 backdrop-blur-[2px]">
      <div className="m-auto w-full max-w-3xl rounded-2xl border border-night-line bg-night-2/95 p-6 shadow-2xl sm:p-8">
        <p className="t-eyebrow mb-2 text-accent-bright">
          {paused ? t.paused : t.eyebrow}
        </p>
        <h1 className="t-h3 mb-2 text-white">{en.games[vehicle].title}</h1>
        <p className="mb-5 text-night-body">
          {vehicle === "drone"
            ? t.intro
            : vehicle === "strike"
              ? t.strike.intro
              : vehicle === "helicopter"
                ? t.helicopter.intro
                : t.airplane.intro}
        </p>

        {vehicle === "airplane" && (
          <div className="mb-6">
            <div
              role="radiogroup"
              aria-label={t.aircraft.title}
              className="inline-flex rounded-full border border-night-line bg-night-3 p-1"
            >
              {(["trainer", "jet"] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  role="radio"
                  aria-checked={settings.aircraft === a}
                  onClick={() => onSettings({ ...settings, aircraft: a })}
                  className={`rounded-full px-3.5 py-1 text-xs font-semibold ${
                    settings.aircraft === a
                      ? "bg-white text-night"
                      : "text-night-body hover:text-white"
                  }`}
                >
                  {t.aircraft[a]}
                </button>
              ))}
            </div>
            {settings.aircraft === "jet" && (
              <p className="mt-2 text-xs text-night-muted">
                {t.aircraft.jetNote}
              </p>
            )}
          </div>
        )}

        <div className="mb-6 grid gap-x-10 gap-y-6 md:grid-cols-2">
          <section>
            <h2 className={heading}>{t.controlsTitle}</h2>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
              {controls.map((c) => (
                <div key={c.action} className="contents">
                  <dt className="flex flex-wrap gap-1" dir="ltr">
                    {c.keys.map((k) => (
                      <kbd key={k} className={kbd}>
                        {k}
                      </kbd>
                    ))}
                  </dt>
                  <dd className="text-night-body">{c.action}</dd>
                </div>
              ))}
            </dl>

            {vehicle !== "drone" && (
              <>
                <h2 className={`${heading} mt-6`}>{t.settings.title}</h2>
                <div className="grid gap-2 text-sm text-night-body">
                  {toggles.map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2.5">
                      <input
                        type="checkbox"
                        className="size-4 accent-[#2cc4ae]"
                        checked={settings[key]}
                        onChange={(e) =>
                          onSettings({ ...settings, [key]: e.target.checked })
                        }
                      />
                      {label}
                    </label>
                  ))}
                  {vehicle !== "strike" && (
                    <>
                      <label className="mt-1 grid grid-cols-[5.5rem_1fr_4.5rem] items-center gap-2.5">
                        <span>
                          {t.settings.wind}: {t.settings.windSpeed}
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={MAX_WIND_KNOTS}
                          step={1}
                          className="accent-[#2cc4ae]"
                          value={settings.windKnots}
                          onChange={(e) =>
                            onSettings({
                              ...settings,
                              windKnots: Number(e.target.value),
                            })
                          }
                        />
                        <span className="tabular-nums">
                          {settings.windKnots === 0
                            ? t.settings.calm
                            : `${number.format(settings.windKnots)} ${t.instruments.knots}`}
                        </span>
                      </label>
                      <label className="grid grid-cols-[5.5rem_1fr_4.5rem] items-center gap-2.5">
                        <span>{t.settings.windFrom}</span>
                        <input
                          type="range"
                          min={0}
                          max={350}
                          step={10}
                          className="accent-[#2cc4ae]"
                          value={settings.windFrom}
                          disabled={settings.windKnots === 0}
                          onChange={(e) =>
                            onSettings({
                              ...settings,
                              windFrom: Number(e.target.value),
                            })
                          }
                        />
                        <span className="tabular-nums">
                          {number.format(settings.windFrom)}°
                        </span>
                      </label>
                    </>
                  )}
                </div>
              </>
            )}
          </section>

          <section>
            {vehicle === "strike" && (
              <>
                <h2 className={heading}>{t.strike.title}</h2>
                <ul className="mb-6 grid gap-1 text-sm">
                  {STRIKES.map((scenario) => {
                    // The card only renders in the browser (after the map loads), so reading storage here is safe.
                    const best = loadStrikeRecord(scenario.id);
                    const medal = best
                      ? strikeMedal(best.score, scenario.medals)
                      : null;
                    return (
                      <li key={scenario.id}>
                        <button
                          type="button"
                          disabled={touchOnly}
                          onClick={() => onStrike(scenario)}
                          className={`${row} items-start`}
                        >
                          <span aria-hidden className="mt-0.5 text-[#ff4d4d]">
                            ⌖
                          </span>
                          <span className="grid gap-0.5">
                            <span className="font-medium text-white">
                              {scenario.name[locale]}
                            </span>
                            <span className="text-xs text-night-muted">
                              {scenario.brief[locale]}
                            </span>
                            <span className="text-xs text-night-muted">
                              {best
                                ? `${t.strike.best.replace("{score}", number.format(best.score))}${medal ? ` · ${t.strike.medals[medal]}` : ""}`
                                : t.strike.noScore}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {vehicle === "helicopter" && (
              <>
                <h2 className={heading}>{t.mission.title}</h2>
                <p className="mb-2 text-xs text-night-muted">
                  {t.mission.intro}
                </p>
                <ul className="mb-6 grid gap-1 text-sm">
                  {MISSIONS.map((mission) => {
                    // The card only renders in the browser (after the map loads), so reading storage here is safe.
                    const best = loadMissionRecord(mission.id);
                    const medal = best
                      ? missionMedal(best.score, mission.medals)
                      : null;
                    return (
                      <li key={mission.id}>
                        <button
                          type="button"
                          disabled={touchOnly}
                          onClick={() => onMission(mission)}
                          className={`${row} items-start`}
                        >
                          <span aria-hidden className="mt-0.5 text-[#ff7a2a]">
                            ✚
                          </span>
                          <span className="grid gap-0.5">
                            <span className="font-medium text-white">
                              {mission.name[locale]}
                            </span>
                            <span className="text-xs text-night-muted">
                              {mission.brief[locale]}
                            </span>
                            <span className="text-xs text-night-muted">
                              {best
                                ? `${t.mission.best.replace("{score}", number.format(best.score))}${medal ? ` · ${t.mission.medals[medal]}` : ""}`
                                : t.mission.noScore}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {vehicle === "airplane" && (
              <>
                <h2 className={heading}>{t.race.title}</h2>
                <p className="mb-2 text-xs text-night-muted">
                  {t.race.intro.replace(
                    "{penalty}",
                    number.format(MISSED_PENALTY),
                  )}{" "}
                  {t.race.plane}
                </p>
                <ul className="mb-6 grid gap-1 text-sm">
                  {COURSES.map((course) => {
                    // The card only renders in the browser (after the map loads), so reading storage here is safe.
                    const best = loadRecord(course.id, course.gates.length);
                    const medal = best
                      ? medalFor(best.total, course.medals)
                      : null;
                    return (
                      <li key={course.id}>
                        <button
                          type="button"
                          disabled={touchOnly}
                          onClick={() => onCourse(course)}
                          className={`${row} items-start`}
                        >
                          <span aria-hidden className="mt-0.5 text-[#ffb547]">
                            ◎
                          </span>
                          <span className="grid gap-0.5">
                            <span className="font-medium text-white">
                              {course.name[locale]}
                            </span>
                            <span className="text-xs text-night-muted">
                              {course.description[locale]}
                            </span>
                            <span className="text-xs text-night-muted">
                              {best
                                ? `${t.race.best.replace("{time}", formatRaceTime(locale, best.total))}${medal ? ` · ${t.race.medals[medal]}` : ""}`
                                : t.race.medalTargets
                                    .replace(
                                      "{gold}",
                                      formatRaceTime(
                                        locale,
                                        course.medals.gold,
                                      ),
                                    )
                                    .replace(
                                      "{silver}",
                                      formatRaceTime(
                                        locale,
                                        course.medals.silver,
                                      ),
                                    )
                                    .replace(
                                      "{bronze}",
                                      formatRaceTime(
                                        locale,
                                        course.medals.bronze,
                                      ),
                                    )}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {!freeFlight && (
              <>
                <h2 className={heading}>
                  {vehicle === "helicopter"
                    ? t.helicopter.airportsTitle
                    : t.airplane.airportsTitle}
                </h2>
                <ul className="mb-6 grid gap-1 text-sm">
                  {AIRPORTS.map((airport) => (
                    <li key={airport.id}>
                      <button
                        type="button"
                        disabled={touchOnly}
                        onClick={() => onAirport(airport)}
                        className={row}
                      >
                        <span aria-hidden className="text-accent-bright">
                          ✈
                        </span>
                        {airport.name[locale]}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {vehicle !== "strike" && (
              <h2 className={heading}>{t.placesTitle}</h2>
            )}
            <ul
              className={`grid gap-1 text-sm ${vehicle === "strike" ? "hidden" : ""}`}
            >
              {PLACES.map((place, index) => (
                <li key={place.id}>
                  <button
                    type="button"
                    disabled={touchOnly}
                    onClick={() => onPlace(place)}
                    className={row}
                  >
                    <kbd className={kbd}>{PLACE_KEYS[index]?.slice(-1)}</kbd>
                    {place.name[locale]}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>

        {touchOnly && (
          <p className="mb-4 rounded-lg bg-night-3 p-3 text-sm text-night-body">
            {t.touchNote}
          </p>
        )}

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="btn btn-night-primary disabled:pointer-events-none disabled:opacity-50"
            onClick={onStart}
            disabled={touchOnly}
            autoFocus
          >
            {paused ? t.resume : t.start}
          </button>
          {paused && (
            <button
              type="button"
              className="btn btn-night-secondary"
              onClick={onReset}
            >
              {vehicle === "drone"
                ? t.reset
                : vehicle === "strike"
                  ? s.restart
                  : a.reset}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
