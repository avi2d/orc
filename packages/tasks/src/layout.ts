import type { DateTime } from "effect";
import { projectNameOf, type ProjectRow, type TaskLevels } from "@tui-dash/schema";
import {
  behind,
  type Block,
  type Drawn,
  ellipsize,
  fit,
  clock,
  type Frame,
  keyedName,
  type Line,
  lineWidth,
  panel,
  panelChrome,
  rightSpan,
  span,
  type Target,
  titleEdge,
  withinRows,
  titleRoom,
  type Tone,
  truncate,
  widthOf,
} from "@tui-dash/ui";
import { failureLines, noticeLines, projectList, spendLines, taskList, taskSections } from "./levels";
import { listedDisplayIdOf, listedIdOf, type ListedRow } from "./listed";
import { plannedTicketLines, ticketLines } from "./ticket";
import { type Level, levelIndex, type Navigation, pickedProject, pickedTask } from "./navigation";

export interface TasksReadings {
  readonly levels: TaskLevels;
  readonly zone: DateTime.TimeZone;
}

const levelWidth = 60;

const levelsShown = (width: number): number => {
  if (width >= 240) return 4;
  return width >= 120 ? 2 : 1;
};

const leastWidth = 30;

const chromeRows = 2;

export interface PickRow {
  readonly lines: Block;
  readonly open: Navigation | undefined;
  readonly picked: boolean;
}

export interface Content {
  readonly title: string;
  readonly head: Block;
  readonly rows: ReadonlyArray<PickRow>;
}

const focusFrame: Frame = { weight: "heavy", tone: "focus" };

const restFrame: Frame = { weight: "light", tone: "muted" };

const projectsContent = (levels: TaskLevels, navigation: Navigation, width: number): Content => {
  const project = pickedProject(levels, navigation);
  const list = projectList(levels, width);
  const notices = [
    ...failureLines(levels.failures, width),
    ...(levels.unset
      ? noticeLines(
          levels.source === "remote"
            ? "TUI_DASH_REMOTE_TASKS is unset, so only tasks sampled earlier show"
            : "TUI_DASH_TASKS is unset, so only tasks sampled earlier show",
          width,
        )
      : []),
  ];
  const empty = levels.pending ? "reading the tasks\u2026" : levels.registered.length > 0 ? "no registered project has a task" : levels.interval === "today" ? "no task today" : `no task in the last ${levels.days} days`;
  const window = levels.interval === "today" ? "today" : "all";
  // A remote machine names itself in the title, so its projects are never read as this machine's.
  const title = levels.source === "remote" ? `projects \u00b7 ${levels.machine} \u00b7 ${window}` : `projects \u00b7 ${window}`;
  return {
    title,
    head: levels.projects.length === 0 ? [...notices, ...noticeLines(empty, width)] : [...notices, list.head, ...list.sums],
    rows: list.rows.map(({ row, line }) => ({
      lines: [line],
      open: { focus: "tasks", project: row.name, task: undefined, detail: 0 },
      picked: row === project,
    })),
  };
};

const tasksContent = (project: ProjectRow, machines: ReadonlyArray<string>, navigation: Navigation, width: number): Content => {
  const task = pickedTask(project, navigation);
  const list = taskList(project, machines, width);
  return {
    title: `${projectNameOf(project.name)} \u00b7 tasks`,
    head: [list.head],
    rows: list.rows.map(({ row, line }) => ({
      lines: [line, ...(row.kind === "task" ? spendLines(row.task, width) : [])],
      open: { focus: "task", project: project.name, task: listedIdOf(row), detail: 0 },
      picked: task !== undefined && listedIdOf(row) === listedIdOf(task),
    })),
  };
};

const taskContent = (readings: TasksReadings, project: ProjectRow, row: ListedRow, navigation: Navigation, width: number): Content => {
  if (row.kind === "planned") return { title: row.planned.id, head: plannedTicketLines(row.planned, readings.levels.now, width), rows: [] };
  const { task } = row;
  const origin = { machine: task.machine, source: task.source, listed: task.listed, usageRead: task.usageRead };
  const rows: Array<PickRow> = [];
  let detail = 0;
  for (const section of taskSections(task, origin, readings.levels.now, readings.zone, width)) {
    rows.push(...section.head.map((line): PickRow => ({ lines: [line], open: undefined, picked: false })));
    for (const line of section.items) {
      rows.push({ lines: [line], open: { focus: "task", project: project.name, task: listedIdOf(row), detail }, picked: detail === navigation.detail });
      detail += 1;
    }
  }
  return {
    title: task.id,
    head: ticketLines(task, origin, readings.levels.now, readings.zone, width),
    rows,
  };
};

export interface LevelColumn {
  readonly level: Level;
  readonly content: (inner: number) => Content;
}

export const levelColumns = (readings: TasksReadings, navigation: Navigation): ReadonlyArray<LevelColumn> => {
  const { levels } = readings;
  const project = pickedProject(levels, navigation);
  const task = levelIndex(navigation.focus) >= levelIndex("tasks") ? pickedTask(project, navigation) : undefined;
  return [
    { level: "projects", content: (inner) => projectsContent(levels, navigation, inner) },
    ...(project === undefined ? [] : [{ level: "tasks" as const, content: (inner: number) => tasksContent(project, levels.machines, navigation, inner) }]),
    ...(project === undefined || task === undefined
      ? []
      : [{ level: "task" as const, content: (inner: number) => taskContent(readings, project, task, navigation, inner) }]),
  ];
};

const moreLine = (hidden: number): Line => [span(`+${hidden} more ${hidden === 1 ? "row" : "rows"}`, "muted")];

interface Placed {
  readonly lines: Block;
  readonly targets: ReadonlyArray<{ readonly line: number; readonly open: Navigation }>;
}

const placedRows = (head: Block, rows: ReadonlyArray<PickRow>, tinted: (row: PickRow) => Block, more: Block): Placed => {
  const lines: Array<Line> = [...head];
  const targets: Array<Placed["targets"][number]> = [];
  for (const row of rows) {
    for (const line of tinted(row)) {
      if (row.open !== undefined) targets.push({ line: lines.length, open: row.open });
      lines.push(line);
    }
  }
  return { lines: [...lines, ...more], targets };
};

const heightOf = (rows: ReadonlyArray<PickRow>): number => rows.reduce((total, row) => total + row.lines.length, 0);

// The pick stays on screen however long the list, so the rows scroll to keep it and count the rest.
const placed = (content: Content, width: number, height: number, pickTone: Tone | undefined): Placed => {
  const pickedRow = content.rows.find((row) => row.picked) ?? content.rows.at(0);
  const kept = pickedRow === undefined ? 0 : Math.min(heightOf(content.rows), pickedRow.lines.length + 1);
  const head = content.head.slice(0, Math.max(0, height - kept));
  const room = Math.max(0, height - head.length);
  const tinted = (row: PickRow): Block =>
    row.picked && pickTone !== undefined ? row.lines.map((line) => behind(fit(line, width), pickTone)) : row.lines;
  if (heightOf(content.rows) <= room) return placedRows(head, content.rows, tinted, []);
  const shown = Math.max(0, room - 1);
  const pick = Math.max(0, content.rows.findIndex((row) => row.picked));
  const endFrom = (from: number): number => {
    let to = from;
    while (to < content.rows.length && heightOf(content.rows.slice(from, to + 1)) <= shown) to += 1;
    return to;
  };
  let from = 0;
  while (from < pick && endFrom(from) <= pick) from += 1;
  const window = content.rows.slice(from, endFrom(from));
  const hidden = content.rows.length - window.length;
  return placedRows(head, window, tinted, room > 0 ? [moreLine(hidden)] : []);
};

export const pickToneOf = (column: Level, focus: Level): Tone | undefined => {
  if (column === focus) return "pick";
  return levelIndex(column) < levelIndex(focus) ? "held" : undefined;
};

export interface Crumb<S> {
  readonly text: string;
  readonly open: S;
}

export const levelCrumbs = (levels: TaskLevels, navigation: Navigation, focus: Level): ReadonlyArray<Crumb<Navigation>> => {
  const project = pickedProject(levels, navigation);
  const task = pickedTask(project, navigation);
  const held = { project: project?.name, task: task === undefined ? undefined : listedIdOf(task), detail: navigation.detail };
  return [
    { text: "projects", open: { focus: "projects", ...held } },
    ...(project !== undefined && levelIndex(focus) >= levelIndex("tasks") ? [{ text: projectNameOf(project.name), open: { focus: "tasks" as const, ...held } }] : []),
    ...(task !== undefined && focus === "task" ? [{ text: listedDisplayIdOf(task), open: { focus: "task" as const, ...held } }] : []),
  ];
};

const margin = " ";

const crumbGap = " \u203a ";

export const topLine = <S>(crumbs: ReadonlyArray<Crumb<S>>, right: string, width: number): Drawn<S> => {
  const line: Array<Line[number]> = [span(margin, "foreground")];
  const targets: Array<Target<S>> = [];
  const room = width - widthOf(right) - 1;
  for (const [index, crumb] of crumbs.entries()) {
    if (index > 0) line.push(span(crumbGap, "muted"));
    const from = lineWidth(line);
    const text = ellipsize(crumb.text, Math.max(0, room - from));
    line.push(span(text, index === 0 ? "foreground" : "accent"));
    targets.push({ row: 0, from, to: from + widthOf(text), state: crumb.open });
  }
  const left = fit(line, Math.max(0, width - widthOf(right)));
  return { block: [[...left, span(right, "muted")]], targets };
};

const keyWords = [
  " \u2191\u2193 pick a row   \u23ce or \u2192 step in   esc or \u2190 step back   click a row to open it   click a name in the top line to jump there   q quit",
  " \u2191\u2193 pick   \u23ce/\u2192 in   esc/\u2190 back   click to open   q quit",
];

export const keyLine = (width: number): Line => fit(truncate([span(keyWords.find((words) => widthOf(words) <= width) ?? keyWords.at(-1) ?? "", "muted")], width), width);

export const contentHeight = (content: Content): number => content.head.length + heightOf(content.rows);

export interface Boxed {
  readonly block: Block;
  // Each row is counted from the box's top edge.
  readonly targets: ReadonlyArray<{ readonly row: number; readonly open: Navigation }>;
}

export const boxColumn = (content: Content, width: number, height: number, frame: Frame, pickTone: Tone | undefined, bottom: Block = []): Boxed => {
  const foot = bottom.map((line) => fit(line, width - panelChrome));
  const place = placed(content, width - panelChrome, height - 2 - foot.length, pickTone);
  const padded = [...place.lines, ...foot, ...Array.from({ length: Math.max(0, height - 2 - place.lines.length - foot.length) }, (): Line => [])];
  return {
    block: panel(content.title, padded, width, frame),
    targets: place.targets.map((target) => ({ row: 1 + target.line, open: target.open })),
  };
};

export const levelsRight = (readings: TasksReadings): string =>
  `${readings.levels.pending ? "reading\u2026  " : ""}${clock(readings.levels.now, readings.levels.now, readings.zone)} `;

const shortCadence = (cadence: string): string => `\u21bb ${cadence.replace(/^every /, "")}`;

const tasksTitle = (name: string, suffix: string, width: number, focused: boolean, key?: string): Line => {
  const parts = suffix.split(" \u00b7 ").filter((part) => part !== "");
  const every = parts.find((part) => part.startsWith("every ")) ?? "";
  const rest = parts.filter((part) => part !== every);
  const room = titleRoom(width) - (every === "" ? 0 : widthOf(shortCadence(every)) + 2);
  const head = ellipsize(name, room);
  const named: Line = keyedName(head, focused ? "focus" : "foreground", focused ? { bold: true } : {}, key);
  const tail: Line = rest.length === 0 ? [] : [span(` \u00b7 ${rest.join(" \u00b7 ")}`, "muted")];
  if (every === "") return [...named, ...tail];
  return [...named, ...tail, rightSpan(shortCadence(every), "muted")];
};

export const drawTasks = (readings: TasksReadings, navigation: Navigation, columns: number, rows: number, titleSuffix = "", projectKey?: string): Drawn<Navigation> => {
  const width = Math.max(leastWidth, columns);
  const slots = levelsShown(width);
  const boxWidth = Math.min(levelWidth, width);
  const all = levelColumns(readings, navigation);
  const focusIndex = Math.min(levelIndex(navigation.focus), all.length - 1);
  const focus = all[focusIndex]?.level ?? "projects";
  const start = Math.max(0, Math.min(focusIndex, all.length - slots));
  const shown = all.slice(start, start + slots).map((column) => ({ level: column.level, content: column.content(boxWidth - panelChrome) }));
  const bodyHeight = Number.isFinite(rows) ? Math.max(3, rows - chromeRows) : Math.max(...shown.map((column) => contentHeight(column.content))) + 2;
  const top = topLine(levelCrumbs(readings.levels, navigation, focus), levelsRight(readings), width);
  const targets: Array<Target<Navigation>> = [...top.targets];
  const boxes = shown.map(({ level, content }, slot) => {
    const frame = level === focus ? focusFrame : restFrame;
    const boxed = boxColumn({ ...content, title: content.title + titleSuffix }, boxWidth, bodyHeight, frame, pickToneOf(level, focus));
    const block = [...boxed.block];
    block[0] = titleEdge(tasksTitle(content.title, titleSuffix, boxWidth, level === focus, level === "projects" ? projectKey : undefined), boxWidth, frame);
    const x = slot * boxWidth;
    for (const target of boxed.targets) targets.push({ row: 1 + target.row, from: x + 2, to: x + boxWidth - 2, state: target.open });
    return { width: boxWidth, block };
  });
  const filled = boxes.reduce((total, box) => total + box.width, 0);
  const body = Array.from({ length: bodyHeight }, (_, index): Line => [
    ...boxes.flatMap((box) => box.block[index] ?? []),
    ...(filled < width ? [span(" ".repeat(width - filled), "foreground")] : []),
  ]);
  const block = [...top.block, ...body, keyLine(width)];
  if (!Number.isFinite(rows)) return { block, targets };
  const cut = withinRows(block, rows);
  if (cut.length === block.length) return { block: cut, targets };
  return { block: cut, targets: targets.filter((target) => target.row < cut.length - 1) };
};
