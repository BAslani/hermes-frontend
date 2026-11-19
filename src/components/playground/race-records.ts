import type { GhostFrame } from "@/lib/flight/race";

/** The best run on a course, kept in localStorage. This is a demo: no backend. */
export interface RaceRecord {
  /** Seconds, penalties included. */
  total: number;
  /** Race time at each gate, null where missed. */
  splits: (number | null)[];
  ghost: GhostFrame[];
}

const key = (courseId: string) => `141-race-${courseId}`;

/** The best run on a course; null when there is none, or it was flown on a layout with another number of gates. */
export function loadRecord(
  courseId: string,
  gateCount: number,
): RaceRecord | null {
  try {
    const raw = window.localStorage.getItem(key(courseId));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<RaceRecord>;
    if (typeof stored.total !== "number" || !Number.isFinite(stored.total))
      return null;
    if (!Array.isArray(stored.splits) || stored.splits.length !== gateCount)
      return null;
    return {
      total: stored.total,
      splits: Array.isArray(stored.splits) ? stored.splits : [],
      ghost: Array.isArray(stored.ghost) ? stored.ghost : [],
    };
  } catch {
    return null;
  }
}

export function saveRecord(courseId: string, record: RaceRecord) {
  try {
    window.localStorage.setItem(key(courseId), JSON.stringify(record));
  } catch {
    // Storage full or blocked: keep the time without the ghost, else give up quietly.
    try {
      window.localStorage.setItem(
        key(courseId),
        JSON.stringify({ ...record, ghost: [] }),
      );
    } catch {
      /* private mode: the record just doesn't persist */
    }
  }
}
