import type { Outcome } from "../reading";
import type { DispatchSnapshot, DispatchTask } from "../sources/dispatch";

export interface RoomEntry {
  readonly machine: string;
  readonly slots: number;
  readonly busy: number;
}

export interface RunRow {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly machine: string;
  readonly account: string;
  readonly started: boolean;
}

export interface WaitRow {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly reason: string;
}

export interface DispatchView {
  readonly root: string;
  readonly missing: boolean;
  readonly machines: Outcome<ReadonlyArray<RoomEntry>>;
  readonly runs: ReadonlyArray<RunRow>;
  readonly waiting: ReadonlyArray<WaitRow>;
  readonly closedDone: number;
  readonly closedFailed: number;
  readonly unread: ReadonlyArray<string>;
}

const claimedMachine = (task: DispatchTask): string | undefined => {
  const state = task.state;
  if (state.kind === "taken") return state.claim?.machine;
  if (state.kind === "started" || state.kind === "closed") return state.claim.machine;
  return undefined;
};

const busyOf = (machine: string, tasks: ReadonlyArray<DispatchTask>): number =>
  tasks.filter((task) => (task.state.kind === "taken" || task.state.kind === "started") && claimedMachine(task) === machine).length;

// A task the backlog does not hold blocks forever, so it reads as waiting on the missing id.
const dependencyWait = (task: DispatchTask, tasks: ReadonlyArray<DispatchTask>): string | undefined => {
  for (const id of task.dependsOn) {
    const dependency = tasks.find((candidate) => candidate.id === id);
    if (dependency === undefined) return "waits on " + id + ", which the backlog does not hold";
    if (dependency.state.kind !== "closed" || dependency.state.closing.outcome !== "done") return "waits on " + id;
  }
  return undefined;
};

const waitOf = (task: DispatchTask, snapshot: DispatchSnapshot): WaitRow => {
  const waiting = (reason: string): WaitRow => ({ id: task.id, title: task.title, project: task.project, reason });
  const blocked = dependencyWait(task, snapshot.tasks);
  if (blocked !== undefined) return waiting(blocked);
  if (snapshot.projects.kind !== "ok") return waiting("the project list is unread");
  const project = snapshot.projects.value.find((candidate) => candidate.name === task.project);
  if (project === undefined) return waiting("the project " + task.project + " is not in the project list");
  if (snapshot.machines.kind !== "ok") return waiting("the machine list is unread");
  const machines = snapshot.machines.value;
  if (task.machine !== null && !machines.some((machine) => machine.name === task.machine)) {
    return waiting("the machine " + task.machine + " is not in dispatch.json");
  }
  const placed = machines.filter((machine) => (task.machine === null || machine.name === task.machine) && project.checkouts[machine.name] !== undefined);
  if (placed.length === 0) return waiting("the project " + project.name + " has no checkout on " + (task.machine ?? "any machine"));
  const full = placed.every((machine) => busyOf(machine.name, snapshot.tasks) >= machine.slots);
  if (full) {
    return waiting(task.machine === null ? "no machine with a checkout of " + project.name + " has room" : task.machine + " has no room");
  }
  return waiting("waits for the next beat");
};

export const dispatchView = (snapshot: DispatchSnapshot): DispatchView => {
  const runs: Array<RunRow> = [];
  const waiting: Array<WaitRow> = [];
  let closedDone = 0;
  let closedFailed = 0;
  for (const task of snapshot.tasks) {
    const state = task.state;
    if (state.kind === "taken") {
      runs.push({
        id: task.id,
        title: task.title,
        project: task.project,
        machine: state.claim?.machine ?? "?",
        account: state.claim?.account ?? "?",
        started: false,
      });
    } else if (state.kind === "started") {
      runs.push({ id: task.id, title: task.title, project: task.project, machine: state.claim.machine, account: state.claim.account, started: true });
    } else if (state.kind === "closed") {
      if (state.closing.outcome === "done") closedDone += 1;
      else closedFailed += 1;
    } else {
      waiting.push(waitOf(task, snapshot));
    }
  }
  const machines: DispatchView["machines"] = snapshot.machines.kind === "ok"
    ? {
      kind: "ok",
      value: snapshot.machines.value.map((machine) => ({ machine: machine.name, slots: machine.slots, busy: busyOf(machine.name, snapshot.tasks) })),
    }
    : snapshot.machines;
  return { root: snapshot.root, missing: snapshot.missing, machines, runs, waiting, closedDone, closedFailed, unread: snapshot.unread };
};
