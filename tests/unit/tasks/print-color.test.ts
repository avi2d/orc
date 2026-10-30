import { describe, expect, test } from "bun:test";
import { ConfigProvider, DateTime, Effect, Layer } from "effect";
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
  sessionMachinesLayer,
  TaskSamplesSource,
  tasksMachinesLayer,
} from "@tui-dash/schema";
import { harvestLogSourceLive, sessionLogSourceLive } from "@tui-dash/session-quota";
import { printTasksFrame } from "@tui-dash/tasks";
import { fixture } from "../../lib/fixtures";
import { escape, stripSgr } from "../../e2e/lib/print-color";
import { queueAnswers } from "../../lib/queues-fixture";
import { fixtureHomeEnvironment } from "../../lib/session-fixture";
import { isSavedProfilesCall, recordedSavedProfilesLayer } from "../../lib/saved-profiles";

const tasksCommand = "tasks-report --json";

const remoteTasksCommand = "ssh south.example.com tasks-report --json";

const hasTasks = (value: unknown): value is { readonly tasks: ReadonlyArray<Record<string, unknown>> } =>
  typeof value === "object" &&
  value !== null &&
  "tasks" in value &&
  Array.isArray(value.tasks) &&
  value.tasks.every((task): task is Record<string, unknown> => typeof task === "object" && task !== null);

const screenNowIso = "2026-10-19T08:02:11Z";

const eastTasksNow = (): string => {
  const parsed: unknown = JSON.parse(fixture("tasks/east.json"));
  if (!hasTasks(parsed)) throw new Error("the east fixture holds no tasks");
  return JSON.stringify({
    ...parsed,
    generatedAt: screenNowIso,
    tasks: parsed.tasks.map((task) => ({ ...task, startedAt: screenNowIso, firstStartedAt: screenNowIso })),
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

const recordedRun = (command: Command): Effect.Effect<string> => {
  if (command.argv[0] === "quota-axi") return Effect.succeed(fixture("quota-axi/full.json"));
  if (isSavedProfilesCall(command)) return Effect.succeed(fixture("saved-profiles/status.json"));
  if (command.argv.join(" ").startsWith(`sh -c ${tasksCommand}`)) return Effect.sync(eastTasksNow);
  return Effect.succeed(recordedAnswers.find(([asked]) => command.argv.join(" ").startsWith(asked))?.[1] ?? "");
};

const recordedSources = Layer.mergeAll(
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
  Layer.merge(Layer.succeed(TaskSamplesSource, { read: () => Effect.succeed([]), append: () => Effect.void })),
  Layer.provide(Layer.succeed(CommandRunner, { run: recordedRun })),
);

const printed = (color: boolean): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(screenNowIso)));
      yield* printTasksFrame(84, 30, false, color);
      return (yield* TestConsole.logLines).map(String).join("\n");
    }).pipe(Effect.provide(Layer.mergeAll(recordedSources, TestConsole.layer, TestClock.layer()))),
  );

describe("the tasks --print --color frame", () => {
  test("paints the path in the foreground colour", async () => {
    expect(await printed(true)).toContain(`${escape}[38;2;211;216;225m projects `);
  });

  test("carries no visible text the plain frame does not carry, which itself carries no escape", async () => {
    const plain = await printed(false);
    expect(plain).not.toContain(escape);
    expect(stripSgr(await printed(true))).toBe(plain);
  });
});
