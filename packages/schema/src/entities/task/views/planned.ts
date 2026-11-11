import type { PlannedEntry } from "../contract/tasks";

export type PlannedRow = PlannedEntry & {
  // Counted from 1 among its home's ready entries, since each home dispatches its own queue, and undefined while held.
  readonly next: number | undefined;
  readonly machine: string;
};

export type PlannedState = "planned" | "held";

export const plannedStateOf = (row: PlannedRow): PlannedState => (row.next === undefined ? "held" : "planned");

export const plannedRowsOf = (planned: ReadonlyArray<PlannedEntry>, machine: string): ReadonlyArray<PlannedRow> => {
  const ready = new Map<string, number>();
  return planned.map((entry): PlannedRow => {
    const held = entry.hold !== undefined || entry.after.length > 0;
    const next = held ? undefined : (ready.get(entry.home) ?? 0) + 1;
    if (next !== undefined) ready.set(entry.home, next);
    return { ...entry, next, machine };
  });
};
