import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer } from "effect";
import { type Command, CommandRunner, decodePueue, PueueMachines, pueueMachinesLayer, projectOf, pueueView } from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { issueOf, valueOf } from "../../lib/outcomes";

const recorded = () => valueOf(decodePueue(fixture("pueue/status.json")));

describe("a recorded pueue status", () => {
  test("counts two running, two queued and one paused, with a stashed task counted as neither", () => {
    const view = pueueView(recorded());
    expect(view.running.map((run) => run.command)).toEqual(["sleep 800", "sleep 1000"]);
    expect(view.queued).toBe(2);
    expect(view.paused).toBe(1);
  });

  test("lists the ended runs newest end first, with each result", () => {
    const view = pueueView(recorded());
    expect(view.ended.map((run) => [run.id, run.result])).toEqual([
      [4, { kind: "success" }],
      [3, { kind: "killed" }],
      [9, { kind: "dependency" }],
      [2, { kind: "exit", code: 1 }],
      [1, { kind: "success" }],
      [0, { kind: "exit", code: 3 }],
    ]);
  });

  test("keeps each group's state and parallel limit", () => {
    expect(pueueView(recorded()).groups).toEqual([
      { name: "default", status: "Running", parallel: 1 },
      { name: "gpu", status: "Paused", parallel: 1 },
      { name: "tests", status: "Running", parallel: 2 },
    ]);
  });

  test("reads a task that failed to spawn with its reason", () => {
    const spawned = fixture("pueue/status.json").replace('"result": "Success"', '"result": { "FailedToSpawn": "No such file or directory" }');
    expect(pueueView(valueOf(decodePueue(spawned))).ended.find((run) => run.id === 1)?.result).toEqual({
      kind: "spawn",
      error: "No such file or directory",
    });
  });
});

describe("a task's environment", () => {
  test("is dropped from a status that decodes", () => {
    expect(fixture("pueue/status.json")).toContain("not-a-real-token");
    expect(JSON.stringify(recorded())).not.toContain("not-a-real-token");
  });

  test("is dropped before a status that does not decode is described", () => {
    const issue = issueOf(decodePueue(fixture("pueue/changed-format.json")));
    expect(issue).toContain("status");
    expect(issue).not.toContain("not-a-real-token");
  });

  test("is dropped while a group named envs is kept", () => {
    const renamed = fixture("pueue/status.json").replace('"groups": {', '"groups": { "envs": { "status": "Paused", "parallel_tasks": 2 },');
    const decoded = valueOf(decodePueue(renamed));
    expect(pueueView(decoded).groups).toContainEqual({ name: "envs", status: "Paused", parallel: 2 });
    expect(JSON.stringify(decoded)).not.toContain("not-a-real-token");
  });
});

describe("the project a task ran in: the last folder for any other path, never a pool slot number, run id or user name", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["/home/example", "~"],
    ["/Users/example", "~"],
    ["/tmp/my-example/gotmp", "my-example"],
    ["/private/tmp/my-example", "my-example"],
    ["/home/example/.treehouse/shop-0a1b2c/3/shop", "shop"],
    ["/home/example/.no-mistakes/worktrees/0a1b2c3d4e5f/01EXAMPLERUN", "unknown"],
    ["/home/example/Projects/website/", "website"],
    ["/", "/"],
  ];
  for (const [path, project] of cases) {
    test(`is ${project} for ${path}`, () => {
      expect(projectOf(path)).toBe(project);
    });
  }
});

const machinesWith = async (env: Record<string, string>) => {
  const asked: Array<Command["argv"]> = [];
  const runner = Layer.succeed(CommandRunner, {
    run: (command) => Effect.sync(() => {
      asked.push(command.argv);
      return fixture("pueue/status.json");
    }),
  });
  const machines = await Effect.runPromise(
    Effect.gen(function* () {
      const listed = yield* PueueMachines;
      const reads = yield* Effect.forEach(listed, (machine) => machine.read);
      return listed.map((machine, index) => ({ name: machine.name, kind: reads[index]?.kind }));
    }).pipe(Effect.provide(pueueMachinesLayer.pipe(Layer.provide(runner), Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))))),
  );
  return { machines, asked };
};

describe("the pueue machines", () => {
  test("are this machine alone, named local, when no remote command is set", async () => {
    const { machines, asked } = await machinesWith({});
    expect(machines).toEqual([{ name: "local", kind: "ok" }]);
    expect(asked).toEqual([["pueue", "status", "--json"]]);
  });

  test("leave out a blank remote command", async () => {
    expect((await machinesWith({ TUI_DASH_REMOTE_PUEUE: "  " })).machines).toHaveLength(1);
  });

  test("add the other machine, read through the shell, when its command is set", async () => {
    const line = "ssh south.example.com 'pueue status --json'";
    const { machines, asked } = await machinesWith({
      TUI_DASH_MACHINE: "north",
      TUI_DASH_REMOTE_MACHINE: "south",
      TUI_DASH_REMOTE_PUEUE: line,
    });
    expect(machines).toEqual([
      { name: "north", kind: "ok" },
      { name: "south", kind: "ok" },
    ]);
    expect(asked).toContainEqual(["sh", "-c", line]);
  });
});
