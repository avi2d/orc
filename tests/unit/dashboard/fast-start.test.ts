import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Effect } from "effect";
import { flowLimitMillis } from "../../lib/budgets";
import { dashboardSources, recordedAnswer, tasksCommand, withLivePanel } from "../../lib/dashboard-sources";
import { withTestClock } from "../../lib/test-clock";

const hangingQuotaSources = dashboardSources({
  run: (command) =>
    command.argv[0] === "quota-axi" ? Effect.never : Effect.sync(() => recordedAnswer(command)),
});

const hangingCommands = ["herdr agent list", "sh -c for d in /proc", 'sh -c set -e; printf "pagesize', "systemctl --user list-timers"];

const hangingStagesSources = dashboardSources({
  run: (command) => {
    const answer = recordedAnswer(command);
    return hangingCommands.some((prefix) => command.argv.join(" ").startsWith(prefix)) ? Effect.never : Effect.succeed(answer);
  },
});

const remoteResourcesCommand = "ssh south.example.com orc-dash-resources --json";

const hangingSouthSources = dashboardSources({
  env: { ORC_DASH_MACHINE: "north", ORC_DASH_REMOTE_MACHINE: "south", ORC_DASH_REMOTE_RESOURCES: remoteResourcesCommand },
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
        const frame = await setup.frameWhere((text) => /local +cpu/u.test(text) && text.includes("ledger"));
        expect(performance.now() - started).toBeLessThan(flowLimitMillis);
        expect(frame).toContain("reading the ledger\u2026");
        expect(frame).not.toContain("no messages today");
      }),
    15_000,
  );

  test(
    "paints the queues box while the quota read is still in flight",
    () =>
      withLivePanel({ width: 84, height: 24 }, hangingQuotaSources, async (setup) => {
        const frame = await setup.frameWhere((text) => text.includes("2 running") && !text.includes("\u25cf"));
        expect(frame).toContain("queue");
      }),
    15_000,
  );

  test(
    "paints the machine and the queues within a second while the agents, the task processes and the schedules are still in flight",
    () =>
      withLivePanel({ width: 84, height: 24 }, hangingStagesSources, async (setup) => {
        const started = performance.now();
        await setup.frameWhere((text) => text.includes("machine  cpu") && text.includes("queue    local \u00b7 2 running"));
        expect(performance.now() - started).toBeLessThan(1_000);
      }),
    15_000,
  );

  test(
    "paints this machine's cpu within a second while the other machine's resources are still in flight",
    // The quota can land before this machine's cpu, and in 24 rows its accounts leave the machines box no row for south.
    () =>
      withLivePanel({ width: 84, height: 40 }, hangingSouthSources, async (setup) => {
        const started = performance.now();
        const frame = await setup.frameWhere((text) => /north +cpu/u.test(text));
        expect(performance.now() - started).toBeLessThan(1_000);
        expect(frame).toMatch(/south +reading…/u);
      }),
    15_000,
  );
});

const hangingAgentsSources = dashboardSources({
  run: (command) => (command.argv.join(" ").startsWith("herdr agent list") ? Effect.never : Effect.sync(() => recordedAnswer(command))),
});

const hangingSources = dashboardSources({ env: { ORC_DASH_TASKS: tasksCommand }, run: () => Effect.never, conversation: { read: () => Effect.never } });

const readingLines = ["reading the quota\u2026", "reading the agents\u2026", "reading the machines\u2026", "reading the tasks\u2026", "reading pueue\u2026"];

describe("the live dashboard's panes while their first read is in flight", () => {
  test("paint every box saying it is reading within the one second flow limit, and still say so three seconds on", () =>
    withTestClock((clock) =>
      withLivePanel({ width: 240, height: 60 }, hangingSources, async (setup) => {
        const started = performance.now();
        const first = await setup.frameWhere((text) => text.trim() !== "");
        expect(performance.now() - started).toBeLessThan(flowLimitMillis);
        for (const line of readingLines) expect(first).toContain(line);
        await Promise.all([setup.nextFrame(), Effect.runPromise(clock.adjust("3 seconds"))]);
        const later = await setup.frameWhere(() => true);
        for (const line of readingLines) expect(later).toContain(line);
      }, clock)), 15_000);

  test("say each reading section on its own row, and never name those sections on the shared reading line", () =>
    withLivePanel({ width: 160, height: 30 }, hangingSources, async (setup) => {
      const glance = await setup.frameWhere((text) => text.includes("reading the agents\u2026"));
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
      const glance = await setup.frameWhere((text) => /south +reading\u2026/u.test(text));
      expect(glance).toMatch(/south +reading\u2026/u);
      const named = glance
        .split("\n")
        .filter((line) => line.startsWith("reading \u00b7 "))
        .flatMap((line) => line.replace(/^reading \u00b7 /, "").split(" \u00b7 ").map((name) => name.trim()));
      expect(named).not.toContain("machines");
    }), 15_000);

  test("leave the scheduled off the shared reading line while its rows say a source is still reading", () =>
    withLivePanel({ width: 160, height: 30 }, hangingPueueSources, async (setup) => {
      const glance = await setup.frameWhere((text) => /reading the delayed jobs\u2026/u.test(text));
      expect(glance).toContain("reading the delayed jobs\u2026");
      const named = glance
        .split("\n")
        .filter((line) => line.startsWith("reading \u00b7 "))
        .flatMap((line) => line.replace(/^reading \u00b7 /, "").split(" \u00b7 ").map((name) => name.trim()));
      expect(named).not.toContain("scheduled");
    }), 15_000);

  test("say they are reading the agents in the gluttons box and in its badge under the alerts tab, never that nothing is flagged", () =>
    withLivePanel({ width: 240, height: 60 }, hangingAgentsSources, async (setup) => {
      const gluttons = await setup.frameWhere((text) => text.includes("\u25cf claude"));
      expect(gluttons).toContain("reading the agents\u2026");
      setup.mockInput.pressKey("a");
      const alerts = await setup.frameWhere((text) => text.includes("alert    quota-pace"));
      expect(alerts).toContain("gluttons: reading\u2026");
      expect(alerts).not.toContain("no flags");
    }), 15_000);
});
