import { DateTime } from "effect";
import type { NextRow, NextSource, NextUp } from "@tui-dash/schema";
import { type Block, countdown, ellipsize, failureLines, type Line, machineWidthOf, padEnd, sentence, span, withinRoom } from "@tui-dash/ui";

const longestCountdown = 6;
const whenWidth = "every ".length + longestCountdown + 1;

const whenText = (row: NextRow, now: DateTime.Utc): string => {
  if (row.at !== undefined) return `in ${countdown((DateTime.toEpochMillis(row.at) - DateTime.toEpochMillis(now)) / 1000)}`;
  return row.everySeconds === undefined ? "\u2013" : `every ${countdown(row.everySeconds)}`;
};

const nextRowLine = (row: NextRow, now: DateTime.Utc, width: number, machineWidth: number): Line => [
  span(padEnd(whenText(row, now), whenWidth), "foreground"),
  ...(machineWidth === 0 ? [] : [span(`${padEnd(row.machine ?? "", machineWidth)} `, row.machine === undefined ? "muted" : "foreground")]),
  span(ellipsize(row.what, width - whenWidth - (machineWidth === 0 ? 0 : machineWidth + 1)), "foreground"),
];

const plainWords: Readonly<Record<NextSource["kind"], string>> = {
  timer: "timers",
  agent: "launch agents",
  CI: "scheduled workflows",
  pueue: "delayed jobs",
  task: "dated items",
};

const sourceLines = (source: NextSource, width: number): Block => {
  const label = (words: string): string => (source.machine === undefined ? words : `${words} ${source.machine}`);
  const unread = source.unread.map((failure) => failure.repo.slice(failure.repo.lastIndexOf("/") + 1));
  const unreadLines = unread.length === 0 ? [] : sentence(`! schedules of ${unread.join(", ")} not read`, "warning", width);
  switch (source.state.kind) {
    case "listed":
    case "empty":
      return unreadLines;
    case "pending":
      return [[span(padEnd("\u2026", whenWidth), "muted"), span(ellipsize(`reading the ${label(plainWords[source.kind])}\u2026`, width - whenWidth), "muted")]];
    case "unreachable":
    case "invalid": {
      const wrapped = failureLines(source.state, width - whenWidth, label(plainWords[source.kind]), 2);
      return wrapped.map((line, index): Line => {
        const text = line.map((part) => part.text).join("").replace(/^\u2717 /u, "");
        return [span(padEnd(index === 0 ? "\u2717" : "", whenWidth), "error"), span(ellipsize(text, width - whenWidth), "error")];
      });
    }
  }
};

const quietLine = (rows: ReadonlyArray<NextRow>, width: number): Line => [
  span(padEnd("\u2013", whenWidth), "muted"),
  span(ellipsize(rows.length === 0 ? "nothing scheduled" : "nothing else scheduled", width - whenWidth), "muted"),
];

// What a source could not say stays in sight, so a long list gives way to it, while the closing quiet line gives way to the list.
export const nextLines = (next: NextUp, now: DateTime.Utc, width: number, room: number): Block => {
  const notes = [...(next.pending ? sentence("reading the schedules\u2026", "muted", width) : []), ...next.sources.flatMap((source) => sourceLines(source, width))];
  const machineWidth = machineWidthOf(next.rows.map((row) => row.machine));
  const rows = next.rows.map((row) => nextRowLine(row, now, width, machineWidth));
  const kept = withinRoom([], rows, Math.max(0, room - notes.length), "schedules");
  const settled = !next.pending && next.sources.every((source) => (source.state.kind === "empty" || source.state.kind === "listed") && source.unread.length === 0);
  const quiet = settled ? [quietLine(next.rows, width)] : [];
  const spare = Math.max(0, room - notes.length - kept.length);
  return [...kept, ...notes, ...(kept.length === rows.length ? quiet.slice(0, spare) : [])].slice(0, Math.max(0, room));
};
