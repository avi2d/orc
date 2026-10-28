import { describe, expect, test } from "bun:test";
import { ConfigProvider, DateTime, Duration, Effect, Layer, Schema } from "effect";
import {
  type Command,
  CommandRunner,
  CommandUnreachable,
  decodeTasksReport,
  TasksMachines,
  tasksMachinesLayer,
  TasksReport,
  tasksReport,
} from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { issueOf, valueOf } from "../../lib/outcomes";

const report = () => fixture("tasks/east.json");

const recordedIds = ["tasks-bridge-plot", "tasks-inbox-sweep", "tasks-release-notes"];

const typedTasks = (): TasksReport["tasks"] => Schema.decodeUnknownSync(TasksReport)(JSON.parse(report())).tasks;

const printed = (edit: (report: TasksReport) => unknown): string =>
  JSON.stringify(edit(Schema.decodeUnknownSync(TasksReport)(JSON.parse(report()))));

const at = (iso: string) => DateTime.makeUnsafe(iso);

describe("the tasks report reader, fields kept in place and instants read as instants", () => {
  test("reads every field of the recorded report", () => {
    const { generatedAt, view } = valueOf(decodeTasksReport(report()));
    expect(DateTime.formatIso(generatedAt)).toBe("2026-10-19T08:02:11.000Z");
    expect(view.orchestrator).toEqual({ name: "harbor", version: "0.9.0" });
    expect(view.tasks).toEqual([
      {
        id: "tasks-bridge-plot",
        title: "Plot the bridge migration",
        project: "harbor",
        kind: "build",
        state: "working",
        detail: "Moving the bridge queue to the new runner",
        startedAt: at("2026-10-19T07:41:00.000Z"),
        firstStartedAt: at("2026-10-18T22:15:00.000Z"),
        endedAt: null,
        folders: ["/home/example/work/harbor", "/home/example/.no-mistakes/worktrees/a1b2c3/run-7"],
        branches: ["feature/bridge-runner", "feature/bridge-runner-ci"],
      },
      {
        id: "tasks-inbox-sweep",
        title: "Sweep the inbox",
        project: "harbor",
        kind: "review",
        state: "waiting",
        detail: "Waiting on the nightly digest",
        startedAt: at("2026-10-19T06:00:00.000Z"),
        firstStartedAt: at("2026-10-19T06:00:00.000Z"),
        endedAt: null,
        folders: ["/home/example/work/harbor"],
        branches: [],
      },
      {
        id: "tasks-release-notes",
        title: "Draft the release notes",
        project: "notes",
        kind: "docs",
        state: "done",
        detail: "Notes for the 0.9.0 release",
        startedAt: at("2026-10-18T09:00:00.000Z"),
        firstStartedAt: at("2026-10-18T09:00:00.000Z"),
        endedAt: at("2026-10-18T15:30:00.000Z"),
        folders: ["/home/example/work/notes"],
        branches: ["release/0.9.0"],
      },
    ]);
    expect(view.overhead).toEqual([{ name: "supervisor", folders: ["/home/example/harbor"] }]);
    expect(view.schedules).toEqual([
      { name: "inbox sweep returns", at: at("2026-10-20T06:00:00.000Z"), detail: "The sweep returns to the queue at dawn" },
    ]);
  });

  test("keeps the first launch beside the relaunch start, not only the relaunch time", () => {
    const tasks = valueOf(decodeTasksReport(report())).view.tasks;
    if (tasks.length < 1) throw new Error("the fixture lost its first task");
    const [bridge] = tasks;
    expect(DateTime.formatIso(bridge.firstStartedAt)).toBe("2026-10-18T22:15:00.000Z");
    expect(DateTime.formatIso(bridge.startedAt)).toBe("2026-10-19T07:41:00.000Z");
    expect(DateTime.formatIso(bridge.firstStartedAt) < DateTime.formatIso(bridge.startedAt)).toBe(true);
  });

  test("reads the registered projects, and a report without them reads none", () => {
    const named = printed((parsed) => ({ ...parsed, projects: ["harbor", "notes", "harbor", "skills"] }));
    expect(valueOf(decodeTasksReport(named)).view.registered).toEqual(["harbor", "notes", "skills"]);
    expect(valueOf(decodeTasksReport(report())).view.registered).toEqual([]);
    expect(tasksReport(valueOf(decodeTasksReport(named))).projects).toEqual(["harbor", "notes", "skills"]);
    expect(tasksReport(valueOf(decodeTasksReport(report())))).not.toHaveProperty("projects");
  });

  test("refuses another schema version", () => {
    expect(issueOf(decodeTasksReport(printed((parsed) => ({ ...parsed, schemaVersion: 2 }))))).toContain("schemaVersion");
  });

  test("refuses a state outside the five the contract names", () => {
    const tasks = typedTasks().map((task, index) => (index === 0 ? { ...task, state: "flying" } : task));
    expect(decodeTasksReport(printed((parsed) => ({ ...parsed, tasks }))).kind).toBe("invalid");
  });

  test("refuses a task whose state and end disagree", () => {
    const unended = typedTasks().map((task) => (task.state === "done" ? { ...task, endedAt: null } : task));
    expect(issueOf(decodeTasksReport(printed((parsed) => ({ ...parsed, tasks: unended }))))).toBe(
      "task tasks-release-notes is done but has no endedAt",
    );
    const ended = typedTasks().map((task) => (task.state === "working" ? { ...task, endedAt: "2026-10-18T15:30:00.000Z" } : task));
    expect(issueOf(decodeTasksReport(printed((parsed) => ({ ...parsed, tasks: ended }))))).toBe(
      "task tasks-bridge-plot is working but has an endedAt",
    );
  });

  test("refuses an instant it cannot read", () => {
    expect(issueOf(decodeTasksReport(printed((parsed) => ({ ...parsed, generatedAt: "at dawn" }))))).toBe(
      "generatedAt is not an instant",
    );
    const tasks = typedTasks().map((task, index) => (index === 0 ? { ...task, startedAt: "at dawn" } : task));
    const unreadable = printed((parsed) => ({ ...parsed, tasks }));
    expect(issueOf(decodeTasksReport(unreadable))).toBe("task tasks-bridge-plot startedAt is not an instant");
  });

  test("refuses a login banner before the report", () => {
    expect(issueOf(decodeTasksReport("Welcome to east\n" + report()))).toBe("the output is not JSON");
  });
});

const machinesWith = (env: Record<string, string>, answer: (command: Command) => Effect.Effect<string, CommandUnreachable>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const machines = yield* TasksMachines;
      const readings = yield* Effect.forEach(machines, (machine) => machine.read);
      return { names: machines.map((machine) => machine.name), readings };
    }).pipe(
      Effect.provide(
        tasksMachinesLayer.pipe(
          Layer.provide(Layer.succeed(CommandRunner, { run: answer })),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
        ),
      ),
    ),
  );

const localCommand = "harbor-tasks --json";

const remoteCommand = "ssh -o BatchMode=yes south.example.com 'harbor-tasks --json'";

describe("the tasks command source, run through the shell with a time limit", () => {
  test("reads no tasks when no command is configured", async () => {
    const found = await machinesWith({}, () => Effect.die("no command runs"));
    expect(found).toEqual({ names: [], readings: [] });
  });

  test("treats a blank command as none", async () => {
    const found = await machinesWith({ TUI_DASH_TASKS: "  ", TUI_DASH_REMOTE_TASKS: "" }, () =>
      Effect.die("no command runs"),
    );
    expect(found).toEqual({ names: [], readings: [] });
  });

  test("runs the local command through the shell and reads its report", async () => {
    const asked: Array<Command> = [];
    const found = await machinesWith({ TUI_DASH_MACHINE: "north", TUI_DASH_TASKS: localCommand }, (command) => {
      asked.push(command);
      return Effect.succeed(report());
    });
    expect(asked.map(({ argv }) => argv)).toEqual([["sh", "-c", localCommand]]);
    expect(Duration.toSeconds(asked[0]?.timeout ?? Duration.zero)).toBe(15);
    expect(found.names).toEqual(["north"]);
    const reading = valueOf(found.readings[0] ?? { kind: "invalid", issue: "no reading" });
    expect(reading.view.tasks.map((task) => task.id)).toEqual(recordedIds);
  });

  test("reads the other machine beside this one under its own name", async () => {
    const asked: Array<Command> = [];
    const found = await machinesWith(
      { TUI_DASH_MACHINE: "north", TUI_DASH_TASKS: localCommand, TUI_DASH_REMOTE_MACHINE: "south", TUI_DASH_REMOTE_TASKS: remoteCommand },
      (command) => {
        asked.push(command);
        return Effect.succeed(report());
      },
    );
    expect(asked.map(({ argv }) => argv)).toEqual([
      ["sh", "-c", localCommand],
      ["sh", "-c", remoteCommand],
    ]);
    expect(found.names).toEqual(["north", "south"]);
    expect(found.readings.map((reading) => reading.kind)).toEqual(["ok", "ok"]);
  });

  test("reports the command failure as the machine's", async () => {
    const found = await machinesWith({ TUI_DASH_TASKS: localCommand }, () =>
      Effect.fail(new CommandUnreachable({ reason: "sh exited 127: harbor-tasks: command not found" })),
    );
    expect(found.names).toEqual(["local"]);
    const [failure] = found.readings;
    expect(failure.kind).toBe("unreachable");
    if (failure.kind === "unreachable") expect(failure.reason).toBe("sh exited 127: harbor-tasks: command not found");
  });
});
