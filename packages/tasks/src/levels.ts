import { DateTime } from "effect";
import {
  isLive,
  runsWork,
  type LimitEpisode,
  markGlyphOf,
  projectNameOf,
  modelBadgeOf,
  plannedStateOf,
  type ProjectRow,
  readableTestNameOf,
  type ShownState,
  type SourceFailure,
  type TaskLevels,
  type TaskRow,
  type TestRun,
  totalSecondsOf,
} from "@tui-dash/schema";
import { dash, type ListedState, stateTones } from "./cells";
import { listedDisplayIdOf, type ListedRow, listedRows } from "./listed";
import { planSpans, planText, planWidth } from "./plan-column";
import { type ProjectFigures, type ProjectTotal, quietOf, totalOf } from "./project-total";
import { lasted, markToneOf } from "./pipeline";
import { type Block, clock, countdown, ellipsize, gib, type Line, lineWidth, padEnd, padStart, span, type Span, type Tone, truncate, widthOf, wrapParts } from "@tui-dash/ui";

const minuteSeconds = 60;

const cpuMinutes = (seconds: number | undefined): string => {
  if (seconds === undefined) return dash;
  if (seconds > 0 && seconds < minuteSeconds) return "<1m";
  return `${Math.round(seconds / minuteSeconds)}m`;
};

const memory = (bytes: number | undefined): string => (bytes === undefined ? dash : gib(bytes));

const took = (seconds: number | undefined): string => {
  if (seconds === undefined) return dash;
  return seconds < minuteSeconds ? `${Math.max(0, Math.floor(seconds))}s` : countdown(seconds);
};

export { stateTones };

interface Cell {
  readonly text: string;
  readonly tone: Tone;
}

interface Column<T> {
  readonly head: string;
  readonly width: number;
  readonly cell: (row: T) => Cell;
  // A column with spans draws its own glyphs, so the row keeps each glyph's tone.
  readonly spans?: (row: T) => Line;
  readonly align?: "start";
}

const aligned = <T>(column: Column<T>, text: string): string =>
  column.align === "start" ? padEnd(text, column.width) : padStart(text, column.width);

interface Table<T> {
  readonly name: Column<T>;
  // Listed from the column dropped last to the one dropped first on a narrow screen.
  readonly columns: ReadonlyArray<Column<T>>;
  // The first pinned columns never drop, so a long name clips instead.
  readonly pinned?: number;
}

const markWidth = 2;

const nameLeast = 10;

const fitted = <T>(table: Table<T>, width: number, marks: number, names: ReadonlyArray<number>): { readonly columns: ReadonlyArray<Column<T>>; readonly name: number } => {
  let columns = table.columns;
  const room = () => width - marks - columns.reduce((total, column) => total + 1 + column.width, 0);
  // A name wider than the whole list clips however many columns drop, so only the names that fit size the column.
  const pinnedWidth = table.columns.slice(0, table.pinned ?? 0).reduce((total, column) => total + 1 + column.width, 0);
  const wanted = Math.max(nameLeast, ...names.filter((name) => name <= width - marks - pinnedWidth));
  while (columns.length > (table.pinned ?? 0) && room() < wanted) columns = columns.slice(0, -1);
  return { columns, name: Math.max(0, room()) };
};

const headOf = <T>(table: Table<T>, width: number, marks: number, names: ReadonlyArray<number>): Line => {
  const { columns, name } = fitted(table, width, marks, names);
  const text = " ".repeat(marks) + padEnd(ellipsize(table.name.head, name), name) + columns.map((column) => ` ${aligned(column, column.head)}`).join("");
  return [span(text, "subtle")];
};

const rowOf = <T>(table: Table<T>, width: number, marks: number, mark: Line, row: T, muted: boolean, names: ReadonlyArray<number>): Line => {
  const { columns, name } = fitted(table, width, marks, names);
  const tone = (cell: Cell): Tone => (muted ? "muted" : cell.tone);
  const named = table.name.cell(row);
  return [
    ...mark,
    span(" ".repeat(marks - lineWidth(mark)), "foreground"),
    span(padEnd(ellipsize(named.text, name), name), tone(named)),
    ...columns.flatMap((column) => {
      if (column.spans !== undefined) {
        const drawn = column.spans(row).map((part) => (muted ? span(part.text, "muted") : part));
        const pad = Math.max(0, column.width - lineWidth(drawn));
        const gap = muted ? "muted" : "foreground";
        const fill = pad === 0 ? [] : [span(" ".repeat(pad), gap)];
        return column.align === "start" ? [span(" ", gap), ...drawn, ...fill] : [span(" ", gap), ...fill, ...drawn];
      }
      const cell = column.cell(row);
      return [span(` ${aligned(column, ellipsize(cell.text, column.width))}`, tone(cell))];
    }),
  ];
};

const plainCell = (text: string): Cell => ({ text, tone: "foreground" });

const stateCell = (state: ListedState): Cell => ({ text: state, tone: stateTones[state] });

const unrunCell: Cell = { text: "", tone: "muted" };

const nowFlag = span("\u2691 ", "error", { bold: true });

const pastFlag = span("\u2691 ", "warning");

const flagMark = (episodes: ReadonlyArray<LimitEpisode>): Span | undefined => {
  if (episodes.length === 0) return undefined;
  return episodes.some((episode) => episode.ongoing) ? nowFlag : span("\u2691 ", "warning");
};

const taskMark = (task: TaskRow): Span | undefined => {
  if (task.spend?.fair?.flagged === true) return isLive(task.state) ? nowFlag : pastFlag;
  return flagMark(task.episodes);
};

const ranCell =
  (cell: (task: TaskRow) => Cell) =>
  (row: ListedRow): Cell =>
    row.kind === "task" ? cell(row.task) : unrunCell;

const listedStateOf = (row: ListedRow): ListedState => (row.kind === "task" ? row.task.state : plannedStateOf(row.planned));

const countCell = (state: ShownState, count: number): Cell =>
  count === 0 ? plainCell(dash) : { text: String(count), tone: stateTones[state] };

const idleOf = (row: ProjectRow): boolean => quietOf(row) && row.planned.length === 0;

// The state headers read short so the box keeps every column at sixty wide, while each count keeps its state's colour.
const projectTable = (planCells: number): Table<ProjectFigures | ProjectTotal> => ({
  name: { head: "project", width: 0, cell: (row) => ({ text: projectNameOf(row.name), tone: "total" in row ? "subtle" : "foreground" }) },
  columns: [
    { head: "work", width: 4, cell: (row) => countCell("working", row.working) },
    { head: "wait", width: 4, cell: (row) => countCell("waiting", row.waiting) },
    { head: "park", width: 4, cell: (row) => countCell("parked", row.parked) },
    { head: "block", width: 5, cell: (row) => countCell("blocked", row.blocked) },
    { head: "done", width: 4, cell: (row) => countCell("done", row.done) },
    { head: "plan", width: planCells, cell: (row) => plainCell(planText(row)), spans: planSpans },
  ],
});

const pipeText = (task: TaskRow): string => task.pipeline?.stages.map((stage) => markGlyphOf(stage.mark)).join("") ?? "";

const modelWidthLimit = 14;

const modelColumn = (tasks: ReadonlyArray<TaskRow>): Column<ListedRow> => ({
  head: "model",
  width: Math.min(modelWidthLimit, Math.max(widthOf("model"), ...tasks.map((task) => widthOf(modelBadgeOf(task.spend?.model) ?? dash)))),
  align: "start",
  cell: ranCell((task) => plainCell(modelBadgeOf(task.spend?.model) ?? dash)),
});

const pipeColumn = (tasks: ReadonlyArray<TaskRow>): Column<ListedRow> => ({
  head: "pipe",
  width: Math.max(widthOf("pipe"), ...tasks.map((task) => task.pipeline?.stages.length ?? 0)),
  align: "start",
  cell: (row) => plainCell(row.kind === "task" ? pipeText(row.task) : ""),
  spans: (row) => (row.kind === "task" ? (row.task.pipeline?.stages.map((stage) => span(markGlyphOf(stage.mark), markToneOf(stage.mark))) ?? []) : []),
});

const machineColumn = (machines: ReadonlyArray<string>): Column<ListedRow> | undefined => {
  if (machines.length < 2) return undefined;
  return {
    head: "machine",
    width: Math.max(widthOf("machine"), ...machines.map((name) => widthOf(name))),
    align: "start",
    cell: (row) => plainCell(row.kind === "task" ? row.task.machine : row.planned.machine),
  };
};

const taskColumns = (rows: ReadonlyArray<ListedRow>, machines: ReadonlyArray<string>): ReadonlyArray<Column<ListedRow>> => {
  const tasks = rows.flatMap((row) => (row.kind === "task" ? [row.task] : []));
  const machine = machineColumn(machines);
  return [
    { head: "state", width: 7, cell: (row) => stateCell(listedStateOf(row)), align: "start" },
    ...(machine === undefined ? [] : [machine]),
    { head: "time", width: 6, cell: ranCell((task) => plainCell(lasted(task.seconds))) },
    modelColumn(tasks),
    ...(tasks.some((task) => task.pipeline !== undefined) ? [pipeColumn(tasks)] : []),
    { head: "tests", width: 6, cell: ranCell((task) => plainCell(took(task.testSeconds))) },
  ];
};

const taskTable = (rows: ReadonlyArray<ListedRow>, machines: ReadonlyArray<string>): Table<ListedRow> => {
  const columns = taskColumns(rows, machines);
  return {
    name: { head: "task", width: 0, cell: (row) => plainCell(row.kind === "task" ? row.task.id : row.planned.id) },
    columns,
    pinned: columns.findIndex((column) => column.head === "machine") + 1,
  };
};

// The table lists its columns by how long each survives a narrow screen, while the screen shows them in the board's order.
const inBoardOrder = <T>(columns: ReadonlyArray<Column<T>>, order: ReadonlyArray<string>): ReadonlyArray<Column<T>> =>
  order.flatMap((head) => columns.filter((column) => column.head === head));

interface ListRow<T> {
  readonly row: T;
  readonly line: Line;
}

export interface List<T> {
  readonly head: Line;
  readonly sums: Block;
  readonly rows: ReadonlyArray<ListRow<T>>;
}

const listed = <T, R extends T>(
  table: Table<T>,
  order: ReadonlyArray<string>,
  width: number,
  names: ReadonlyArray<number>,
  rows: ReadonlyArray<R>,
  mark: (row: R) => Line,
  muted: (row: R) => boolean,
  sums: ReadonlyArray<T> = [],
): List<R> => {
  const marked = rows.map(mark);
  const marks = Math.max(markWidth, ...marked.map(lineWidth));
  const kept = fitted(table, width, marks, names);
  const shown: Table<T> = { name: table.name, columns: inBoardOrder(kept.columns, order), pinned: kept.columns.length };
  return {
    head: headOf(shown, width, marks, names),
    sums: sums.map((row) => rowOf(shown, width, marks, [], row, false, names)),
    rows: rows.map((row, index): ListRow<R> => ({ row, line: rowOf(shown, width, marks, marked[index] ?? [], row, muted(row), names) })),
  };
};

const projectOrder = ["work", "wait", "park", "block", "done", "plan"];

const taskOrder = ["state", "machine", "model", "pipe", "tests", "time"];

const blank = span("  ", "foreground");

const showsFigures = (row: ProjectRow): boolean => !idleOf(row) || row.done > 0;

export const projectList = (levels: TaskLevels, width: number): List<ProjectRow> => {
  // A total over a single project with figures would repeat that project's row.
  const sums = levels.projects.filter(showsFigures).length > 1 ? [totalOf(levels.projects)] : [];
  const planCells = Math.max(planWidth, ...[...levels.projects, ...sums].map((row) => widthOf(planText(row))));
  return listed(projectTable(planCells), projectOrder, width, [], levels.projects, (row) => [flagMark(row.episodes) ?? blank], idleOf, sums);
};

const liveMark = span("\u25b6 ", "primary");

const taskMarks = (task: TaskRow): Line => {
  const live = runsWork(task.live) ? liveMark : undefined;
  const flag = taskMark(task);
  if (flag === undefined) return live === undefined ? [] : [live];
  return [live ?? blank, flag];
};

export const taskList = (project: ProjectRow, machines: ReadonlyArray<string>, width: number): List<ListedRow> => {
  const rows = listedRows(project);
  return listed(
    taskTable(rows, machines),
    taskOrder,
    width,
    rows.map((row) => widthOf(listedDisplayIdOf(row))),
    rows,
    (row) => (row.kind === "task" ? taskMarks(row.task) : []),
    (row) =>
      row.kind === "task" && !runsWork(row.task.live) && (!isLive(row.task.state) || row.task.idled),
  );
};

const thousand = 1000;

export const tokensText = (tokens: number): string => {
  if (tokens >= thousand * thousand) return `${(tokens / thousand / thousand).toFixed(1)}M`;
  if (tokens >= thousand) return `${Math.round(tokens / thousand)}k`;
  return String(tokens);
};

export const ratioText = (ratio: number): string => `${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)}\u00d7 fair`;

const rowIndent = "    ";

export const spendLines = (task: TaskRow, width: number, indent = rowIndent): Block => {
  const { spend } = task;
  if (spend === undefined) return [];
  const words = span(ellipsize(`${tokensText(spend.tokens)} tok`, width - indent.length), "muted");
  return indent === "" ? [[words]] : [[span(indent, "muted"), words]];
};

const failureWords = ({ source, failure }: SourceFailure): string =>
  `\u2717 ${source}: ${failure.kind === "unreachable" ? failure.reason : failure.issue}`;

const sentenceLines = (text: string, width: number, tone: Tone): Block =>
  wrapParts(text.split(" "), width, " ").map((part): Line => [span(ellipsize(part, width), tone)]);

export const descriptionLinesOf = (detail: string | undefined, width: number): Block =>
  detail === undefined || detail.trim() === "" ? [] : sentenceLines(detail, width, "muted").slice(0, 2);

export const keptLineOf = (task: TaskRow, width: number): Line =>
  truncate([span(`kept   cpu ${cpuMinutes(task.cpuSeconds)} · peak memory ${memory(task.peakBytes)}`, "foreground")], width);

export const failureLines = (failures: ReadonlyArray<SourceFailure>, width: number): Block =>
  failures.flatMap((failure) => sentenceLines(failureWords(failure), width, "error").slice(0, 3));

export const noticeLines = (text: string, width: number): Block => sentenceLines(text, width, "muted");

const episodeWords = (episode: LimitEpisode, now: DateTime.Utc, zone: DateTime.TimeZone): string => {
  const at = (instant: DateTime.Utc) => clock(instant, now, zone);
  if (episode.limit === "memory") return episode.ongoing ? "holds over a quarter of memory now" : `held over a quarter of memory at ${at(episode.to)}`;
  return episode.ongoing ? `over half the cores since ${at(episode.from)}` : `over half the cores from ${at(episode.from)} to ${at(episode.to)}`;
};

export const episodeLines = (task: TaskRow, now: DateTime.Utc, zone: DateTime.TimeZone, width: number): Block =>
  task.episodes.map((episode): Line => [flagMark([episode]) ?? blank, span(ellipsize(episodeWords(episode, now, zone), width - markWidth), "foreground")]);

const sectionHead = (title: string, right: string, width: number): Line => [span(padEnd(title, width - widthOf(right)) + right, "subtle")];

export interface Section {
  readonly head: Block;
  readonly items: Block;
}

export interface TaskOrigin {
  readonly machine: string;
  readonly source: "local" | "remote";
  readonly listed: boolean;
  readonly usageRead: boolean;
}

const processSection = (task: TaskRow, origin: TaskOrigin, width: number): Section => {
  const live = task.live;
  if (live !== undefined) {
  const figures = (cpu: string, mem: string) => `${padStart(cpu, 6)} ${padStart(mem, 5)}`;
  return {
    head: [sectionHead("processes", figures("cpu", "mem"), width)],
    items: live.processes.map((process): Line => {
      const right = figures(cpuMinutes(totalSecondsOf(process)), memory(process.residentBytes));
      const tone = process.resting ? "muted" : "foreground";
      return [process.resting ? blank : liveMark, span(padEnd(ellipsize(process.program ?? `pid ${process.pid}`, width - markWidth - widthOf(right) - 1), width - markWidth - widthOf(right)), tone), span(right, tone)];
    }),
  };
  }
  if (!isLive(task.state)) return { head: [], items: [] };
  if (origin.usageRead && origin.listed)
    return {
      head: noticeLines(origin.source === "remote" ? `no live process on ${origin.machine} now` : "no live process now", width),
      items: [],
    };
  return {
    head: noticeLines(origin.source === "remote" ? `no live process on ${origin.machine} is read here` : "no live process on this machine", width),
    items: [],
  };
};

const runMark = (run: TestRun): Span => {
  if (!("result" in run)) return liveMark;
  return run.result.kind === "success" ? span("\u2713 ", "success") : span("\u2717 ", "error");
};

const testSection = (task: TaskRow, now: DateTime.Utc, zone: DateTime.TimeZone, width: number): Section => {
  if (task.tests.length === 0) return { head: noticeLines("no pueue run in its folders", width), items: [] };
  const times = (length: string, ended: string) => `${padStart(length, 7)} ${padStart(ended, 9)}`;
  return {
    head: [sectionHead("test runs", times("took", "ended"), width)],
    items: task.tests.map((run): Line => {
      const ended = "endedAt" in run ? run.endedAt : undefined;
      const right = times(took(DateTime.toEpochMillis(ended ?? now) / 1000 - DateTime.toEpochMillis(run.startedAt) / 1000), ended === undefined ? "now" : clock(ended, now, zone));
      const command = width - markWidth - widthOf(right) - 1;
      return [runMark(run), span("pueue ", "muted"), span(padEnd(ellipsize(readableTestNameOf(run.command), command - 6), command - 6) + " ", "foreground"), span(right, "foreground")];
    }),
  };
};

export const taskSections = (task: TaskRow, origin: TaskOrigin, now: DateTime.Utc, zone: DateTime.TimeZone, width: number): ReadonlyArray<Section> => [
  processSection(task, origin, width),
  testSection(task, now, zone, width),
];
