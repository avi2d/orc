import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Effect } from "effect";
import { flowLimitMillis } from "../../lib/budgets";
import { dashboardSources, frameWhere, recordedAnswer, tasksCommand, withLivePanel } from "../../lib/dashboard-sources";
import { fixture } from "../../lib/fixtures";

const slowQuotaSources = dashboardSources({
  run: (command) =>
    command.argv[0] === "quota-axi" ? Effect.as(Effect.sleep("2500 millis"), fixture("quota-axi/full.json")) : Effect.sync(() => recordedAnswer(command)),
});

const slowCommands = ["herdr agent list", "sh -c for d in /proc", 'sh -c set -e; printf "pagesize', "systemctl --user list-timers"];

const slowStagesSources = dashboardSources({
  run: (command) => {
    const answer = recordedAnswer(command);
    return slowCommands.some((slow) => command.argv.join(" ").startsWith(slow)) ? Effect.as(Effect.sleep("3 seconds"), answer) : Effect.succeed(answer);
  },
});

const remoteResourcesCommand = "ssh south.example.com tui-dash-resources --json";

const slowSouthSources = dashboardSources({
  env: { TUI_DASH_MACHINE: "north", TUI_DASH_REMOTE_MACHINE: "south", TUI_DASH_REMOTE_RESOURCES: remoteResourcesCommand },
  run: (command) =>
    command.argv.join(" ").includes(remoteResourcesCommand) ? Effect.as(Effect.sleep("3 seconds"), "") : Effect.sync(() => recordedAnswer(command)),
});

const hangingSouthSources = dashboardSources({
  env: { TUI_DASH_MACHINE: "north", TUI_DASH_REMOTE_MACHINE: "south", TUI_DASH_REMOTE_RESOURCES: remoteResourcesCommand },
  run: (command) => (command.argv.join(" ").includes(remoteResourcesCommand) ? Effect.never : Effect.sync(() => recordedAnswer(command))),
});

const hangingPueueSources = dashboardSources({
  config: join(import.meta.dir, "..", "..", "fixtures", "config", "schedules-narrow.json"),
  run: (command) => (command.argv[0] === "pueue" ? Effect.never : Effect.sync(() => recordedAnswer(command))),
});

const ledgerBeside = join(import.meta.dir, "..", "..", "fixtures", "config", "ledger-beside.json");

const hangingLedgerSources = dashboardSources({
  config: ledgerBeside,
  run: (command) => Effect.sync(() => recordedAnswer(command)),
  conversation: { read: () => Effect.never },
});

describe("the live dashboard's first paint", () => {
  test(
    "paints this machine and a ledger that says it is reading within the one second flow limit while the conversation read is still in flight",
    () =>
      withLivePanel({ width: 160, height: 24 }, hangingLedgerSources, async (setup) => {
        const started = performance.now();
        const frame = await frameWhere(setup, (text) => /local +cpu/u.test(text) && text.includes("ledger"));
        expect(performance.now() - started).toBeLessThan(flowLimitMillis);
        expect(frame).toContain("reading the ledger\u2026");
        expect(frame).not.toContain("no messages today");
      }),
    15_000,
  );

  test(
    "paints the queues box while the quota read is still in flight",
    () =>
      withLivePanel({ width: 84, height: 24 }, slowQuotaSources, async (setup) => {
        const frame = await frameWhere(setup, (text) => text.includes("2 running") && !text.includes("\u25cf"));
        expect(frame).toContain("queue");
      }),
    15_000,
  );

  test(
    "paints the machine and the queues within a second while the agents, the task processes and the schedules are still in flight",
    () =>
      withLivePanel({ width: 84, height: 24 }, slowStagesSources, async (setup) => {
        const started = performance.now();
        await frameWhere(setup, (text) => text.includes("machine  cpu") && text.includes("queue    local \u00b7 2 running"));
        expect(performance.now() - started).toBeLessThan(1_000);
      }),
    15_000,
  );

  test(
    "paints this machine's cpu within a second while the other machine's resources are still in flight",
    () =>
      withLivePanel({ width: 84, height: 24 }, slowSouthSources, async (setup) => {
        const started = performance.now();
        const frame = await frameWhere(setup, (text) => /north +cpu/u.test(text));
        expect(performance.now() - started).toBeLessThan(1_000);
        expect(frame).toMatch(/south +reading…/u);
      }),
    15_000,
  );
});

const hangingAgentsSources = dashboardSources({
  run: (command) => (command.argv.join(" ").startsWith("herdr agent list") ? Effect.never : Effect.sync(() => recordedAnswer(command))),
});

const hangingSources = dashboardSources({ env: { TUI_DASH_TASKS: tasksCommand }, run: () => Effect.never, conversation: { read: () => Effect.never } });

const readingLines = ["reading the quota\u2026", "reading the agents\u2026", "reading the machines\u2026", "reading the tasks\u2026", "reading pueue\u2026"];

describe("the live dashboard's panes while their first read is in flight", () => {
  test("paint every box saying it is reading within the one second flow limit, and still say so three seconds on", () =>
    withLivePanel({ width: 240, height: 60 }, hangingSources, async (setup) => {
      const started = performance.now();
      const first = await frameWhere(setup, (text) => text.trim() !== "");
      expect(performance.now() - started).toBeLessThan(flowLimitMillis);
      for (const line of readingLines) expect(first).toContain(line);
      await Bun.sleep(3_000);
      const later = await frameWhere(setup, () => true);
      for (const line of readingLines) expect(later).toContain(line);
    }), 15_000);

  test("say each reading section on its own row, and never name those sections on the shared reading line", () =>
    withLivePanel({ width: 160, height: 30 }, hangingSources, async (setup) => {
      const glance = await frameWhere(setup, (text) => text.includes("reading the agents\u2026"));
      expect(glance).toContain("reading the quota\u2026");
      expect(glance).toContain("reading the machines\u2026");
      const named = glance
        .split("\n")
        .filter((line) => line.startsWith("reading \u00b7 "))
        .flatMap((line) => line.replace(/^reading \u00b7 /, "").split(" \u00b7 ").map((name) => name.trim()));
      expect(named).not.toContain("queue");
      expect(named).not.toContain("quota");
      expect(named).not.toContain("gluttons");
      expect(named).not.toContain("machines");
    }), 15_000);

  test("leave the machines off the shared reading line while one machine row says it is reading", () =>
    withLivePanel({ width: 160, height: 30 }, hangingSouthSources, async (setup) => {
      const glance = await frameWhere(setup, (text) => /south +reading\u2026/u.test(text));
      expect(glance).toMatch(/south +reading\u2026/u);
      const named = glance
        .split("\n")
        .filter((line) => line.startsWith("reading \u00b7 "))
        .flatMap((line) => line.replace(/^reading \u00b7 /, "").split(" \u00b7 ").map((name) => name.trim()));
      expect(named).not.toContain("machines");
    }), 15_000);

  test("leave the scheduled off the shared reading line while its rows say a source is still reading", () =>
    withLivePanel({ width: 160, height: 30 }, hangingPueueSources, async (setup) => {
      const glance = await frameWhere(setup, (text) => /reading the delayed jobs\u2026/u.test(text));
      expect(glance).toContain("reading the delayed jobs\u2026");
      const named = glance
        .split("\n")
        .filter((line) => line.startsWith("reading \u00b7 "))
        .flatMap((line) => line.replace(/^reading \u00b7 /, "").split(" \u00b7 ").map((name) => name.trim()));
      expect(named).not.toContain("scheduled");
    }), 15_000);

  test("say they are reading the agents in the gluttons box and in its badge under the alerts tab, never that nothing is flagged", () =>
    withLivePanel({ width: 240, height: 60 }, hangingAgentsSources, async (setup) => {
      const gluttons = await frameWhere(setup, (text) => text.includes("\u25cf claude main"));
      expect(gluttons).toContain("reading the agents\u2026");
      setup.mockInput.pressKey("a");
      const alerts = await frameWhere(setup, (text) => text.includes("alert    quota-pace"));
      expect(alerts).toContain("gluttons: reading\u2026");
      expect(alerts).not.toContain("no flags");
    }), 15_000);
});
