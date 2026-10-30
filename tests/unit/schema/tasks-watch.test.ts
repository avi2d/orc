import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Clock, ConfigProvider, DateTime, Deferred, Duration, Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { type Command, CommandRunner, CommandUnreachable, LocalTasks, type Reading, type ReportedTasks, decodeTasksReport, watchedLocalTasksLayerWithin, watchedRead } from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tui-dash-tasks-watch-"));
  mkdirSync(join(home, "state"));
  mkdirSync(join(home, "data"));
  writeFileSync(join(home, "state", "bridge.meta"), "kind=ship\n");
  writeFileSync(join(home, "state", "bridge.status"), "working: started\n");
  writeFileSync(join(home, "data", "backlog.md"), "# Backlog\n");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const watchedHome = () => `${join(home, "state")}:${join(home, "data", "backlog.md")}`;

interface Runs {
  started: number;
  running: number;
  mostAtOnce: number;
}

interface Answer {
  readonly fails?: (run: number) => boolean;
  readonly held?: Deferred.Deferred<void>;
  readonly entered?: Deferred.Deferred<void>;
}

const countingRunner = (runs: Runs, { fails = () => false, held, entered }: Answer) => ({
  run: (_command: Command) =>
    Effect.gen(function* () {
      runs.started += 1;
      const run = runs.started;
      runs.running += 1;
      runs.mostAtOnce = Math.max(runs.mostAtOnce, runs.running);
      if (entered !== undefined) yield* Effect.asVoid(Deferred.succeed(entered, undefined));
      if (held !== undefined) yield* Deferred.await(held);
      runs.running -= 1;
      if (fails(run)) return yield* new CommandUnreachable({ reason: "sh exited 1: error: no homes found" });
      return fixture("tasks/east.json");
    }),
});

const watching = <A>(
  env: Record<string, string>,
  answer: Answer,
  program: (read: Effect.Effect<Reading<ReportedTasks>>, runs: Runs) => Effect.Effect<A>,
): Promise<A> => {
  const runs: Runs = { started: 0, running: 0, mostAtOnce: 0 };
  const sources = Layer.mergeAll(
    Layer.succeed(CommandRunner, countingRunner(runs, answer)),
    BunFileSystem.layer,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord({ TUI_DASH_TASKS: "tasks-report.sh", ...env })),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const local = yield* LocalTasks;
      if (Option.isNone(local)) return yield* Effect.die("no local tasks command");
      return yield* program(local.value.read, runs);
    }).pipe(Effect.provide(Layer.merge(watchedLocalTasksLayerWithin(Duration.minutes(2)).pipe(Layer.provide(sources)), TestClock.layer()))),
  );
};

const readAt = (read: Effect.Effect<Reading<ReportedTasks>>, seconds: number) => Effect.andThen(TestClock.setTime(seconds * 1_000), read);

const capturedSecond = (reading: Reading<ReportedTasks>): number => DateTime.toEpochMillis(reading.capturedAt) / 1_000;

describe("the live tasks report, rerun only when what the orchestrator writes has changed", () => {
  test("runs the report once while nothing it watches changes, however often the screen asks", async () => {
    const started = await watching({ TUI_DASH_TASKS_WATCH: watchedHome() }, {}, (read, runs) =>
      Effect.gen(function* () {
        for (const seconds of [0, 10, 31, 61, 91, 121, 181]) yield* readAt(read, seconds);
        return runs.started;
      }),
    );
    expect(started).toBe(1);
  });

  test("reruns on the first read 30 seconds after the last run once the backlog changed, and not sooner", async () => {
    const seen = await watching({ TUI_DASH_TASKS_WATCH: watchedHome() }, {}, (read, runs) =>
      Effect.gen(function* () {
        yield* readAt(read, 0);
        appendFileSync(join(home, "data", "backlog.md"), "- [ ] bridge-plot - plot the bridge\n");
        const early = yield* readAt(read, 20);
        const startedEarly = runs.started;
        const due = yield* readAt(read, 30);
        return { startedEarly, early: capturedSecond(early), started: runs.started, due: capturedSecond(due) };
      }),
    );
    expect(seen).toEqual({ startedEarly: 1, early: 0, started: 2, due: 30 });
  });

  test("reruns once a line is appended to a task's status file in a watched folder", async () => {
    const started = await watching({ TUI_DASH_TASKS_WATCH: watchedHome() }, {}, (read, runs) =>
      Effect.gen(function* () {
        yield* readAt(read, 0);
        yield* readAt(read, 40);
        appendFileSync(join(home, "state", "bridge.status"), "done: PR open\n");
        yield* readAt(read, 50);
        yield* readAt(read, 80);
        return runs.started;
      }),
    );
    expect(started).toBe(2);
  });

  test("counts a new entry in a watched folder but not a hidden one", async () => {
    const started = await watching({ TUI_DASH_TASKS_WATCH: watchedHome() }, {}, (read, runs) =>
      Effect.gen(function* () {
        yield* readAt(read, 0);
        writeFileSync(join(home, "state", ".last-watcher-beat"), "");
        yield* readAt(read, 40);
        const afterHidden = runs.started;
        writeFileSync(join(home, "state", "inbox-sweep.meta"), "kind=ship\n");
        yield* readAt(read, 80);
        return [afterHidden, runs.started];
      }),
    );
    expect(started).toEqual([1, 2]);
  });

  test("never runs two reports at once, so reads asked during a run share its answer", async () => {
    const held = Deferred.makeUnsafe<void>();
    const entered = Deferred.makeUnsafe<void>();
    let stampValue = "a";
    const runs: Runs = { started: 0, running: 0, mostAtOnce: 0 };
    const stamp = Effect.suspend(() => Effect.succeedSome(stampValue));
    const read = Effect.gen(function* () {
      runs.started += 1;
      runs.running += 1;
      runs.mostAtOnce = Math.max(runs.mostAtOnce, runs.running);
      yield* Effect.asVoid(Deferred.succeed(entered, undefined));
      yield* Deferred.await(held);
      runs.running -= 1;
      const outcome = decodeTasksReport(fixture("tasks/east.json"));
      if (outcome.kind !== "ok") return yield* Effect.die("bad fixture");
      return { ...outcome, capturedAt: yield* DateTime.now };
    });
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const reader = yield* watchedRead(read, stamp);
        yield* TestClock.setTime(0);
        const first = yield* Effect.forkChild(reader);
        yield* Deferred.await(entered);
        stampValue = "b";
        yield* TestClock.setTime(40_000);
        const later = yield* Effect.forEach([0, 1], () => Effect.forkChild(reader));
        yield* Effect.yieldNow;
        yield* Effect.promise(() => Bun.sleep(50));
        const whileHeld = { started: runs.started, mostAtOnce: runs.mostAtOnce };
        yield* Deferred.succeed(held, undefined);
        const readings = yield* Fiber.joinAll([first, ...later]);
        return { whileHeld, started: runs.started, mostAtOnce: runs.mostAtOnce, kinds: readings.map((reading) => reading.kind) };
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(seen).toEqual({ whileHeld: { started: 1, mostAtOnce: 1 }, started: 2, mostAtOnce: 1, kinds: ["ok", "ok", "ok"] });
  });

  test("measures the 30 second floor from report start, not scan start", async () => {
    let stampValue = "a";
    let scan = Duration.millis(2_000);
    const starts: Array<number> = [];
    const stamp = Effect.suspend(() => Effect.as(TestClock.adjust(scan), Option.some(stampValue)));
    const read = Effect.suspend(() =>
      Effect.gen(function* () {
        starts.push(yield* Clock.currentTimeMillis);
        yield* TestClock.adjust(Duration.seconds(7));
        const outcome = decodeTasksReport(fixture("tasks/east.json"));
        if (outcome.kind !== "ok") return yield* Effect.die("bad fixture");
        return { ...outcome, capturedAt: yield* DateTime.now };
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const reader = yield* watchedRead(read, stamp);
        yield* TestClock.setTime(0);
        yield* reader;
        stampValue = "b";
        scan = Duration.millis(100);
        yield* TestClock.setTime(30_000);
        yield* reader;
        yield* TestClock.setTime(32_000);
        yield* reader;
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(starts.length).toBe(2);
    expect(starts[1]).toBeGreaterThanOrEqual(32_000);
  });

  test("with nothing to watch, runs once and never again", async () => {
    const started = await watching({ HOME: home }, {}, (read, runs) =>
      Effect.gen(function* () {
        for (const seconds of [0, 10, 30, 60, 90]) yield* readAt(read, seconds);
        return runs.started;
      }),
    );
    expect(started).toBe(1);
  });

  test("reruns a failed report only once something it watches changed", async () => {
    const seen = await watching({ TUI_DASH_TASKS_WATCH: watchedHome() }, { fails: (run) => run === 1 }, (read, runs) =>
      Effect.gen(function* () {
        const failed = yield* readAt(read, 0);
        const held = yield* readAt(read, 30);
        appendFileSync(join(home, "data", "backlog.md"), "- [ ] bridge-plot - plot the bridge\n");
        const retried = yield* readAt(read, 60);
        return { kinds: [failed.kind, held.kind, retried.kind], started: runs.started };
      }),
    );
    expect(seen).toEqual({ kinds: ["unreachable", "unreachable", "ok"], started: 2 });
  });

  test("watches entries with space around the separator", async () => {
    const spaced = `${join(home, "state")} : ${join(home, "data", "backlog.md")}`;
    const started = await watching({ TUI_DASH_TASKS_WATCH: spaced }, {}, (read, runs) =>
      Effect.gen(function* () {
        yield* readAt(read, 0);
        appendFileSync(join(home, "data", "backlog.md"), "- [ ] bridge-plot - plot the bridge\n");
        yield* readAt(read, 40);
        return runs.started;
      }),
    );
    expect(started).toBe(2);
  });

  test("prefers the watch list over homes the fallback would name instead of watching both", async () => {
    const other = join(home, "other");
    mkdirSync(join(other, "state"), { recursive: true });
    mkdirSync(join(other, "data"), { recursive: true });
    writeFileSync(join(other, "data", "backlog.md"), "# Backlog\n");
    const east = join(home, "fm-east");
    mkdirSync(join(east, "state"), { recursive: true });
    mkdirSync(join(east, "data"), { recursive: true });
    writeFileSync(join(east, "data", "backlog.md"), "# Backlog\n");
    const seen = await watching(
      { TUI_DASH_TASKS_WATCH: watchedHome(), FM_TASKS_HOMES: other, FM_HOME: other, HOME: home },
      {},
      (read, runs) =>
        Effect.gen(function* () {
          yield* readAt(read, 0);
          appendFileSync(join(other, "data", "backlog.md"), "- [ ] other-plot - plot the other span\n");
          appendFileSync(join(east, "data", "backlog.md"), "- [ ] east-plot - plot the east span\n");
          yield* readAt(read, 40);
          const afterOthers = runs.started;
          appendFileSync(join(home, "data", "backlog.md"), "- [ ] bridge-plot - plot the bridge\n");
          yield* readAt(read, 80);
          return [afterOthers, runs.started];
        }),
    );
    expect(seen).toEqual([1, 2]);
  });

  test("watches the homes FM_TASKS_HOMES names when the watch list is unset instead of running once", async () => {
    const started = await watching({ HOME: home, FM_TASKS_HOMES: `${home}: ` }, {}, (read, runs) =>
      Effect.gen(function* () {
        yield* readAt(read, 0);
        appendFileSync(join(home, "data", "backlog.md"), "- [ ] bridge-plot - plot the bridge\n");
        yield* readAt(read, 40);
        return runs.started;
      }),
    );
    expect(started).toBe(2);
  });

  test("discovers fm-* homes under HOME and the FM_HOME home when neither list is set instead of running once", async () => {
    mkdirSync(join(home, "fm-east", "state"), { recursive: true });
    mkdirSync(join(home, "fm-east", "data"), { recursive: true });
    writeFileSync(join(home, "fm-east", "data", "backlog.md"), "# Backlog\n");
    const seen = await watching({ HOME: home, FM_HOME: home }, {}, (read, runs) =>
      Effect.gen(function* () {
        yield* readAt(read, 0);
        appendFileSync(join(home, "fm-east", "data", "backlog.md"), "- [ ] east-plot - plot the east span\n");
        yield* readAt(read, 40);
        const afterEast = runs.started;
        appendFileSync(join(home, "data", "backlog.md"), "- [ ] bridge-plot - plot the bridge\n");
        yield* readAt(read, 80);
        return [afterEast, runs.started];
      }),
    );
    expect(seen).toEqual([2, 3]);
  });
});
