import { describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { ConfigProvider, DateTime, Effect, Fiber, Layer } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import {
  type Command,
  CommandRunner,
  gpuSourceLayer,
  herdrSourceLayer,
  linuxDiskSourceLayer,
  linuxHarnessProcessSourceLayer,
  linuxHostSourceLayer,
  linuxProcessesSourceLayer,
  linuxTaskProcessesSourceLayer,
  localTasksLayer,
  macDiskSourceLayer,
  macHostSourceLayer,
  macProcessesSourceLayer,
  noMistakesMachinesLayer,
  orcMachinesLayer,
  pueueMachinesLayer,
  quotaSourceLayer,
  remoteTaskHistoryLayer,
  remoteTaskLiveLayer,
  SessionLogSource,
  sessionMachinesLayer,
  type TaskSampleRecord,
  TaskSamplesSource,
  tasksMachinesLayer,
} from "@tui-dash/schema";
import { harvestLogSourceLive, sessionLogSourceLive } from "@tui-dash/session-quota";
import { liveTasksScreen, printTasksFrame, runSampler } from "@tui-dash/tasks";
import { fixture } from "../../lib/fixtures";
import { queueAnswers } from "../../lib/queues-fixture";
import { fixtureHomeEnvironment } from "../../lib/session-fixture";
import { isSavedProfilesCall, recordedSavedProfilesLayer } from "../../lib/saved-profiles";
import { lateQuotaOrTasks, lateRead, startOrderProbe, startedBesideOthers } from "../../lib/late-quota-tasks";

const tasksCommand = "tasks-report --json";

const remoteTasksCommand = "ssh south.example.com tasks-report --json";

const hasTasks = (value: unknown): value is { readonly tasks: ReadonlyArray<Record<string, unknown>> } =>
  typeof value === "object" &&
  value !== null &&
  "tasks" in value &&
  Array.isArray(value.tasks) &&
  value.tasks.every((task): task is Record<string, unknown> => typeof task === "object" && task !== null);

const screenNow = DateTime.makeUnsafe("2026-10-19T08:02:11Z");

const screenNowIso = DateTime.formatIso(screenNow);

// A done task reads only when it ended today, so the east report's done task moves to now however old the fixture grows.
const eastTasksNow = (): string => {
  const parsed: unknown = JSON.parse(fixture("tasks/east.json"));
  if (!hasTasks(parsed)) throw new Error("the east fixture holds no tasks");
  const now = screenNowIso;
  return JSON.stringify({
    ...parsed,
    tasks: parsed.tasks.map((task) => (task["endedAt"] === null ? task : { ...task, endedAt: now })),
  });
};

// The south report's timestamps move to now, so its tasks stay inside the levels' last 7 days however old the fixture grows.
const southTasksNow = (): string => {
  const parsed: unknown = JSON.parse(fixture("tasks/south.json"));
  if (!hasTasks(parsed)) throw new Error("the south fixture holds no tasks");
  const report = parsed;
  const now = screenNowIso;
  return JSON.stringify({
    ...report,
    generatedAt: now,
    tasks: report.tasks.map((task) => ({ ...task, startedAt: now, firstStartedAt: now, endedAt: task["endedAt"] === null ? null : now })),
  });
};

const recordedAnswers: ReadonlyArray<readonly [string, string]> = [
  ["cat /proc/loadavg", fixture("linux/loadavg.txt")],
  ["getconf _NPROCESSORS_ONLN", fixture("linux/nprocessors-onln.txt")],
  ["cat /proc/meminfo", fixture("linux/meminfo.txt")],
  ["df -kP /", fixture("linux/df.txt")],
  ["sh -c df -kP", fixture("mac/df.txt")],
  ["sh -c head -n 1", fixture("linux/stat.txt")],
  ["sh -c sample()", fixture("linux/proc-stat-cmdline.txt")],
  ['sh -c set -e; printf "pagesize', fixture("linux/task-processes.txt")],

  ["herdr agent list", fixture("session-logs/herdr-agents.json")],
  ["sysctl -n", fixture("mac/sysctl.txt")],
  ["vm_stat", fixture("mac/vm_stat.txt")],
  ["top -l 2", fixture("mac/top.txt")],
  ["ps -A", fixture("mac/ps.txt")],
  ["sh -c for d in /proc", fixture("session-logs/harness-processes.txt")],
  ...queueAnswers,
];

const appended: Array<TaskSampleRecord> = [];

const recordedRun = (command: Command): Effect.Effect<string> => {
  if (command.argv[0] === "quota-axi") return Effect.succeed(fixture("quota-axi/full.json"));
  if (isSavedProfilesCall(command)) return Effect.succeed(fixture("saved-profiles/status.json"));
  if (command.argv[2] === remoteTasksCommand) return Effect.sync(southTasksNow);
  if (command.argv.join(" ").startsWith(`sh -c ${tasksCommand}`)) return Effect.sync(eastTasksNow);
  return Effect.succeed(recordedAnswers.find(([asked]) => command.argv.join(" ").startsWith(asked))?.[1] ?? "");
};

const sourcesAnswering = (run: (command: Command) => Effect.Effect<string>) => Layer.mergeAll(
  quotaSourceLayer,
  recordedSavedProfilesLayer,
  macHostSourceLayer,
  macProcessesSourceLayer,
  macDiskSourceLayer,
  linuxHostSourceLayer,
  linuxProcessesSourceLayer,
  linuxDiskSourceLayer,
  gpuSourceLayer,
  herdrSourceLayer,
  linuxHarnessProcessSourceLayer,
  linuxTaskProcessesSourceLayer,
  Layer.mergeAll(
    sessionMachinesLayer,
    pueueMachinesLayer,
    noMistakesMachinesLayer,
    orcMachinesLayer,
    localTasksLayer,
    tasksMachinesLayer,
    remoteTaskHistoryLayer,
    remoteTaskLiveLayer,
  ).pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          TUI_DASH_MACHINE: "north",
          TUI_DASH_TASKS: tasksCommand,
          TUI_DASH_REMOTE_MACHINE: "south",
          TUI_DASH_REMOTE_TASKS: remoteTasksCommand,
        }),
      ),
    ),
  ),
).pipe(
  Layer.merge(
    Layer.merge(sessionLogSourceLive, harvestLogSourceLive).pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(fixtureHomeEnvironment))),
    ),
  ),
  Layer.merge(
    Layer.succeed(TaskSamplesSource, {
      read: () => Effect.succeed([]),
      append: (records) => Effect.sync(() => void appended.push(...records)),
    }),
  ),
  Layer.provide(Layer.succeed(CommandRunner, { run })),
);

const recordedSources = sourcesAnswering(recordedRun);

const frameWhere = async (setup: TestRendererSetup, matches: (frame: string) => boolean): Promise<string> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await Bun.sleep(25);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (matches(frame)) return frame;
  }
  throw new Error(`no frame matched, last was:\n${setup.captureCharFrame()}`);
};

const bothMachines = ConfigProvider.layer(
  ConfigProvider.fromEnvRecord({
    TUI_DASH_MACHINE: "north",
    TUI_DASH_REMOTE_MACHINE: "south",
    TUI_DASH_TASKS: tasksCommand,
    TUI_DASH_REMOTE_TASKS: remoteTasksCommand,
  }),
);

const topLine = (frame: string): string => (frame.split("\n")[0] ?? "").trimEnd();

describe("the live tasks screen", () => {
  test("moves through the levels by keys and clicks", async () => {
    const setup = await createTestRenderer({ width: 120, height: 24 });
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(screenNow));
        yield* liveTasksScreen(setup.renderer);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(recordedSources, ConfigProvider.layer(ConfigProvider.fromEnvRecord({ TUI_DASH_MACHINE: "north" })), TestClock.layer()),
        ),
      ),
    );
    try {
      const first = await frameWhere(setup, (frame) => frame.includes("harbor") && frame.includes("notes"));
      expect(topLine(first)).toMatch(/^ projects +\S/u);
      expect(first).toContain("╭─ harbor · tasks ");
      setup.mockInput.pressArrow("down");
      await frameWhere(setup, (frame) => frame.includes("╭─ notes · tasks "));
      setup.mockInput.pressEnter();
      const notes = await frameWhere(setup, (frame) => topLine(frame).includes("projects › notes"));
      expect(notes).toContain("┏━ notes · tasks ");
      setup.mockInput.pressEscape();
      await frameWhere(setup, (frame) => topLine(frame).includes("projects") && !topLine(frame).includes("›"));
      await setup.mockMouse.click(10, 4);
      const harbor = await frameWhere(setup, (frame) => topLine(frame).includes("projects › harbor"));
      expect(harbor).toContain("┏━ harbor · tasks ");
      await setup.mockMouse.click(10, 3);
      await frameWhere(setup, (frame) => topLine(frame).includes("projects › harbor › tasks-bridge-plot"));
      await setup.mockMouse.click(4, 0);
      await frameWhere(setup, (frame) => frame.includes("┏━ projects · today "));
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  });

  test("lists every machine's tasks on one screen, each row naming its machine", async () => {
    const setup = await createTestRenderer({ width: 120, height: 24 });
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(screenNow));
        yield* liveTasksScreen(setup.renderer);
      }).pipe(Effect.provide(Layer.mergeAll(recordedSources, bothMachines, TestClock.layer()))),
    );
    try {
      const first = await frameWhere(setup, (frame) => ["harbor", "notes", "kelp"].every((project) => frame.includes(` ${project} `)));
      expect(topLine(first)).not.toMatch(/tui-dash|north|south/u);
      let kelp = first;
      for (let step = 0; step < 3 && !kelp.includes("╭─ kelp · tasks "); step += 1) {
        setup.mockInput.pressArrow("down");
        kelp = await frameWhere(setup, (frame) => frame !== kelp);
      }
      const tendRow = kelp.split("\n").find((line) => line.includes("tasks-kelp-tend")) ?? "";
      expect(tendRow).toMatch(/tasks-kelp-tend.* south /u);
      expect(kelp).toMatch(/│ +task +state +machine /u);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  }, 15_000);

  test("reads the other machine's levels with the remote flag", async () => {
    const setup = await createTestRenderer({ width: 120, height: 24 });
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(screenNow));
        yield* liveTasksScreen(setup.renderer, true);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(recordedSources, bothMachines, TestClock.layer()),
        ),
      ),
    );
    try {
      const first = await frameWhere(setup, (frame) => frame.includes("kelp") && frame.includes("south"));
      expect(first).toContain("┏━ projects · south · today ");
      expect(first).toContain("tasks-kelp-tend");
      setup.mockInput.pressEnter();
      await frameWhere(setup, (frame) => topLine(frame).includes("projects › kelp"));
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  });
});

describe("the sampler", () => {
  const firstRound = async (sources: typeof recordedSources) => {
    appended.length = 0;
    const fiber = Effect.runFork(runSampler.pipe(Effect.provide(sources)));
    try {
      for (let attempt = 0; attempt < 200 && appended.length === 0; attempt += 1) await Bun.sleep(25);
      return [...appended];
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  };

  test("takes its sample while the session quota has not answered", async () => {
    const quotaHangs = (command: Command) => (command.argv[0] === "quota-axi" ? Effect.never : recordedRun(command));
    const records = await firstRound(sourcesAnswering(quotaHangs));
    expect(records.map((record) => record.task.id)).toEqual(["tasks-bridge-plot", "tasks-inbox-sweep", "tasks-release-notes"]);
  });

  test("writes every listed task at once, with each task's own usage", async () => {
    const records = await firstRound(recordedSources);
    const cpuOf = (record: TaskSampleRecord) => record.usage?.processes.reduce((total, process) => total + process.ownSeconds, 0);
    expect(records.map((record) => [record.task.id, record.usage?.processes.length, cpuOf(record)])).toEqual([
      ["tasks-bridge-plot", 5, expect.closeTo(571.59, 9)],
      ["tasks-inbox-sweep", 1, expect.closeTo(15.5, 9)],
      ["tasks-release-notes", 1, expect.any(Number)],
    ]);
    expect(records.every((record) => record.machine.cores > 0 && record.machine.memoryBytes > 0)).toBe(true);
  });
});

// A wall clock is not used because load averages would move any duration threshold.
describe("the tasks --print frame", () => {
  test(
    "reads the session quota beside the tasks report",
    async () => {
      const probe = startOrderProbe();
      const lateQuotaAndTasks = sourcesAnswering((command) =>
        lateQuotaOrTasks(command.argv, tasksCommand) ? lateRead(command.argv, recordedRun(command), probe) : recordedRun(command),
      );
      await Effect.runPromise(printTasksFrame(84, 30).pipe(Effect.provide(Layer.merge(lateQuotaAndTasks, TestConsole.layer))));
      expect(startedBesideOthers(probe.events)).toBe(true);
    },
    15_000,
  );

  test("reads the session logs once for both machines", async () => {
    let reads = 0;
    const countedReads = Layer.effect(
      SessionLogSource,
      Effect.gen(function* () {
        const source = yield* SessionLogSource;
        return {
          read: (listing: Parameters<typeof source.read>[0], captured?: Parameters<typeof source.read>[1]) =>
            Effect.andThen(Effect.sync(() => (reads += 1)), source.read(listing, captured)),
        };
      }),
    ).pipe(Layer.provide(recordedSources));
    const frame = await Effect.runPromise(
      Effect.gen(function* () {
        yield* printTasksFrame(120, 30);
        return (yield* TestConsole.logLines).map(String).join("\n");
      }).pipe(Effect.provide(Layer.mergeAll(recordedSources, countedReads, bothMachines, TestConsole.layer))),
    );
    expect(frame).toContain(" kelp ");
    expect(reads).toBe(1);
  }, 15_000);
});
