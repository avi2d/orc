import { DateTime, Option } from "effect";
import type { CiReport, MachineQueueView, Outcome, QueueRow, QueueRowState, Reading } from "@tui-dash/schema";
import {
  type Block,
  clock,
  countdown,
  ellipsize,
  type Line,
  machineWidthOf,
  padEnd,
  padStart,
  sentence,
  sourceNotes,
  span,
  type Span,
  widthOf,
  withinRoom,
  wrapParts,
} from "@tui-dash/ui";
import { counted } from "./sections";

export type CiState = { readonly kind: "unset" } | { readonly kind: "pending" } | Reading<CiReport>;

const marks: Readonly<Record<QueueRowState, Span>> = {
  running: span("\u25b6 ", "primary"),
  waiting: span("\u00b7 ", "warning"),
  success: span("\u2713 ", "success"),
  failure: span("\u2717 ", "error"),
  cancelled: span("\u2013 ", "muted"),
  skipped: span("\u2013 ", "muted"),
};

const minuteSeconds = 60;

const took = (seconds: number | undefined): string => {
  if (seconds === undefined) return "\u2013";
  return seconds < minuteSeconds ? `${Math.floor(seconds)}s` : countdown(seconds);
};

const endedText = (row: QueueRow, now: DateTime.Utc, zone: DateTime.TimeZone): string => {
  if (row.state === "running") return "now";
  if (row.state === "waiting") return "waiting";
  return row.endedAt === undefined ? "\u2013" : clock(row.endedAt, now, zone);
};

const kindWidth = 6;

const tookWidth = 7;

// A run that ended on another day reads as a week day and a time, nine columns, and keeps a space before it.
const endedWidth = 10;

// One board across machines names each task's machine, so the queue names each pueue run's machine once both machines hold rows.
const queueRowLine = (row: QueueRow, now: DateTime.Utc, zone: DateTime.TimeZone, width: number, machineWidth: number): Line => {
  const room = width - 2 - kindWidth - tookWidth - endedWidth - (machineWidth === 0 ? 0 : machineWidth + 1);
  // A pipeline's run id names its folder, so the place gets half the row at most and leaves the command in sight.
  const where = ellipsize(row.where, Math.floor(room / 2));
  const what = Math.max(0, room - widthOf(where) - 1);
  const quiet = row.state === "cancelled" || row.state === "skipped";
  return [
    marks[row.state],
    span(padEnd(row.kind, kindWidth), "muted"),
    ...(machineWidth === 0 ? [] : [span(`${padEnd(row.machine ?? "", machineWidth)} `, row.machine === undefined || quiet ? "muted" : "foreground")]),
    span(`${where} `, quiet ? "muted" : "foreground"),
    span(padEnd(ellipsize(row.what, what), what), "muted"),
    span(padStart(took(row.tookSeconds), tookWidth), "foreground"),
    span(padStart(endedText(row, now, zone), endedWidth), row.state === "waiting" ? "warning" : "muted"),
  ];
};

const ciNotes = (ci: CiState, width: number): Block => {
  switch (ci.kind) {
    case "unset":
      return sentence("TUI_DASH_RUNNERS is unset, so no CI run shows", "muted", width);
    case "pending":
      return sentence("reading the CI runs\u2026", "muted", width);
    case "unreachable":
    case "invalid":
      return sourceNotes("CI", ci, width);
    case "ok": {
      const unread = ci.value.failures.map((failure) => failure.repo.slice(failure.repo.lastIndexOf("/") + 1));
      return unread.length === 0 ? [] : sentence(`! CI runs of ${unread.join(", ")} not read`, "warning", width);
    }
  }
};

const pueueNotes = (pueues: ReadonlyArray<{ readonly name: string; readonly pueue: Option.Option<Outcome<unknown>> }>, width: number): Block => {
  const reading = pueues.some(({ pueue }) => Option.isNone(pueue)) ? sentence("reading pueue\u2026", "muted", width) : [];
  const failures = pueues.flatMap(({ name, pueue }) => {
    if (Option.isNone(pueue) || pueue.value.kind === "ok") return [];
    return sourceNotes(pueues.length > 1 ? `pueue ${name}` : "pueue", pueue.value, width);
  });
  return [...reading, ...failures];
};

export interface QueueBoxReadings {
  readonly queue: MachineQueueView;
  readonly pueues: ReadonlyArray<{ readonly name: string; readonly pueue: Option.Option<Outcome<unknown>> }>;
  // Undefined on a machine with no runners of its own.
  readonly ci: CiState | undefined;
}

const stillReading = (readings: QueueBoxReadings): boolean =>
  readings.pueues.some(({ pueue }) => Option.isNone(pueue)) || readings.ci?.kind === "pending";

// The title names the box, so the counts open it instead of titling it.
export const queueBoxLines = (readings: QueueBoxReadings, now: DateTime.Utc, zone: DateTime.TimeZone, width: number, room: number): Block => {
  const { queue } = readings;
  const counts = [...counted(queue.running, "running"), ...counted(queue.waiting, "waiting"), ...counted(queue.queuedInPueue, "queued in pueue")];
  const head = counts.length === 0 ? [] : wrapParts(counts, width).map((text): Line => [span(ellipsize(text, width), "foreground")]);
  const notes = [...head, ...pueueNotes(readings.pueues, width), ...(readings.ci === undefined ? [] : ciNotes(readings.ci, width))];
  const machineWidth = machineWidthOf(queue.rows.map((row) => row.machine));
  const rows = queue.rows.map((row) => queueRowLine(row, now, zone, width, machineWidth));
  return rows.length > 0 || stillReading(readings)
    ? withinRoom(notes, rows, room, "runs")
    : withinRoom(notes, sentence("nothing ran in the last day", "muted", width), room, "rows");
};
