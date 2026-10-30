import type { ProjectRow, TaskLevels } from "@tui-dash/schema";
import type { Move } from "@tui-dash/ui";
import { listedIdOf, type ListedRow, listedRows } from "./listed";

const levelOrder = ["projects", "tasks", "task"] as const;

export type Level = (typeof levelOrder)[number];

export interface Navigation {
  readonly focus: Level;
  readonly project: string | undefined;
  readonly task: string | undefined;
  readonly detail: number;
}

export const startNavigation: Navigation = { focus: "projects", project: undefined, task: undefined, detail: 0 };

export const levelIndex = (level: Level): number => levelOrder.indexOf(level);

// A held pick names its row, so a row that goes away hands the pick to the first row rather than to whatever slid into its place.
export const pickedProject = (levels: TaskLevels, navigation: Navigation): ProjectRow | undefined =>
  levels.projects.find((project) => project.name === navigation.project) ?? levels.projects.at(0);

export const pickedTask = (project: ProjectRow | undefined, navigation: Navigation): ListedRow | undefined => {
  if (project === undefined) return undefined;
  const rows = listedRows(project);
  return rows.find((row) => listedIdOf(row) === navigation.task) ?? rows.at(0);
};

// The task level lists its processes and then its test runs, and detail picks one of them, while a planned row has neither.
const detailCount = (row: ListedRow): number => (row.kind === "task" ? (row.task.live?.processes.length ?? 0) + row.task.tests.length : 0);

const stepped = <A>(rows: ReadonlyArray<A>, current: A | undefined, by: number): A | undefined => {
  if (current === undefined) return undefined;
  const index = rows.indexOf(current);
  return rows[Math.min(rows.length - 1, Math.max(0, index + by))];
};

const pickedBy = (levels: TaskLevels, navigation: Navigation, by: number): Navigation => {
  const project = pickedProject(levels, navigation);
  if (navigation.focus === "projects") {
    const next = stepped(levels.projects, project, by);
    return next === undefined || next === project ? navigation : { ...navigation, project: next.name, task: undefined, detail: 0 };
  }
  const task = pickedTask(project, navigation);
  if (navigation.focus === "tasks" && project !== undefined) {
    const rows = listedRows(project);
    const next = stepped(rows, rows.find((row) => task !== undefined && listedIdOf(row) === listedIdOf(task)), by);
    return next === undefined || (task !== undefined && listedIdOf(next) === listedIdOf(task))
      ? navigation
      : { ...navigation, project: project.name, task: listedIdOf(next), detail: 0 };
  }
  if (task === undefined) return navigation;
  const detail = Math.min(detailCount(task) - 1, Math.max(0, navigation.detail + by));
  return detail < 0 || detail === navigation.detail ? navigation : { ...navigation, detail };
};

const steppedIn = (levels: TaskLevels, navigation: Navigation): Navigation => {
  const project = pickedProject(levels, navigation);
  const task = pickedTask(project, navigation);
  if (navigation.focus === "projects" && project !== undefined) return { ...navigation, focus: "tasks", project: project.name, task: undefined, detail: 0 };
  if (navigation.focus === "tasks" && project !== undefined && task !== undefined) return { focus: "task", project: project.name, task: listedIdOf(task), detail: 0 };
  return navigation;
};

const steppedOut = (navigation: Navigation): Navigation => {
  if (navigation.focus === "task") return { ...navigation, focus: "tasks" };
  if (navigation.focus === "tasks") return { ...navigation, focus: "projects" };
  return navigation;
};

export const moved = (levels: TaskLevels, navigation: Navigation, move: Move): Navigation => {
  switch (move) {
    case "up":
      return pickedBy(levels, navigation, -1);
    case "down":
      return pickedBy(levels, navigation, 1);
    case "in":
      return steppedIn(levels, navigation);
    case "out":
      return steppedOut(navigation);
    // The ledger's full screen pages on its own, so the levels board leaves the page keys alone.
    case "pageup":
    case "pagedown":
      return navigation;
  }
};
