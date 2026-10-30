import { doneNewestFirst, type PlannedRow, plannedStateOf, type ProjectRow, type ShownState, type TaskRow } from "@tui-dash/schema";

export type ListedRow = { readonly kind: "task"; readonly task: TaskRow } | { readonly kind: "planned"; readonly planned: PlannedRow };

export const listedIdOf = (row: ListedRow): string => (row.kind === "task" ? `${row.task.machine} ${row.task.id}` : `${row.planned.machine} ${row.planned.id}`);

export const listedDisplayIdOf = (row: ListedRow): string => (row.kind === "task" ? row.task.id : row.planned.id);

type Group = Exclude<ShownState, "done" | "unknown"> | "ready" | "held" | "ended";

const liveGroups: ReadonlyArray<Group> = ["working", "waiting", "blocked", "parked"];

const groupOf = (row: ListedRow): Group => {
  if (row.kind === "planned") return plannedStateOf(row.planned) === "planned" ? "ready" : "held";
  return liveGroups.find((group) => group === row.task.state) ?? "ended";
};

const groupOrder: ReadonlyArray<Group> = ["working", "waiting", "blocked", "parked", "ready", "held", "ended"];

// A ready row keeps its dispatch place and a held row its report place, so only live and ended rows sort.
const withinGroup = (left: ListedRow, right: ListedRow): number => {
  if (left.kind === "planned" && right.kind === "planned") return (left.planned.next ?? 0) - (right.planned.next ?? 0);
  if (left.kind === "task" && right.kind === "task") return doneNewestFirst(left.task, right.task);
  return 0;
};

export const listedRows = (project: ProjectRow): ReadonlyArray<ListedRow> => {
  const rows: ReadonlyArray<ListedRow> = [
    ...project.tasks.map((task): ListedRow => ({ kind: "task", task })),
    ...project.planned.map((planned): ListedRow => ({ kind: "planned", planned })),
  ];
  return rows.toSorted((left, right) => groupOrder.indexOf(groupOf(left)) - groupOrder.indexOf(groupOf(right)) || withinGroup(left, right));
};
