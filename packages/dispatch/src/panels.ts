import type { DispatchView, RoomEntry, RunRow, WaitRow } from "@tui-dash/schema";
import { type Block, ellipsize, type Line, padEnd, sentence, span, widthOf, withinRoom } from "@tui-dash/ui";

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

export const dispatchLines = (view: DispatchView, width: number, rows: number): Block => {
  if (view.missing) return sentence("no backlog at " + view.root, "muted", width);
  const counts = headParts(view);
  const countHead: Block = counts.length === 0 ? [] : [[span(counts.join(" \u00b7 "), "foreground")]];
  const unreadNotes: Block = view.unread.map((missed): Line => [span("! " + ellipsize(missed, width - 2), "warning")]);
  const head: Block = [...countHead, ...unreadNotes];
  const machines = view.machines.kind === "ok" ? view.machines.value.map((entry) => machineLine(entry, width)) : [];
  const runs = view.runs.map((run) => runLine(run, width));
  const waits = view.waiting.map((wait) => waitLine(wait, width));
  return withinRoom(head, [...machines, ...runs, ...waits], rows, "rows");
};
