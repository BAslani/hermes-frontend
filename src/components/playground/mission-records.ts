/** Best score per helicopter mission, kept in localStorage. This is a demo: no backend. */
export interface MissionRecord {
  score: number;
  time: number;
}

const key = (missionId: string) => `141-mission-${missionId}`;

export function loadMissionRecord(missionId: string): MissionRecord | null {
  try {
    const raw = window.localStorage.getItem(key(missionId));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<MissionRecord>;
    if (typeof stored.score !== "number" || typeof stored.time !== "number")
      return null;
    return { score: stored.score, time: stored.time };
  } catch {
    return null;
  }
}

export function saveMissionRecord(missionId: string, record: MissionRecord) {
  try {
    window.localStorage.setItem(key(missionId), JSON.stringify(record));
  } catch {
    /* private mode or storage full: the record just doesn't persist */
  }
}
