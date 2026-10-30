import type { ProjectRow } from "@tui-dash/schema";

export type ProjectFigures = Pick<ProjectRow, "name" | "working" | "waiting" | "parked" | "blocked" | "done" | "ready" | "held">;

export interface ProjectTotal extends ProjectFigures {
  readonly total: true;
}

export const quietOf = (row: ProjectFigures): boolean => row.working + row.waiting + row.parked + row.blocked === 0;

export const totalOf = (rows: ReadonlyArray<ProjectRow>): ProjectTotal => {
  const count = (pick: (row: ProjectRow) => number): number => rows.reduce((total, row) => total + pick(row), 0);
  return {
    total: true,
    name: "total",
    working: count((row) => row.working),
    waiting: count((row) => row.waiting),
    parked: count((row) => row.parked),
    blocked: count((row) => row.blocked),
    done: count((row) => row.done),
    ready: count((row) => row.ready),
    held: count((row) => row.held),
  };
};
