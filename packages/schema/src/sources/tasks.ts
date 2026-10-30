import { Clock, Config, Context, Duration, Effect, FileSystem, Layer, Option, Semaphore } from "effect";
import { CommandRunner } from "../command";
import { decodeTasksReport, type ReportedTasks } from "../contract/tasks";
import type { Reading } from "../reading";
import { runDecoded, stamped } from "../source";
import { machineNames, selector } from "./environment";

export interface TasksMachine {
  readonly name: string;
  readonly read: Effect.Effect<Reading<ReportedTasks>>;
}

export class TasksMachines extends Context.Service<TasksMachines, ReadonlyArray<TasksMachine>>()("tui-dash/TasksMachines") {}

export class LocalTasks extends Context.Service<LocalTasks, Option.Option<TasksMachine>>()("tui-dash/LocalTasks") {}

// The adapter prints one orchestrator snapshot, so the command answers in seconds on either machine.
const tasksTimeout = Duration.seconds(15);

// The resources report waits on this read and must answer the other machine within its own 15 seconds.
const localTasksTimeout = Duration.seconds(5);

const machinesConfig = Config.all({
  names: machineNames,
  local: selector("TUI_DASH_TASKS"),
  remote: selector("TUI_DASH_REMOTE_TASKS"),
});

const machineOf = (
  name: string,
  argv: readonly [string, ...string[]],
  timeout: Duration.Duration,
  runner: CommandRunner["Service"],
): TasksMachine => ({
  name,
  read: Effect.provideService(stamped(runDecoded({ argv, timeout }, decodeTasksReport)), CommandRunner, runner),
});

// The configured command is a shell line, such as an ssh call, so the shell parses its quoting.
export const tasksMachinesLayer: Layer.Layer<TasksMachines, Config.ConfigError, CommandRunner> = Layer.effect(
  TasksMachines,
  Effect.gen(function* () {
    const { names, local, remote } = yield* machinesConfig;
    const runner = yield* CommandRunner;
    return [
      ...(local === undefined ? [] : [machineOf(names.local, ["sh", "-c", local], tasksTimeout, runner)]),
      ...(remote === undefined ? [] : [machineOf(names.remote, ["sh", "-c", remote], tasksTimeout, runner)]),
    ];
  }),
);

export const localTasksLayerWithin = (timeout: Duration.Duration): Layer.Layer<LocalTasks, Config.ConfigError, CommandRunner> =>
  Layer.effect(
    LocalTasks,
    Effect.gen(function* () {
      const { names, local } = yield* machinesConfig;
      const runner = yield* CommandRunner;
      return local === undefined ? Option.none() : Option.some(machineOf(names.local, ["sh", "-c", local], timeout, runner));
    }),
  );

export const localTasksLayer: Layer.Layer<LocalTasks, Config.ConfigError, CommandRunner> = localTasksLayerWithin(localTasksTimeout);

// One report costs seconds of CPU across the orchestrator's processes, so a live screen starts one at most this often.
const tasksRefreshFloor = Duration.seconds(30);

const splitWatch = (value: string): Array<string> =>
  value.split(":").map((part) => part.trim()).filter((part) => part !== "");

const watchSettings = Config.all({
  watch: selector("TUI_DASH_TASKS_WATCH"),
  taskHomes: selector("FM_TASKS_HOMES"),
  fmHome: selector("FM_HOME"),
  home: selector("HOME"),
});

const homePaths = (home: string): ReadonlyArray<string> => [`${home}/state`, `${home}/data/backlog.md`];

const isStateHome = (fs: FileSystem.FileSystem, home: string): Effect.Effect<boolean> =>
  fs.stat(`${home}/state`).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );

const derivedWatchPaths = (
  fs: FileSystem.FileSystem,
  taskHomes: string | undefined,
  fmHome: string | undefined,
  home: string | undefined,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    if (taskHomes !== undefined) return [...new Set(splitWatch(taskHomes))].flatMap(homePaths);
    const found: Array<string> = [];
    if (home !== undefined) {
      const entries = yield* fs.readDirectory(home).pipe(Effect.orElseSucceed((): Array<string> => []));
      for (const entry of entries.filter((name) => name.startsWith("fm-")).toSorted()) {
        const candidate = `${home}/${entry}`;
        if (yield* isStateHome(fs, candidate)) found.push(candidate);
      }
    }
    if (fmHome !== undefined && !found.includes(fmHome) && (yield* isStateHome(fs, fmHome))) found.push(fmHome);
    return [...new Set(found)].flatMap(homePaths);
  });

const watchPaths = (fs: FileSystem.FileSystem): Effect.Effect<ReadonlyArray<string>, Config.ConfigError> =>
  Effect.gen(function* () {
    const settings = yield* watchSettings;
    if (settings.watch !== undefined) return splitWatch(settings.watch);
    return yield* derivedWatchPaths(fs, settings.taskHomes, settings.fmHome, settings.home);
  });

const fileStamp = (path: string, info: FileSystem.File.Info): string =>
  `${path}\t${Option.match(info.mtime, { onNone: () => "", onSome: (at) => String(at.getTime()) })}\t${info.size}`;

const entryStamp = (fs: FileSystem.FileSystem, path: string): Effect.Effect<string> =>
  fs.stat(path).pipe(
    Effect.map((info) => fileStamp(path, info)),
    Effect.orElseSucceed(() => `${path}\tabsent`),
  );

// A folder's own time moves when a hidden entry comes or goes, so a folder is stamped by its shown entries alone.
const pathStamp = (fs: FileSystem.FileSystem, path: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const info = yield* Effect.option(fs.stat(path));
    if (Option.isNone(info)) return `${path}\tabsent`;
    if (info.value.type !== "Directory") return fileStamp(path, info.value);
    const entries = yield* fs.readDirectory(path).pipe(Effect.orElseSucceed((): Array<string> => []));
    const shown = entries.filter((name) => !name.startsWith(".")).toSorted();
    const stamps = yield* Effect.forEach(shown, (name) => entryStamp(fs, `${path}/${name}`));
    return [path, ...stamps].join("\n");
  });

// With no paths to watch, nothing tells a change apart, so there is no stamp.
const watchedStamp = (fs: FileSystem.FileSystem, paths: ReadonlyArray<string>): Effect.Effect<Option.Option<string>> =>
  paths.length === 0 ? Effect.succeedNone : Effect.map(Effect.forEach(paths, (path) => pathStamp(fs, path)), (stamps) => Option.some(stamps.join("\n")));

interface Kept {
  readonly startedAt: number;
  readonly stamp: Option.Option<string>;
  readonly reading: Reading<ReportedTasks>;
}

const unchangedSince = (kept: Kept, stamp: Option.Option<string>): boolean =>
  Option.getOrUndefined(kept.stamp) === Option.getOrUndefined(stamp);

// Callers that ask while a report runs wait for it and share its answer, so no two reports run at once.
export const watchedRead = <R>(
  read: Effect.Effect<Reading<ReportedTasks>, never, R>,
  stamp: Effect.Effect<Option.Option<string>, never, R>,
): Effect.Effect<Effect.Effect<Reading<ReportedTasks>, never, R>, never, R> =>
  Effect.map(Semaphore.make(1), (one) => {
    let kept: Kept | undefined;
    return one.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (kept !== undefined && now - kept.startedAt < Duration.toMillis(tasksRefreshFloor)) return kept.reading;
        const current = yield* stamp;
        if (kept !== undefined && unchangedSince(kept, current)) return kept.reading;
        const startedAt = yield* Clock.currentTimeMillis;
        const reading = yield* read;
        kept = { startedAt, stamp: current, reading };
        return reading;
      }),
    );
  });

export const watchedLocalTasksLayerWithin = (timeout: Duration.Duration): Layer.Layer<LocalTasks, Config.ConfigError, CommandRunner | FileSystem.FileSystem> =>
  Layer.effect(
    LocalTasks,
    Effect.gen(function* () {
      const { names, local } = yield* machinesConfig;
      const runner = yield* CommandRunner;
      const fs = yield* FileSystem.FileSystem;
      if (local === undefined) return Option.none();
      const paths = yield* watchPaths(fs);
      const machine = machineOf(names.local, ["sh", "-c", local], timeout, runner);
      return Option.some({ name: machine.name, read: yield* watchedRead(machine.read, watchedStamp(fs, paths)) });
    }),
  );
