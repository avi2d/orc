import { DateTime, Effect, Schema } from "effect";
import { atInterval, type Freshness, type Interval, mergedTaskLevels, readsCadence, type TaskBoard, TaskBoardFeed, type TaskLevels } from "@tui-dash/schema";
import {
  type Block,
  cadencedTitle,
  type Drawn,
  everyText,
  frameRows,
  type Look,
  lookFrame,
  mountedOf,
  panelChrome,
  panelModule,
  type PanelModule,
  type Placed,
  savedText,
  type ScreenSize,
  sideBySide,
  splitWidth,
  type Target,
  titleEdge,
} from "@tui-dash/ui";
import { printTasksFrame, runTasksScreen, type TasksSources } from "./screen";
import { boxColumn, contentHeight, drawTasks, levelColumns, pickToneOf } from "./layout";
import { levelIndex, moved, type Navigation, startNavigation } from "./navigation";

export const tasksSettings = Schema.Struct({
  remote: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});

export type TasksSettings = typeof tasksSettings.Type;

interface TasksView {
  readonly held: Navigation;
  readonly interval: Interval;
}

const levelWidth = 60;

const mostLevels = 3;

const levelsShown = (width: number): number => Math.max(1, Math.min(mostLevels, Math.floor(width / levelWidth)));

// The row splits into even slots a level wide, and the box beside keeps one of them while the row has a slot to spare.
const widthInRow = (levels: number, row: number): number =>
  levels < Math.floor(row / levelWidth) ? row - (splitWidth(row, levels + 1).at(0) ?? 0) : row;

// The projects board reads every machine's tasks report at once, so one project with tasks on both machines keeps one row.
export const boardLevels = (board: TaskBoard, interval: Interval): TaskLevels => {
  const others = [...board.byMachine.values()].filter((level) => level.machine !== board.levels.machine);
  const unified = mergedTaskLevels([board.levels, ...others]);
  return atInterval(unified, interval, unified.now, board.zone);
};

const cadenceOf = (board: TaskBoard, levels: TaskLevels): string =>
  ` \u00b7 ${everyText(readsCadence)}${savedText(board.shownAt.get(levels.machine), DateTime.toEpochMillis(levels.now))}`;

export const tasksPlaced = (reading: () => TaskBoard, view: TasksView = { held: startNavigation, interval: "today" }): Placed => {
  const withHeld = (held: Navigation): Placed => tasksPlaced(reading, { ...view, held });
  const levelsNow = () => boardLevels(reading(), view.interval);
  const shownColumns = (width: number, focused: boolean) => {
    const board = reading();
    const levels = levelsNow();
    const all = levelColumns({ levels, zone: board.zone }, view.held);
    const focusIndex = Math.min(levelIndex(view.held.focus), all.length - 1);
    const count = Math.min(levelsShown(width), all.length);
    const start = focused ? Math.max(0, Math.min(focusIndex, all.length - count)) : 0;
    return { shown: all.slice(start, start + count), focus: all[focusIndex]?.level ?? "projects", widths: splitWidth(width, count) };
  };
  const alone = (size: ScreenSize): Drawn<Placed> => {
    const board = reading();
    const levels = levelsNow();
    const drawn = drawTasks({ levels, zone: board.zone }, view.held, size.columns, size.rows, cadenceOf(board, levels), "p");
    return { block: drawn.block, targets: drawn.targets.map((target) => ({ ...target, state: withHeld(target.state) })) };
  };
  const boxes = (size: ScreenSize, look: Look): Drawn<Placed> => {
    const { shown, focus, widths } = shownColumns(size.columns, look.focused);
    const height = size.rows;
    const targets: Array<Target<Placed>> = [];
    let x = 0;
    const columns = shown.map((column, index) => {
      const width = widths.at(index) ?? 0;
      const content = column.content(width - panelChrome);
      const focused = look.focused && column.level === focus;
      const frame = lookFrame({ ...look, focused });
      const boxed = boxColumn(content, width, height, frame, look.focused ? pickToneOf(column.level, focus) : undefined, index === 0 ? look.below : []);
      const block = [...boxed.block];
      const title = index === 0 && look.title !== undefined ? look.title : cadencedTitle(content.title, everyText(readsCadence), width, focused, column.level === "projects" ? "p" : undefined);
      block[0] = titleEdge(title, width, frame);
      for (const target of boxed.targets) targets.push({ row: target.row, from: x + 2, to: x + width - 2, state: withHeld(target.open) });
      x += width;
      return { width, block };
    });
    return { block: sideBySide(columns, height), targets };
  };
  return {
    box: (size, look) => (look.alone ? alone(size) : boxes(size, look)),
    natural: (width) => {
      const { shown, widths } = shownColumns(width, false);
      return Math.max(0, ...shown.map((column, index) => contentHeight(column.content((widths.at(index) ?? 0) - panelChrome)))) + frameRows;
    },
    least: () => frameRows + 1,
    fullWidth: (row) => widthInRow(Math.min(mostLevels, levelColumns({ levels: levelsNow(), zone: reading().zone }, view.held).length), row),
    glance: (): ReadonlyArray<Block> => [],
    move: (move) => {
      if (move === "out" && view.held.focus === "projects") return undefined;
      if (move === "pageup" || move === "pagedown") return withHeld(view.held);
      return withHeld(moved(levelsNow(), view.held, move));
    },
    press: (key) => {
      if (key === "t") return tasksPlaced(reading, { ...view, interval: view.interval === "today" ? "all" : "today" });
      if (key === "p") return withHeld({ ...view.held, focus: "projects" });
      return tasksPlaced(reading, view);
    },
  };
};

const mountTasks = Effect.gen(function* () {
  const board = yield* TaskBoardFeed;
  return yield* mountedOf({
    name: "tasks",
    key: "p",
    cadence: readsCadence,
    reach: "moves",
    read: Effect.gen(function* () {
      const boardReading = yield* board.read;
      yield* Effect.yieldNow;
      return { board: boardReading, refreshing: yield* board.refreshing };
    }),
    pending: (reading) => reading.board.levels.pending,
    refreshing: (reading) => reading.refreshing,
    freshness: (reading): ReadonlyArray<Freshness> => reading.board.freshness,
    placed: (reading) => tasksPlaced(() => reading().board),
  });
});

export const tasksModule: PanelModule<TasksSources | TaskBoardFeed> = panelModule<TasksSettings, TasksSources | TaskBoardFeed>({
  id: "tasks",
  about: "the projects board, one project's tasks and one task, on every machine with a tasks report",
  settings: tasksSettings,
  mount: () => mountTasks,
  run: (settings) => runTasksScreen(settings.remote),
  print: (settings, frame) => printTasksFrame(frame.width, frame.height, settings.remote, frame.color),
});
