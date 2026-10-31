import { describe, expect, test } from "bun:test";
import { ConfigProvider, DateTime, Effect, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  CommandRunner,
  decodeNoMistakes,
  decodeTasksReport,
  type NoMistakesSnapshot,
  type LiveTasks,
  liveTasksReport,
  noMistakesMachinesLayer,
  ok,
  type Outcome,
  orcMachinesLayer,
  pueueMachinesLayer,
  stampedNow,
  type TaskListing,
  type TaskSampleRecord,
  atInterval,
  taskLevels,
  TasksReport,
  tasksMachinesLayer,
  remoteTaskHistoryLayer,
  remoteTaskLiveLayer,
} from "@tui-dash/schema";
import { backgroundRemoteTaskPollsWithin, drawTasks, finishedRemoteTaskPolls, type Navigation, readRemoteTaskLevels, type RemotePolls } from "@tui-dash/tasks";
import { plain } from "@tui-dash/ui";
import { fixture } from "../../lib/fixtures";
import { live, southTaskReadings, taskReadings } from "../../lib/task-levels-fixture";

const utc = DateTime.zoneMakeNamedUnsafe("UTC");

const at = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso);

const gib = 1024 ** 3;

const southListing = (): TaskListing => decodeTasksReport(fixture("tasks/south.json"));

const remotePolls = (
  tasks: TaskListing,
  samples: ReadonlyArray<TaskSampleRecord> = [],
  reading?: Outcome<LiveTasks>,
  mistakes?: Outcome<NoMistakesSnapshot>,
): RemotePolls => ({
  machine: "south",
  tasks: stampedNow(Effect.succeed(tasks)),
  live: reading === undefined ? Effect.succeedNone : Effect.asSome(stampedNow(Effect.succeed(reading))),
  liveConfigured: reading !== undefined,
  pueue: Effect.succeedNone,
  noMistakes: () => (mistakes === undefined ? Effect.succeedNone : Effect.asSome(stampedNow(Effect.succeed(mistakes)))),
  orc: () => Effect.succeedNone,
  samples: Effect.asSome(stampedNow(Effect.succeed(samples))),
  refreshing: Effect.succeed(false),
  listingsRefreshing: Effect.succeed(false),
});

// The south report's own generation time, so its tasks and samples stay inside the last 7 days however old the fixture grows.
const southNow = at("2026-10-19T08:02:11Z");

const liveCommandLayers = () => {
  const liveCommand = "ssh south.example.com tasks-live-json";
  const printed = JSON.stringify(liveTasksReport({ generatedAt: southNow, live: ok(live()) }));
  const config = ConfigProvider.layer(
    ConfigProvider.fromEnvRecord({
      TUI_DASH_MACHINE: "north",
      TUI_DASH_REMOTE_MACHINE: "south",
      TUI_DASH_TASKS: "tasks-report --json",
      TUI_DASH_REMOTE_TASKS: "ssh south.example.com tasks-report --json",
      TUI_DASH_REMOTE_TASK_LIVE: liveCommand,
    }),
  );
  const layers = Layer.mergeAll(tasksMachinesLayer, pueueMachinesLayer, noMistakesMachinesLayer, orcMachinesLayer, remoteTaskHistoryLayer, remoteTaskLiveLayer).pipe(
    Layer.provide(
      Layer.succeed(CommandRunner, {
        run: (command) => Effect.succeed(command.argv.join(" ").includes(liveCommand) ? printed : ""),
      }),
    ),
    Layer.provide(config),
  );
  return Layer.merge(layers, config);
};

const readRemote = (polls: RemotePolls) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(southNow));
      return yield* readRemoteTaskLevels(polls, Effect.undefined);
    }).pipe(Effect.provide(TestClock.layer())),
  );

const texts = (levels: Parameters<typeof drawTasks>[0], navigation: Navigation): ReadonlyArray<string> =>
  drawTasks(levels, navigation, 120, 20).block.map(plain);

const onProjects: Navigation = { focus: "projects", project: undefined, task: undefined, detail: 0 };

describe("the remote machine's levels", () => {
  test("reads the other machine's projects and tasks from its report", async () => {
    const { readings } = await readRemote(remotePolls(southListing()));
    expect([readings.levels.machine, readings.levels.source]).toEqual(["south", "remote"]);
    expect(readings.levels.projects.map((project) => project.name)).toEqual(["kelp"]);
    expect(readings.levels.projects.flatMap((project) => project.tasks.map((task) => task.id))).toEqual([
      "tasks-kelp-sort",
      "tasks-kelp-tend",
    ]);
  });

  test("names the other machine in its projects title, so its rows are never read as this machine's", async () => {
    const { readings } = await readRemote(remotePolls(southListing()));
    const titles = [...(texts({ levels: readings.levels, zone: utc }, onProjects)[1] ?? "").matchAll(/[╭┏][─━] (.+?) [─━]/gu)].map(
      (match) => match[1],
    );
    expect(titles).toEqual(["projects · south · today", "kelp · tasks"]);
  });

  test("a failing remote report surfaces as failures with no projects", async () => {
    const { readings } = await readRemote(remotePolls({ kind: "unreachable", reason: "ssh: connect to host south: Connection refused" }));
    expect(readings.levels.projects).toEqual([]);
    expect(texts({ levels: readings.levels, zone: utc }, onProjects).join("\n")).toContain("Connection refused");
  });

  test("a remote report with no tasks in it says so instead of borrowing this machine's", async () => {
    const empty = decodeTasksReport(
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-10-19T08:02:11.000Z",
        orchestrator: { name: "kelp-farmer", version: "0.9.0" },
        tasks: [],
        overhead: [],
        schedules: [],
      }),
    );
    const { readings } = await readRemote(remotePolls(empty));
    expect(readings.levels.projects).toEqual([]);
    expect(texts({ levels: readings.levels, zone: utc }, onProjects).join("\n")).toContain("no task today");
    const all = atInterval(readings.levels, "all", southNow, utc);
    expect(texts({ levels: all, zone: utc }, onProjects).join("\n")).toContain("no task in the last 7 days");
  });

  test("an unset remote command leaves no remote polls", async () => {
    const layers = Layer.mergeAll(tasksMachinesLayer, pueueMachinesLayer, noMistakesMachinesLayer, orcMachinesLayer, remoteTaskHistoryLayer, remoteTaskLiveLayer).pipe(
      Layer.provide(Layer.succeed(CommandRunner, { run: () => Effect.succeed("") })),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
    );
    expect(await Effect.runPromise(Effect.provide(finishedRemoteTaskPolls, layers))).toBe(undefined);
  });

  test("an unset remote report names its variable, like the local one names its own", async () => {
    const levels = taskLevels(taskReadings({ machine: "south", origin: "remote", tasks: { kind: "unset" } }));
    expect(texts({ levels, zone: utc }, onProjects).join("\n")).toContain("TUI_DASH_REMOTE_TASKS is unset");
  });

  test("a task's detail says so when the other machine's live processes were not read", async () => {
    const levels = taskLevels(southTaskReadings());
    const detail: Navigation = { focus: "task", project: "kelp", task: "south tasks-kelp-tend", detail: 0 };
    expect(texts({ levels, zone: utc }, detail).join("\n")).toContain("no live process on south is read here");
  });

  test("the other machine's samples show in its task's kept cpu and peak", async () => {
    const samples: ReadonlyArray<TaskSampleRecord> = [
      {
        schemaVersion: 1,
        at: at("2026-10-19T07:00:00Z"),
        machine: { cores: 16, memoryBytes: 47 * gib },
        task: {
          id: "tasks-kelp-tend",
          title: "Tend the kelp lines",
          project: "kelp",
          state: "working",
          firstStartedAt: at("2026-10-18T21:40:00Z"),
          endedAt: null,
        },
        usage: { processes: [{ identity: "1900 2026-10-19T06:00:00Z", ownSeconds: 300 }], cpuCores: 0.5, residentBytes: 2 * gib },
        spend: null,
        tests: [],
      },
    ];
    const { readings } = await readRemote(remotePolls(southListing(), samples));
    const detail: Navigation = { focus: "task", project: "kelp", task: "south tasks-kelp-tend", detail: 0 };
    expect(texts({ levels: readings.levels, zone: utc }, detail).join("\n")).toContain("kept   cpu 5m · peak memory 2.0G");
  });

  test("reads the other machine's live usage from its live report", async () => {
    const { readings } = await readRemote(remotePolls(southListing(), [], ok(live())));
    expect(readings.levels.usageRead).toBe(true);
  });

  test("leaves the other machine's usage unread when its live report fails", async () => {
    const { readings } = await readRemote(
      remotePolls(southListing(), [], { kind: "unreachable", reason: "ssh: connect to host south: Connection refused" }),
    );
    expect(readings.levels.usageRead).toBe(false);
  });

  test("reads the other machine's live usage through its live command", async () => {
    const polls = await Effect.runPromise(Effect.provide(finishedRemoteTaskPolls, liveCommandLayers()));
    expect(polls?.machine).toBe("south");
    const answered = await Effect.runPromise(polls?.live ?? Effect.succeedNone);
    expect(Option.isSome(answered) ? answered.value.value : undefined).toEqual(ok(live()));
  });

  test("joins the other machine's pipeline runs instead of leaving its rows without one", async () => {
    const typed = Schema.decodeUnknownSync(TasksReport)(JSON.parse(fixture("tasks/south.json")));
    const listing = decodeTasksReport(
      JSON.stringify({
        ...typed,
        tasks: typed.tasks.map((task, index) => (index === 0 ? { ...task, kind: "full review fix", branches: ["fm/tui-dash-fast-start"] } : task)),
      }),
    );
    const mistakes = decodeNoMistakes(fixture("no-mistakes/run.txt"));
    const { readings } = await readRemote(remotePolls(listing, [], undefined, mistakes));
    const task = readings.levels.projects.flatMap((project) => project.tasks).find((row) => row.id === "tasks-kelp-tend");
    expect(task?.pipeline?.kind).toBe("full review fix");
    const marks = new Map(task?.pipeline?.stages.map((stage) => [stage.name, stage.mark]));
    expect(marks.get("review")).toBe("done");
    expect(marks.get("CI")).toBe("done");
    expect(marks.get("merge")).toBe("next");
    expect(task?.pipeline?.stages.find((stage) => stage.name === "review")?.detail).toContain("reviewer Sol");
    expect(task?.pipeline?.stages.some((stage) => stage.mark === "unknown")).toBe(false);
  });

  test("a printed remote task whose no-mistakes run waits on a gate prints as waiting, not working", async () => {
    const typed = Schema.decodeUnknownSync(TasksReport)(JSON.parse(fixture("tasks/south.json")));
    const report = JSON.stringify({
      ...typed,
      tasks: typed.tasks.map((task, index) => (index === 0 ? { ...task, kind: "full review fix", branches: ["fm/tui-dash-fast-start"] } : task)),
    });
    const gated = fixture("no-mistakes/run.txt")
      .replace("status: completed", "status: running")
      .replace("review,completed,8,4501436", "review,awaiting_approval,8,4501436");
    const config = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        TUI_DASH_MACHINE: "north",
        TUI_DASH_REMOTE_MACHINE: "south",
        TUI_DASH_REMOTE_TASKS: "ssh south.example.com tasks-report --json",
      }),
    );
    const layers = Layer.mergeAll(tasksMachinesLayer, pueueMachinesLayer, noMistakesMachinesLayer, orcMachinesLayer, remoteTaskHistoryLayer, remoteTaskLiveLayer).pipe(
      Layer.provide(
        Layer.succeed(CommandRunner, {
          run: (command) => {
            const line = command.argv.join(" ");
            return Effect.succeed(line.includes("no-mistakes axi status") ? gated : line.includes("tasks-report --json") ? report : "");
          },
        }),
      ),
      Layer.provide(config),
    );
    const polls = await Effect.runPromise(Effect.provide(finishedRemoteTaskPolls, Layer.merge(layers, config)));
    if (polls === undefined) throw new Error("the remote machine is configured, so its polls exist");
    const { readings } = await readRemote(polls);
    const task = readings.levels.projects.flatMap((project) => project.tasks).find((row) => row.id === "tasks-kelp-tend");
    expect(task?.state).toBe("waiting");
  });

  test("polls the other machine's live usage in the background", async () => {
    const reading = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const polls = yield* Effect.provide(backgroundRemoteTaskPollsWithin(), liveCommandLayers());
          return yield* (polls?.live ?? Effect.succeedNone);
        }),
      ),
    );
    expect(Option.isSome(reading) ? reading.value.value : undefined).toEqual(ok(live()));
  });
});
