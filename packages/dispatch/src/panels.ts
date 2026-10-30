import type { DispatchView, RoomEntry, RunRow, WaitRow } from "@tui-dash/schema";
import {
  type Block,
  ellipsize,
  type Line,
  padEnd,
  panel,
  sentence,
  sourceNotes,
  span,
  widthOf,
  withinRoom,
} from "@tui-dash/ui";

const counted = (count: number, what: string): ReadonlyArray<string> => (count > 0 ? [count + " " + what] : []);

const headParts = (view: DispatchView): ReadonlyArray<string> => {
  const machines = view.machines.kind === "ok" ? view.machines.value.length : 0;
  return [
    ...counted(machines, machines === 1 ? "machine" : "machines"),
    ...counted(view.runs.length, view.runs.length === 1 ? "run" : "runs"),
    ...counted(view.waiting.length, "waiting"),
  ];
};

const machineLine = (entry: RoomEntry, width: number): Line => {
  const busy = entry.busy + " of " + entry.slots + " busy";
  const overfull = entry.busy > entry.slots;
  return [
    span(padEnd(ellipsize(entry.machine, Math.max(0, width - widthOf(busy) - 1)), Math.max(0, width - widthOf(busy) - 1)) + " ", "foreground"),
    span(busy, overfull ? "error" : "muted"),
  ];
};

const runLine = (run: RunRow, width: number): Line => {
  const mark = run.started ? span("\u25b6 ", "primary") : span("\u00b7 ", "warning");
  const where = run.id + " " + run.project + " on " + run.machine + " as " + run.account;
  const room = Math.max(0, width - 2 - widthOf(where) - 1);
  return [mark, span(ellipsize(where, width - 2) + " ", "foreground"), span(ellipsize(run.title, room), "muted")];
};

const waitLine = (wait: WaitRow, width: number): Line => {
  const head = wait.id + " " + wait.title + " \u00b7 " + wait.reason;
  return [span("\u00b7 ", "warning"), span(ellipsize(head, width - 2), "foreground")];
};

const closedParts = (view: DispatchView): ReadonlyArray<string> => [
  ...counted(view.closedDone, "done"),
  ...counted(view.closedFailed, "failed"),
];

export const dispatchLines = (view: DispatchView, width: number, rows: number): Block => {
  if (view.missing) return panel("dispatch", sentence("no backlog at " + view.root, "muted", width), width);
  const counts = headParts(view);
  const countHead: Block = counts.length === 0 ? [] : [[span(counts.join(" \u00b7 "), "foreground")]];
  const machineNotes: Block = view.machines.kind === "ok" ? [] : sourceNotes("dispatch", view.machines, width);
  const unreadNotes: Block = view.unread.map((missed): Line => [span("! " + ellipsize(missed, width - 2), "warning")]);
  const head: Block = [...countHead, ...machineNotes, ...unreadNotes];
  const machines = view.machines.kind === "ok" ? view.machines.value.map((entry) => machineLine(entry, width)) : [];
  const runs = view.runs.map((run) => runLine(run, width));
  const waits = view.waiting.map((wait) => waitLine(wait, width));
  const closed = closedParts(view);
  const tail: Block = closed.length === 0 ? [] : [[span("closed: " + closed.join(" \u00b7 "), "muted")]];
  return panel("dispatch", withinRoom(head, [...machines, ...runs, ...waits, ...tail], rows, "rows"), width);
};
