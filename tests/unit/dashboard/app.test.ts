import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Effect, Fiber } from "effect";
import { fixture } from "../../lib/fixtures";
import { dashboardSources, frameWhere, liveDashboard, recordedAnswer, tasksCommand } from "../../lib/dashboard-sources";
import { machineStdout } from "../../lib/machines-fixture";

const remoteCommand = "ssh south.example.com tui-dash-session-quota --json";

const remotePueueCommand = "ssh south.example.com pueue status --json";

const remoteResourcesCommand = "ssh south.example.com tui-dash-resources --json";

const remoteTasksCommand = "ssh south.example.com tasks-report --json";

const hasTasks = (value: unknown): value is { readonly tasks: ReadonlyArray<Record<string, unknown>> } =>
  typeof value === "object" &&
  value !== null &&
  "tasks" in value &&
  Array.isArray(value.tasks) &&
  value.tasks.every((task): task is Record<string, unknown> => typeof task === "object" && task !== null);

// The south report's timestamps move to now, so its tasks stay inside the levels' last 7 days however old the fixture grows.
const southTasksNow = (): string => {
  const parsed: unknown = JSON.parse(fixture("tasks/south.json"));
  if (!hasTasks(parsed)) throw new Error("the south fixture holds no tasks");
  const report = parsed;
  const now = new Date().toISOString();
  return JSON.stringify({
    ...report,
    generatedAt: now,
    tasks: report.tasks.map((task) => ({ ...task, startedAt: now, firstStartedAt: now, endedAt: task["endedAt"] === null ? null : now })),
  });
};

const southResourcesNow = () => fixture("resources/south.json").replace("2026-10-13T20:18:10.000Z", new Date().toISOString());

interface Remote {
  readonly env: Record<string, string>;
  readonly stdout: () => string;
  readonly pueue?: Effect.Effect<string>;
}

const recordedSourcesWith = (herdrAnswer: Effect.Effect<void>, remote: Remote) =>
  dashboardSources({
    env: remote.env,
    run: (command) => {
      if (command.argv[2] === remoteCommand) return Effect.sync(remote.stdout);
      if (command.argv[2] === remotePueueCommand) return remote.pueue ?? Effect.succeed("");
      if (command.argv[2] === remoteResourcesCommand) return Effect.sync(southResourcesNow);
      if (command.argv[2] === remoteTasksCommand) return Effect.sync(southTasksNow);
      const answer = recordedAnswer(command);
      return command.argv[0] === "herdr" ? Effect.as(herdrAnswer, answer) : Effect.succeed(answer);
    },
  });

const recordedSourcesHoldingHerdr = (herdrAnswer: Effect.Effect<void>) =>
  recordedSourcesWith(herdrAnswer, { env: {}, stdout: () => "" });

const recordedSources = recordedSourcesHoldingHerdr(Effect.void);

const southNow = () => machineStdout("south", (report) => ({ ...report, generatedAt: new Date().toISOString() }));

const twoMachineSources = recordedSourcesWith(Effect.void, {
  env: {
    TUI_DASH_MACHINE: "north",
    TUI_DASH_REMOTE_MACHINE: "south",
    TUI_DASH_REMOTE_SESSION_QUOTA: remoteCommand,
    TUI_DASH_REMOTE_RESOURCES: remoteResourcesCommand,
  },
  stdout: southNow,
});

const rowsOf = (frame: string) =>
  frame
    .split("\n")
    .map((row) => row.trimEnd())
    .filter((row) => row !== "");

describe("the live dashboard", () => {
  test("names or counts every account, and shows the agents, the queues and a row per alert rule on one screen in a standard 84x24 terminal, in that order", async () => {
    const setup = await createTestRenderer({ width: 84, height: 24 });
    const fiber = Effect.runFork(liveDashboard(setup.renderer, recordedSources));
    try {
      const standard = rowsOf(await frameWhere(setup, (frame) => frame.includes("\u25cf") && frame.includes("no agent flagged") && frame.includes("nightly")));
      for (const header of ["\u25cf claude main", "\u25cf codex", "\u25cf opencode-go"]) {
        expect(standard.some((row) => row.startsWith(header))).toBe(true);
      }
      expect(standard.some((row) => row.startsWith("\u25cf claude second")) || standard.includes("+1 more claude profiles")).toBe(true);
      expect(standard).toContain("queue    local \u00b7 2 running \u00b7 2 queued \u00b7 1 paused \u00b7 gpu group paused");
      expect(standard).toContain("actions  toolshed \u00b7 2 running \u00b7 1 waiting");
      expect(standard).toContain("+2 more rows");
      expect(standard[0]).toStartWith("\u25cf claude main");
      const alerts = standard.indexOf("alerts");
      expect(alerts).toBeGreaterThan(standard.findIndex((row) => row.startsWith("actions")));
      expect(standard.slice(alerts + 1).map((row) => row.split(" ")[0])).toEqual(["quota-pace", "heavy-load", "long-task", "nightly"]);
      expect(standard[alerts + 1]).toBe("quota-pace none recorded");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  });

  test("paints the settings file's limits and the verdict log's fires below the machine in a tall terminal", async () => {
    const setup = await createTestRenderer({ width: 84, height: 60 });
    const fiber = Effect.runFork(liveDashboard(setup.renderer, recordedSources));
    try {
      const rows = rowsOf(await frameWhere(setup, (frame) => frame.includes("alert    long-task")));
      expect(rows.indexOf("alert    quota-pace")).toBeGreaterThan(rows.findIndex((row) => row.startsWith("machine  cpu")));
      expect(rows).toContain("limits   north load ≥ 10 or memory used ≥ 90% · south load ≥ 16 or memory free < 15%");
      expect(rows).toContain("limits   quiet 20m, then every 10m · past 3h in total");
      expect(rows).toContain("verdict  expected, a nightly baseline runs on south");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  }, 15_000);

  test("names the remote machine's flagged agent with its machine when a remote is configured", async () => {
    const setup = await createTestRenderer({ width: 84, height: 40 });
    const fiber = Effect.runFork(liveDashboard(setup.renderer, twoMachineSources));
    try {
      const frame = await frameWhere(setup, (text) => text.includes("\u2691 api on south"));
      expect(rowsOf(frame)).toContain("\u2691 api on south is spending over its share of claude work's week");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  }, 15_000);

  test("paints while the other machine's pueue has not answered, then paints its queue once it does", async () => {
    const { promise: remoteHeld, resolve: answerRemote } = Promise.withResolvers<void>();
    const setup = await createTestRenderer({ width: 84, height: 30 });
    const held = recordedSourcesWith(Effect.void, {
      env: { TUI_DASH_MACHINE: "north", TUI_DASH_REMOTE_MACHINE: "south", TUI_DASH_REMOTE_PUEUE: remotePueueCommand },
      stdout: () => "",
      pueue: Effect.promise(() => remoteHeld).pipe(Effect.as(fixture("pueue/status.json"))),
    });
    const fiber = Effect.runFork(liveDashboard(setup.renderer, held));
    try {
      const first = rowsOf(await frameWhere(setup, (frame) => frame.includes("queue    north")));
      expect(first).toContain("queue    north \u00b7 2 running \u00b7 2 queued \u00b7 1 paused \u00b7 gpu group paused");
      expect(first).toContain("         south \u00b7 reading\u2026");
      answerRemote();
      const read = rowsOf(await frameWhere(setup, (frame) => !frame.includes("reading\u2026")));
      expect(read).toContain("         south \u00b7 2 running \u00b7 2 queued \u00b7 1 paused \u00b7 gpu group paused");
    } finally {
      answerRemote();
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  }, 15_000);

  test("states each machine by its name, the remote machine's gpu under it, when a remote is configured", async () => {
    const setup = await createTestRenderer({ width: 84, height: 40 });
    const fiber = Effect.runFork(liveDashboard(setup.renderer, twoMachineSources));
    const northRow = process.platform === "darwin" ? "north    cpu 14% \u00b7 memory 8.4G of 32.0G" : "north    cpu 11% \u00b7 memory 5.5G of 31.3G";
    try {
      const rows = rowsOf(await frameWhere(setup, (text) => text.includes("south    cpu")));
      const north = rows.indexOf(northRow);
      const south = rows.indexOf("south    cpu 42% \u00b7 memory 12.0G of 64.0G");
      expect(north).toBeGreaterThan(-1);
      expect(south).toBeGreaterThan(north);
      expect(rows[south + 1]).toBe("gpu      NVIDIA GeForce RTX 4090 \u00b7 63% \u00b7 memory 8.0G of 24.0G");
      expect(rows.some((row) => row.startsWith("machine "))).toBe(false);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  }, 15_000);

  test("paints the agents line as soon as a first session read that outlasted its patience lands", async () => {
    const { promise: herdrHeld, resolve: releaseHerdr } = Promise.withResolvers<void>();
    const setup = await createTestRenderer({ width: 84, height: 24 });
    const held = recordedSourcesHoldingHerdr(Effect.promise(() => herdrHeld));
    const fiber = Effect.runFork(liveDashboard(setup.renderer, held));
    try {
      await frameWhere(setup, (frame) => frame.includes("reading the agents\u2026"));
      releaseHerdr();
      const read = await frameWhere(setup, (frame) => !frame.includes("reading the agents\u2026"));
      expect(read).toContain("no agent flagged for spending a limit too fast");
    } finally {
      releaseHerdr();
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  }, 15_000);

  test("interrupts a first session read still in flight when the quit key is pressed", async () => {
    let herdrInterrupted = false;
    const herdrNever = Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => (herdrInterrupted = true))));
    const setup = await createTestRenderer({ width: 84, height: 24 });
    const fiber = Effect.runFork(liveDashboard(setup.renderer, recordedSourcesHoldingHerdr(herdrNever)));
    try {
      await frameWhere(setup, (frame) => frame.includes("\u25cf claude main") && frame.includes("reading the agents…"));
      setup.renderer.keyInput.processParsedKey({
        name: "q",
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        sequence: "q",
        number: false,
        raw: "q",
        eventType: "press",
        source: "raw",
      });
      await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("5 seconds")));
      expect(herdrInterrupted).toBe(true);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  }, 15_000);

  test("ends the program when the quit key is pressed", async () => {
    const setup = await createTestRenderer({ width: 84, height: 24 });
    const fiber = Effect.runFork(liveDashboard(setup.renderer, recordedSources));
    try {
      await frameWhere(setup, (frame) => frame.includes("\u25cf"));
      setup.renderer.keyInput.processParsedKey({
        name: "q",
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        sequence: "q",
        number: false,
        raw: "q",
        eventType: "press",
        source: "raw",
      });
      await Effect.runPromise(Fiber.join(fiber).pipe(Effect.timeout("5 seconds")));
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  });
});

const leveledSources = recordedSourcesWith(Effect.void, {
  env: {
    TUI_DASH_MACHINE: "north",
    TUI_DASH_REMOTE_MACHINE: "south",
    TUI_DASH_REMOTE_RESOURCES: remoteResourcesCommand,
    TUI_DASH_TASKS: tasksCommand,
  },
  stdout: southNow,
});

const remoteLeveledSources = recordedSourcesWith(Effect.void, {
  env: {
    TUI_DASH_MACHINE: "north",
    TUI_DASH_REMOTE_MACHINE: "south",
    TUI_DASH_REMOTE_RESOURCES: remoteResourcesCommand,
    TUI_DASH_TASKS: tasksCommand,
    TUI_DASH_REMOTE_TASKS: remoteTasksCommand,
  },
  stdout: southNow,
});

const topLineOf = (frame: string): string => (frame.split("\n").at(0) ?? "").trimEnd();

describe("the live dashboard's levels", () => {
  test("open from the glance in a standard 84x24 terminal and close back to it", async () => {
    const setup = await createTestRenderer({ width: 84, height: 24 });
    const fiber = Effect.runFork(liveDashboard(setup.renderer, leveledSources));
    try {
      await frameWhere(setup, (frame) => frame.includes("quota-pace"));
      setup.mockInput.pressArrow("down");
      setup.mockInput.pressEnter();
      const projects = await frameWhere(setup, (frame) => frame.includes("projects · today"));
      expect(projects).toContain("harbor");
      expect(projects).toContain("projects · today");
      setup.mockInput.pressEscape();
      await frameWhere(setup, (frame) => frame.includes("quota-pace") && !frame.includes("projects · today"));
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  });

  test("step into the unified projects and back out on a 240x60 screen", async () => {
    const setup = await createTestRenderer({ width: 240, height: 60 });
    const fiber = Effect.runFork(liveDashboard(setup.renderer, leveledSources));
    try {
      const first = await frameWhere(setup, (frame) => frame.includes("projects · today") && frame.includes("harbor") && frame.includes("south"));
      expect(topLineOf(first)).toMatch(/╭─ quota ─+ ↻ 10s ─╮/u);
      expect(first).toContain("scheduled");
      expect(first).not.toContain("┏");
      expect(first).not.toContain("kelp");
      setup.mockInput.pressArrow("down");
      setup.mockInput.pressArrow("up");
      setup.mockInput.pressEnter();
      setup.mockInput.pressEnter();
      await frameWhere(setup, (frame) => frame.includes("harbor · tasks"));
      setup.mockInput.pressEscape();
      await frameWhere(setup, (frame) => frame.includes("projects · today"));
      setup.mockInput.pressEscape();
      await frameWhere(setup, (frame) => frame.includes("projects · today") && frame.includes("harbor"));
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  });

  test("switch the shared boxes' titles on s, u, a and g", async () => {
    const setup = await createTestRenderer({ width: 240, height: 60 });
    const fiber = Effect.runFork(liveDashboard(setup.renderer, leveledSources));
    try {
      await frameWhere(setup, (frame) => frame.includes("queued in pueue") && frame.includes("over its share"));
      setup.mockInput.pressKey("a");
      await frameWhere(setup, (frame) => frame.includes("quota-pace"));
      setup.mockInput.pressKey("s");
      await frameWhere(setup, (frame) => frame.includes("nothing scheduled") && !frame.includes("queued in pueue"));
      setup.mockInput.pressKey("u");
      await frameWhere(setup, (frame) => frame.includes("queued in pueue"));
      setup.mockInput.pressKey("g");
      await frameWhere(setup, (frame) => !frame.includes("quota-pace"));
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  });

  test("step into the other machine's kelp on the unified board on a 240x60 screen", async () => {
    const setup = await createTestRenderer({ width: 240, height: 60 });
    const fiber = Effect.runFork(liveDashboard(setup.renderer, remoteLeveledSources));
    try {
      await frameWhere(setup, (frame) => frame.includes("projects · today") && frame.includes("harbor") && frame.includes("kelp"));
      setup.mockInput.pressArrow("down");
      setup.mockInput.pressEnter();
      setup.mockInput.pressEnter();
      const kelp = await frameWhere(setup, (frame) => frame.includes("kelp · tasks"));
      expect(kelp).toContain("tasks-kelp-tend");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await setup.dispose();
    }
  });
});
