import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer } from "effect";
import {
  type Command,
  CommandRunner,
  CommandUnreachable,
  NoMistakesMachines,
  noMistakesMachinesLayer,
  noMistakesRunOf,
  OrcMachines,
  orcMachinesLayer,
  type PipelineFolder,
} from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";

const harbor = "/home/example/work/harbor";

const fastStart = "/home/example/work/fast-start";

const pipelineCopy = "/home/example/.no-mistakes/worktrees/0a1b2c3d4e5f/01EXAMPLERUN";

const recorded = (asked: Array<Command>) => (command: Command): Effect.Effect<string, CommandUnreachable> => {
  asked.push(command);
  const line = command.argv.join(" ");
  if (command.cwd === pipelineCopy) return Effect.fail(new CommandUnreachable({ reason: "no-mistakes exited 1: error: repo not initialized" }));
  if (line.startsWith("no-mistakes axi status --run ")) return Effect.succeed(fixture("no-mistakes/run.txt"));
  if (line === "no-mistakes axi status" && command.cwd === fastStart) return Effect.succeed(fixture("no-mistakes/run.txt"));
  if (line === "no-mistakes axi status") return Effect.succeed(fixture("no-mistakes/overview.txt"));
  if (line === "orc runs --json") return Effect.succeed(fixture("orc/runs.json"));
  if (line.startsWith("orc show ")) return Effect.succeed(fixture("orc/show.json"));
  return Effect.fail(new CommandUnreachable({ reason: `unexpected ${line}` }));
};

const readNoMistakes = (folders: ReadonlyArray<PipelineFolder>) => {
  const asked: Array<Command> = [];
  const read = Effect.gen(function* () {
    const machines = yield* NoMistakesMachines;
    return yield* machines[0]?.read(folders) ?? Effect.die("no machine");
  }).pipe(Effect.provide(noMistakesMachinesLayer.pipe(Layer.provide(Layer.succeed(CommandRunner, { run: recorded(asked) })))));
  return Effect.runPromise(Effect.map(read, (reading) => ({ reading, asked })));
};

const readOrc = (folders: ReadonlyArray<PipelineFolder>) => {
  const asked: Array<Command> = [];
  const read = Effect.gen(function* () {
    const machines = yield* OrcMachines;
    return yield* machines[0]?.read(folders) ?? Effect.die("no machine");
  }).pipe(Effect.provide(orcMachinesLayer.pipe(Layer.provide(Layer.succeed(CommandRunner, { run: recorded(asked) })))));
  return Effect.runPromise(Effect.map(read, (reading) => ({ reading, asked })));
};

describe("no-mistakes reads the runs open tasks work on", () => {
  test("the overview runs in the task's folder and the branch's newest run reads by id", async () => {
    const { reading, asked } = await readNoMistakes([{ folder: harbor, branches: ["fm/tui-dash-projects-hide-done"] }]);
    expect(asked.map((command) => [command.argv.join(" "), command.cwd])).toEqual([
      ["no-mistakes axi status", harbor],
      ["no-mistakes axi status --run 01M5CSJ295YDZNJ7FDQXB0RN1M", undefined],
    ]);
    expect(valueOf(reading).find((run) => run.branch === "fm/tui-dash-fast-start")?.steps).toHaveLength(9);
  });

  test("the detail stands in for its step-less overview row", async () => {
    const { reading } = await readNoMistakes([{ folder: harbor, branches: ["fm/tui-dash-fast-start"] }]);
    const runs = valueOf(reading).filter((run) => run.id === "01M5CFR1F0AA7A1FF8AM4DYM9V");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.steps.map((step) => step.step)).toEqual(["intent", "rebase", "review", "test", "document", "lint", "push", "pr", "ci"]);
  });

  test("no open task asks for nothing and runs nothing", async () => {
    const { reading, asked } = await readNoMistakes([]);
    expect(valueOf(reading)).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("a folder the tool cannot read is named when no folder reads", async () => {
    const { reading } = await readNoMistakes([{ folder: pipelineCopy, branches: ["fm/x"] }]);
    expect(reading).toMatchObject({ kind: "unreachable", reason: "no-mistakes exited 1: error: repo not initialized" });
  });
});

describe("no-mistakes merges the folders open tasks work in", () => {
  test("a pipeline's own copy failing leaves the worktree's runs", async () => {
    const { reading } = await readNoMistakes([
      { folder: pipelineCopy, branches: ["fm/tui-dash-fast-start"] },
      { folder: harbor, branches: ["fm/tui-dash-fast-start"] },
    ]);
    expect(valueOf(reading).find((run) => run.branch === "fm/tui-dash-fast-start")?.steps).toHaveLength(9);
  });

  test("a run read in detail in its own worktree wins over the bare row another folder lists, in either order", async () => {
    const folders = [
      { folder: harbor, branches: ["fm/never-recorded"] },
      { folder: fastStart, branches: ["fm/tui-dash-fast-start"] },
    ];
    for (const ordered of [folders, folders.toReversed()]) {
      const { reading } = await readNoMistakes(ordered);
      const runs = valueOf(reading).filter((run) => run.id === "01M5CFR1F0AA7A1FF8AM4DYM9V");
      expect(runs).toHaveLength(1);
      expect(noMistakesRunOf(valueOf(reading), ["fm/tui-dash-fast-start"])?.steps).toHaveLength(9);
    }
  });
});

describe("orc reads the folders its open runs work in", () => {
  test("orc runs lists in each folder, and the branch newest run reads in detail", async () => {
    const { reading, asked } = await readOrc([{ folder: harbor, branches: ["fm/orc-step-7"] }]);
    expect(asked.map((command) => [command.argv.join(" "), command.cwd])).toEqual([
      ["orc runs --json", harbor],
      ["orc show 20261024-091523-7f3a9c --json", harbor],
    ]);
    expect(valueOf(reading).runs.map((run) => run.id)).toEqual(["20261024-091523-7f3a9c", "20261023-141007-2b8e51"]);
    expect(valueOf(reading).runs.find((run) => run.id === "20261024-091523-7f3a9c")?.stages.map((stage) => stage.name)).toEqual([
      "implement",
    ]);
    expect(valueOf(reading).runs.find((run) => run.id === "20261023-141007-2b8e51")?.stages).toEqual([]);
  });

  test("a branch the listing never names reads no detail", async () => {
    const { reading, asked } = await readOrc([{ folder: harbor, branches: ["fm/never-recorded"] }]);
    expect(asked.map((command) => [command.argv.join(" "), command.cwd])).toEqual([["orc runs --json", harbor]]);
    expect(valueOf(reading).runs.map((run) => run.stages.length)).toEqual([0, 0]);
  });

  test("a folder orc cannot read leaves the runs another folder read", async () => {
    const { reading } = await readOrc([
      { folder: pipelineCopy, branches: ["fm/orc-step-7"] },
      { folder: harbor, branches: ["fm/orc-step-7"] },
    ]);
    expect(valueOf(reading).runs.map((run) => run.id)).toEqual(["20261024-091523-7f3a9c", "20261023-141007-2b8e51"]);
  });

  test("no open orc task runs nothing", async () => {
    const { reading, asked } = await readOrc([]);
    expect(valueOf(reading).runs).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe("pipelines ride the other machine's tasks route", () => {
  const kelp = "/home/south/work/kelp";

  const env = {
    TUI_DASH_MACHINE: "north",
    TUI_DASH_REMOTE_MACHINE: "south",
    TUI_DASH_REMOTE_TASKS: "ssh -o BatchMode=yes south.example.com 'harbor-tasks --json'",
  };

  const withEnv = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provide(effect, ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)));

  const remoteRecorded = (asked: Array<Command>) => (command: Command): Effect.Effect<string, CommandUnreachable> => {
    asked.push(command);
    const line = command.argv.join(" ");
    if (line.includes("no-mistakes axi status")) return Effect.succeed(fixture("no-mistakes/overview.txt"));
    if (line.includes("orc runs --json")) return Effect.succeed(fixture("orc/runs.json"));
    if (line.includes("orc show ") && line.includes("--json")) return Effect.succeed(fixture("orc/show.json"));
    return Effect.fail(new CommandUnreachable({ reason: `unexpected ${line}` }));
  };

  const readRemoteNoMistakes = (folders: ReadonlyArray<PipelineFolder>) => {
    const asked: Array<Command> = [];
    const read = withEnv(
      Effect.gen(function* () {
        const machines = yield* NoMistakesMachines;
        return yield* machines[1]?.read(folders) ?? Effect.die("no remote machine");
      }).pipe(Effect.provide(noMistakesMachinesLayer.pipe(Layer.provide(Layer.succeed(CommandRunner, { run: remoteRecorded(asked) }))))),
    );
    return Effect.runPromise(Effect.map(read, (reading) => ({ reading, asked })));
  };

  const readRemoteOrc = (folders: ReadonlyArray<PipelineFolder>) => {
    const asked: Array<Command> = [];
    const read = withEnv(
      Effect.gen(function* () {
        const machines = yield* OrcMachines;
        return yield* machines[1]?.read(folders) ?? Effect.die("no remote machine");
      }).pipe(Effect.provide(orcMachinesLayer.pipe(Layer.provide(Layer.succeed(CommandRunner, { run: remoteRecorded(asked) }))))),
    );
    return Effect.runPromise(Effect.map(read, (reading) => ({ reading, asked })));
  };

  test("the other machine's no-mistakes status runs in its folder over ssh", async () => {
    const { reading, asked } = await readRemoteNoMistakes([{ folder: kelp, branches: [] }]);
    expect(asked.map((command) => command.argv)).toEqual([
      ["sh", "-c", String.raw`ssh -o BatchMode=yes south.example.com 'cd '\''/home/south/work/kelp'\'' && no-mistakes axi status'`],
    ]);
    expect(valueOf(reading).map((run) => run.id)).toContain("01M5CSJ295YDZNJ7FDQXB0RN1M");
  });

  test("the other machine's orc runs list in its folder over ssh", async () => {
    const { reading, asked } = await readRemoteOrc([{ folder: kelp, branches: [] }]);
    expect(asked.map((command) => command.argv)).toEqual([
      ["sh", "-c", String.raw`ssh -o BatchMode=yes south.example.com 'cd '\''/home/south/work/kelp'\'' && orc runs --json'`],
    ]);
    expect(valueOf(reading).runs.map((run) => run.id)).toEqual(["20261024-091523-7f3a9c", "20261023-141007-2b8e51"]);
  });

  test("the other machine's orc run detail reads by the listing's id over ssh", async () => {
    const { reading, asked } = await readRemoteOrc([{ folder: kelp, branches: ["fm/orc-step-7"] }]);
    expect(asked.map((command) => command.argv)).toEqual([
      ["sh", "-c", String.raw`ssh -o BatchMode=yes south.example.com 'cd '\''/home/south/work/kelp'\'' && orc runs --json'`],
      ["sh", "-c", String.raw`ssh -o BatchMode=yes south.example.com 'cd '\''/home/south/work/kelp'\'' && orc show '\''20261024-091523-7f3a9c'\'' --json'`],
    ]);
    expect(valueOf(reading).runs.find((run) => run.id === "20261024-091523-7f3a9c")?.stages.map((stage) => stage.name)).toEqual([
      "implement",
    ]);
  });

  test("no remote tasks route leaves this machine's pipelines alone", async () => {
    const names = await Effect.runPromise(
      Effect.gen(function* () {
        const mistakes = yield* NoMistakesMachines;
        const orcs = yield* OrcMachines;
        return [...mistakes.map((machine) => machine.name), ...orcs.map((machine) => machine.name)];
      }).pipe(
        Effect.provide(
          Layer.mergeAll(noMistakesMachinesLayer, orcMachinesLayer).pipe(
            Layer.provide(Layer.succeed(CommandRunner, { run: () => Effect.die("no command runs") })),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
          ),
        ),
      ),
    );
    expect(names).toEqual(["local", "local"]);
  });
});
