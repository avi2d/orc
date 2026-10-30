import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { TestConsole } from "effect/testing";
import { dashboardSources, printedDashboard, recordedAnswer, tasksCommand } from "../../lib/dashboard-sources";
import { lateQuotaOrTasks, lateRead, startOrderProbe, startedBesideOthers } from "../../lib/late-quota-tasks";

// Host load makes elapsed-time thresholds unreliable for checking concurrency.
describe("the dashboard --print frame", () => {
  test(
    "reads the session quota beside the tasks report",
    async () => {
      const probe = startOrderProbe();
      const sources = dashboardSources({
        env: { TUI_DASH_TASKS: tasksCommand },
        run: (command) =>
          lateQuotaOrTasks(command.argv, tasksCommand)
            ? lateRead(command.argv, Effect.sync(() => recordedAnswer(command)), probe)
            : Effect.sync(() => recordedAnswer(command)),
      });
      await Effect.runPromise(printedDashboard({ width: 84, height: 30, color: false }, sources).pipe(Effect.provide(TestConsole.layer)));
      expect(startedBesideOthers(probe.events)).toBe(true);
    },
    15_000,
  );
});

// Host load makes elapsed-time thresholds unreliable for checking concurrency.
describe("the dashboard --print frame without session-quota", () => {
  test(
    "reads the session quota beside the tasks report",
    async () => {
      const probe = startOrderProbe();
      const sources = dashboardSources({
        env: { TUI_DASH_TASKS: tasksCommand },
        config: join(import.meta.dir, "..", "..", "fixtures", "config", "tasks-only.json"),
        run: (command) =>
          lateQuotaOrTasks(command.argv, tasksCommand)
            ? lateRead(command.argv, Effect.sync(() => recordedAnswer(command)), probe)
            : Effect.sync(() => recordedAnswer(command)),
      });
      await Effect.runPromise(printedDashboard({ width: 84, height: 30, color: false }, sources).pipe(Effect.provide(TestConsole.layer)));
      expect(startedBesideOthers(probe.events)).toBe(true);
    },
    15_000,
  );
});
