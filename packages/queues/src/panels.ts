import { type DateTime, Option } from "effect";
import type { ActionsView, ActionView, EndedRow, FailureView, GroupView, MachineQueue, Outcome, PueueView, QueuesView, RunningRow } from "@tui-dash/schema";
import {
  type Block,
  countdown,
  ellipsize,
  failureLine,
  failureLines,
  type Line,
  lineWidth,
  padEnd,
  padStart,
  panel,
  panelChrome,
  secondsBetween,
  span,
  type Span,
  type Tone,
  widthOf,
  withinRows,
  wrapParts,
} from "@tui-dash/ui";

const lasted = (seconds: number): string => (seconds < 60 ? `${Math.max(0, Math.floor(seconds))}s` : countdown(seconds));

const failureWords = (failure: FailureView): string => {
  switch (failure.kind) {
    case "exit":
      return `exit ${failure.code}`;
    case "spawn":
      return "spawn failed";
    case "killed":
      return "killed";
    case "errored":
      return "errored";
    case "dependency":
      return "dep failed";
  }
};

const failedCount = (pueue: PueueView): number => pueue.ended.filter((run) => run.result.kind !== "success").length;

const countParts = (pueue: PueueView): ReadonlyArray<string> => [
  `${pueue.running.length} running`,
  `${pueue.queued} queued`,
  `${pueue.paused} paused`,
];

const historyParts = (pueue: PueueView): ReadonlyArray<string> => [`history: ${pueue.ended.length} ended`, `${failedCount(pueue)} failed`];

const projectHead = "project";
const startedHead = "started";
const tookHead = "took";
const commandHead = "command";
const markWidth = 2;
const gap = 2;

// Narrower than this, a command says too little to tell runs apart, so it moves to a line of its own under its run.
const commandLeast = 12;

interface Columns {
  readonly project: number;
  readonly started: number;
  readonly took: number;
  readonly rest: number;
  readonly wrapped: boolean;
}

type Run = RunningRow | EndedRow;

const tookOf = (run: Run, now: DateTime.Utc): number => secondsBetween(run.startedAt, "endedAt" in run ? run.endedAt : now);

const startedText = (run: Run, now: DateTime.Utc): string => `${lasted(secondsBetween(run.startedAt, now))} ago`;

const outcomeWidth = (run: Run): number => ("result" in run && run.result.kind !== "success" ? widthOf(failureWords(run.result)) : 0);

const timesWidth = (started: number, took: number): number => 1 + 1 + started + gap + took;

const besideColumns = (runs: ReadonlyArray<Run>, width: number, started: number, took: number): Columns => {
  const fixed = markWidth + timesWidth(started, took) + gap;
  const widest = Math.max(widthOf(projectHead), ...runs.map((run) => widthOf(run.project)));
  const words = Math.max(0, ...runs.map(outcomeWidth));
  // The project gives way so a failure's words stay whole beside it.
  const share = Math.min(Math.floor((width - fixed) / 2), width - fixed - words);
  const project = Math.min(widest, Math.max(widthOf(projectHead), share));
  return { project, started, took, rest: Math.max(0, width - fixed - project), wrapped: false };
};

const wrappedColumns = (runs: ReadonlyArray<Run>, width: number, started: number, took: number): Columns => {
  const widest = Math.max(widthOf(projectHead), ...runs.map((run) => widthOf(run.project)));
  const project = Math.max(0, Math.min(widest, width - markWidth - timesWidth(started, took)));
  return { project, started, took, rest: width - markWidth, wrapped: true };
};

const columnsOf = (runs: ReadonlyArray<Run>, width: number, now: DateTime.Utc): Columns => {
  const started = Math.max(widthOf(startedHead), ...runs.map((run) => widthOf(startedText(run, now))));
  const took = Math.max(widthOf(tookHead), ...runs.map((run) => widthOf(lasted(tookOf(run, now)))));
  const beside = besideColumns(runs, width, started, took);
  const words = Math.max(0, ...runs.map(outcomeWidth));
  return beside.rest - (words === 0 ? 0 : words + 1) >= commandLeast ? beside : wrappedColumns(runs, width, started, took);
};

const startedCell = (text: string, columns: Columns): string => ` ${padEnd(text, columns.started)}${" ".repeat(gap)}`;

const commandHeadCell = (columns: Columns): string => (columns.wrapped ? "" : `${" ".repeat(gap)}${ellipsize(commandHead, columns.rest)}`);

const headLine = (columns: Columns): Line => [
  span(
    `${" ".repeat(markWidth)}${padEnd(ellipsize(projectHead, columns.project), columns.project)} ${startedCell(startedHead, columns)}${padStart(tookHead, columns.took)}${commandHeadCell(columns)}`,
    "subtle",
  ),
];

const runRows = (mark: Line, run: Run, columns: Columns, now: DateTime.Utc, tone: Tone, command: Line): Block => {
  const times: Line = [
    ...mark,
    span(` ${padEnd(ellipsize(run.project, columns.project), columns.project)} `, "foreground"),
    span(startedCell(startedText(run, now), columns), "subtle"),
    span(padStart(lasted(tookOf(run, now)), columns.took), tone),
  ];
  return columns.wrapped
    ? [times, [span(" ".repeat(markWidth), "subtle"), ...command]]
    : [[...times, span(" ".repeat(gap), "subtle"), ...command]];
};

const runningRows = (run: RunningRow, columns: Columns, now: DateTime.Utc): Block =>
  runRows([span("▶", "primary")], run, columns, now, "foreground", [span(ellipsize(run.command, columns.rest), "foreground")]);

const outcomeCells = (run: EndedRow, room: number): Line => {
  if (run.result.kind === "success") return [span(ellipsize(run.command, room), "muted")];
  const words = ellipsize(failureWords(run.result), room);
  const command = ellipsize(run.command, room - widthOf(words) - 1);
  const reason = run.result.kind === "spawn" ? ellipsize(`: ${run.result.error}`, room - widthOf(words) - widthOf(command) - 1) : "";
  return [
    span(words, "error"),
    ...(reason === "" ? [] : [span(reason, "error")]),
    ...(command === "" ? [] : [span(` ${command}`, "muted")]),
  ];
};

const endedRows = (run: EndedRow, columns: Columns, now: DateTime.Utc): Block => {
  const mark = run.result.kind === "success" ? span("✓", "success") : span("✗", "error");
  return runRows([mark], run, columns, now, "subtle", outcomeCells(run, columns.rest));
};

const more = (hidden: number): Line => [span(`+${hidden} more`, "muted")];

const listInto = (items: ReadonlyArray<Block>, room: number): Block => {
  const every = items.flat();
  if (every.length <= room) return every;
  if (room < 1) return [];
  let rows = 0;
  let shown = 0;
  while (shown < items.length && rows + (items[shown]?.length ?? 0) <= room - 1) {
    rows += items[shown]?.length ?? 0;
    shown += 1;
  }
  return [...items.slice(0, shown).flat(), more(items.length - shown)];
};

// A head line over no rows says nothing, so a list too short for a run under its head only counts its runs.
const runLines = (pueue: PueueView, room: number, width: number, now: DateTime.Utc): Block => {
  const runs: ReadonlyArray<Run> = [...pueue.running, ...pueue.ended];
  if (runs.length === 0 || room < 1) return [];
  const columns = columnsOf(runs, width, now);
  const items = [
    ...pueue.running.map((run) => runningRows(run, columns, now)),
    ...pueue.ended.map((run) => endedRows(run, columns, now)),
  ];
  const each = columns.wrapped ? 2 : 1;
  if (runs.length * each + 1 > room && room < each + 2) return [more(runs.length)];
  return [headLine(columns), ...listInto(items, room - 1)];
};

const separator = span(" · ", "muted");

const joinedLines = (parts: ReadonlyArray<Span>, width: number): Block =>
  parts.reduce<ReadonlyArray<Line>>((lines, part) => {
    const last = lines.at(-1);
    if (last !== undefined && lineWidth([...last, separator, part]) <= width) return [...lines.slice(0, -1), [...last, separator, part]];
    return [...lines, [part]];
  }, []);

const wrapped = (parts: ReadonlyArray<string>, width: number, tone: Tone): Block => joinedLines(parts.map((text) => span(text, tone)), width);

const readingLine: Line = [span("reading…", "muted")];

const stateWords: Readonly<Record<GroupView["status"], string>> = { Running: "running", Paused: "paused", Reset: "resetting" };

const groupParts = (group: GroupView): ReadonlyArray<string> => [group.name, `${stateWords[group.status]},`, `limit ${group.parallel}`];

const groupTone = (group: GroupView): Tone => (group.status === "Running" ? "subtle" : "warning");

// A group too wide for the room wraps onto lines of its own, so only its name is ever cut and no part of it joins another group.
const groupLines = (groups: ReadonlyArray<GroupView>, room: number): Block =>
  groups.every((group) => widthOf(groupParts(group).join(" ")) <= room)
    ? joinedLines(groups.map((group) => span(groupParts(group).join(" "), groupTone(group))), room)
    : groups.flatMap((group) => wrapParts(groupParts(group), room, " ").map((text): Line => [span(ellipsize(text, room), groupTone(group))]));

const machineGroupLines = (machine: MachineQueue, label: number, width: number): Block => {
  const room = width - label;
  const body: Block = Option.match(machine.pueue, {
    onNone: () => [readingLine],
    onSome: (pueue) => (pueue.kind === "ok" ? groupLines(pueue.value.groups, room) : [failureLine(pueue, room)]),
  });
  return body.map((line, index): Line => [span(padEnd(index === 0 ? machine.name : "", label), "foreground"), ...line]);
};

const groupsLines = (machines: ReadonlyArray<MachineQueue>, width: number): Block => {
  const label = Math.max(0, ...machines.map((machine) => widthOf(machine.name))) + 1;
  return machines.flatMap((machine) => machineGroupLines(machine, label, width));
};

const pueueLines = (pueue: Option.Option<Outcome<PueueView>>, room: number, width: number, now: DateTime.Utc): Block =>
  Option.match(pueue, {
    onNone: () => [readingLine],
    onSome: (read) =>
      read.kind === "ok"
        ? [
            ...wrapped(countParts(read.value), width, "foreground"),
            ...wrapped(historyParts(read.value), width, "muted"),
            ...runLines(read.value, room, width, now),
          ]
        : failureLines(read, width),
  });

const actionLine = (action: ActionView, width: number): Line => [
  span(ellipsize(`${action.running ? "▶" : "▷"} ${action.workflow} · ${action.title}`, width), action.running ? "foreground" : "subtle"),
];

const actionsLines = (actions: ActionsView, room: number, width: number): Block => {
  if (Option.isNone(actions.runs)) return [readingLine];
  const read = actions.runs.value;
  if (read.kind !== "ok") return failureLines(read, width);
  if (read.value.length === 0) return [[span("none queued", "muted")]];
  const running = read.value.filter((action) => action.running).length;
  return [
    ...wrapped([`${running} running`, `${read.value.length - running} waiting`], width, "foreground"),
    ...listInto(read.value.map((action) => [actionLine(action, width)]), room),
  ];
};

export const repoName = (repo: string): string => repo.slice(repo.lastIndexOf("/") + 1);

const readValue = <A>(read: Option.Option<Outcome<A>>): Option.Option<A> =>
  Option.flatMap(read, (outcome) => (outcome.kind === "ok" ? Option.some(outcome.value) : Option.none()));

const listNeeds = (view: QueuesView, width: number, now: DateTime.Utc): ReadonlyArray<number> => [
  ...view.machines.map((machine) =>
    Option.match(readValue(machine.pueue), {
      onNone: () => 0,
      onSome: (pueue) => runLines(pueue, Number.POSITIVE_INFINITY, width - panelChrome, now).length,
    }),
  ),
  Option.match(readValue(view.actions.runs), { onNone: () => 0, onSome: (runs) => runs.length }),
];

// Spare rows go round the lists one at a time, so a long history cannot take the rows another machine's runs need.
const sharedRooms = (needs: ReadonlyArray<number>, spare: number): ReadonlyArray<number> => {
  const rooms = needs.map(() => 0);
  let left = spare;
  while (left > 0 && rooms.some((room, index) => room < (needs[index] ?? 0))) {
    for (const [index, need] of needs.entries()) {
      const room = rooms[index] ?? 0;
      if (left > 0 && room < need) {
        rooms[index] = room + 1;
        left -= 1;
      }
    }
  }
  return rooms;
};

const panelsAt = (view: QueuesView, rooms: ReadonlyArray<number>, width: number, now: DateTime.Utc): Block => {
  const inner = width - panelChrome;
  return [
    ...view.machines.flatMap((machine, index) =>
      panel(`pueue ${machine.name}`, pueueLines(machine.pueue, rooms[index] ?? 0, inner, now), width),
    ),
    ...panel("pueue groups", groupsLines(view.machines, inner), width),
    ...panel(`actions · ${repoName(view.actions.repo)}`, actionsLines(view.actions, rooms.at(-1) ?? 0, inner), width),
  ];
};

export const queueLines = (view: QueuesView, width: number, rows: number, now: DateTime.Utc): Block => {
  const needs = listNeeds(view, width, now);
  if (!Number.isFinite(rows)) return panelsAt(view, needs, width, now);
  const fixed = panelsAt(view, needs.map(() => 0), width, now).length;
  return withinRows(panelsAt(view, sharedRooms(needs, rows - fixed), width, now), rows);
};
