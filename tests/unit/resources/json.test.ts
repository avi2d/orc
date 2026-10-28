import { describe, expect, test } from "bun:test";
import { ConfigProvider, Duration, Effect, Layer, Schema } from "effect";
import { TestConsole } from "effect/testing";
import {
  type Command,
  CommandRunner,
  CommandUnreachable,
  decodeResourcesReport,
  gpuSourceLayer,
  linuxDiskSourceLayer,
  linuxHostSourceLayer,
  linuxProcessesSourceLayer,
  linuxTaskProcessesSourceLayer,
  localTasksLayer,
  macDiskSourceLayer,
  macHostSourceLayer,
  macProcessesSourceLayer,
  macTaskProcessesSourceLayer,
} from "@tui-dash/schema";
import { printResourcesJson } from "@tui-dash/resources";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";

const tasksCommand = "harbor-tasks --json";

const recordedAnswers: ReadonlyArray<readonly [string, string]> = [
  ["sysctl -n", fixture("mac/sysctl.txt")],
  ["vm_stat", fixture("mac/vm_stat.txt")],
  ["top -l", fixture("mac/top.txt")],
  ["ps -A", fixture("mac/ps.txt")],
  ["zsh -c", fixture("mac/task-processes.txt")],
  ["cat /proc/loadavg", fixture("linux/loadavg.txt")],
  ["getconf _NPROCESSORS_ONLN", fixture("linux/nprocessors-onln.txt")],
  ["cat /proc/meminfo", fixture("linux/meminfo.txt")],
  ["df -kP /", fixture("linux/df.txt")],
  ["sh -c df -kP", fixture("mac/df.txt")],
  ["sh -c head -n 1", fixture("linux/stat.txt")],
  ["sh -c sample()", fixture("linux/proc-stat-cmdline.txt")],
  ['sh -c set -e; printf "pagesize', fixture("linux/task-processes.txt")],
  ["nvidia-smi --query-gpu", fixture("linux/gpu.csv")],
  ["nvidia-smi --query-compute-apps", fixture("linux/gpu-apps.csv")],
];

interface Printed {
  readonly report: string;
  readonly asked: ReadonlyArray<string>;
  readonly millisAllowed: ReadonlyMap<string, number>;
}

const recordedTasks = () =>
  process.platform === "darwin"
    ? fixture("tasks/east.json").replaceAll("/home/example", "/Users/example")
    : fixture("tasks/east.json");

const printed = async (
  env: Readonly<Record<string, string>>,
  tasksAnswer: Effect.Effect<string, CommandUnreachable> = Effect.succeed(recordedTasks()),
): Promise<Printed> => {
  const asked: Array<string> = [];
  const millisAllowed = new Map<string, number>();
  const runner = Layer.succeed(CommandRunner, {
    run: (command: Command) => {
      const line = command.argv.join(" ");
      asked.push(line);
      millisAllowed.set(line, Duration.toMillis(command.timeout));
      if (line === "sh -c " + tasksCommand) return tasksAnswer;
      return Effect.succeed(recordedAnswers.find(([prefix]) => line.startsWith(prefix))?.[1] ?? "");
    },
  });
  const sources = Layer.mergeAll(
    macHostSourceLayer,
    macProcessesSourceLayer,
    macDiskSourceLayer,
    linuxHostSourceLayer,
    linuxProcessesSourceLayer,
    linuxDiskSourceLayer,
    gpuSourceLayer,
    process.platform === "darwin" ? macTaskProcessesSourceLayer : linuxTaskProcessesSourceLayer,
    localTasksLayer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))),
  ).pipe(Layer.provide(runner));
  const report = await Effect.runPromise(
    Effect.gen(function* () {
      yield* printResourcesJson;
      return (yield* TestConsole.logLines).map(String).join("\n");
    }).pipe(Effect.provide(Layer.merge(sources, TestConsole.layer))),
  );
  return { report, asked, millisAllowed };
};

const sampler = process.platform === "darwin" ? "zsh -c" : 'sh -c set -e; printf "pagesize';

// Oracle: the brief, with no tasks command configured the block is absent and everything else still runs,
// and the recorded tasks report joined to the recorded listing gives the three tasks in its order.
// Rejects a report that prints an empty block or runs the sampler with no tasks command, and one whose tasks failure spoils the machine.
describe("the resources report's tasks block", () => {
  test("is absent with no tasks command, and neither the tasks command nor the sampler runs", async () => {
    const { report, asked } = await printed({});
    expect(Object.keys(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(JSON.parse(report)))).toEqual(["schemaVersion", "generatedAt", "machine", "gpu"]);
    expect(asked.filter((line) => line.startsWith(sampler) || line.includes(tasksCommand))).toEqual([]);
  });

  test("holds each task's processes from the configured command and this machine's listing", async () => {
    const { report, asked } = await printed({ TUI_DASH_TASKS: tasksCommand });
    const { tasks, view } = valueOf(decodeResourcesReport(report));
    expect(view.machine.cpu.kind).toBe("ok");
    expect(valueOf(tasks ?? { kind: "invalid", issue: "no block" }).map(({ id, processes }) => [id, processes])).toEqual([
      ["tasks-bridge-plot", 5],
      ["tasks-inbox-sweep", 1],
      ["tasks-release-notes", 1],
    ]);
    expect(asked).toContain("sh -c " + tasksCommand);
  });

  // Oracle: the other machine's report gets 15 seconds, ssh and bun start included, and 5 is set for each read
  // the tasks block waits on. Rejects the tasks command keeping the 15 seconds the tasks panel gives it.
  test("gives the tasks command and the process listing 5 seconds each, so their timeout lands in the block", async () => {
    const { millisAllowed } = await printed({ TUI_DASH_TASKS: tasksCommand });
    const sampled = [...millisAllowed].find(([line]) => line.startsWith(sampler));
    expect(millisAllowed.get("sh -c " + tasksCommand)).toBe(5000);
    expect(sampled?.[1]).toBe(5000);
  });

  test("carries the tasks command's failure while the machine still reads", async () => {
    const { report } = await printed(
      { TUI_DASH_TASKS: tasksCommand },
      Effect.fail(new CommandUnreachable({ reason: "sh exited 127: harbor-tasks: command not found" })),
    );
    const { tasks, view } = valueOf(decodeResourcesReport(report));
    expect(tasks).toEqual({ kind: "unreachable", reason: "sh exited 127: harbor-tasks: command not found" });
    expect(view.machine.cpu.kind).toBe("ok");
    expect(view.machine.processes.kind).toBe("ok");
  });
});
