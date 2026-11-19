/** Best score per drone-defence scenario, kept in localStorage. This is a demo: no backend. */
export interface StrikeRecord {
  score: number;
}

const key = (scenarioId: string) => `141-strike-${scenarioId}`;

export function loadStrikeRecord(scenarioId: string): StrikeRecord | null {
  try {
    const raw = window.localStorage.getItem(key(scenarioId));
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<StrikeRecord>;
    return typeof stored.score === "number" ? { score: stored.score } : null;
  } catch {
    return null;
  }
}

export function saveStrikeRecord(scenarioId: string, record: StrikeRecord) {
  try {
    window.localStorage.setItem(key(scenarioId), JSON.stringify(record));
  } catch {
    /* private mode or storage full: the record just doesn't persist */
  }
}
