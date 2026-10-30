import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { TestConsole } from "effect/testing";
import { modules } from "@tui-dash/cli";
import { flowLimitMillis, slowReadMillis } from "../../lib/budgets";
import { dashboardSources, printedDashboard, printedPanel, tasksCommand } from "../../lib/dashboard-sources";
import { realSizeAnswer } from "../../lib/real-size";

const frame = { width: 120, height: 40, color: false };

const slowSources = () =>
  dashboardSources({
    env: { TUI_DASH_TASKS: tasksCommand },
    run: (command) => Effect.delay(Effect.sync(() => realSizeAnswer(command)), slowReadMillis),
  });

const millisOf = async <E>(printed: Effect.Effect<void, E>): Promise<number> => {
  const started = performance.now();
  await Effect.runPromise(Effect.orDie(printed).pipe(Effect.provide(TestConsole.layer)));
  return performance.now() - started;
};

// Flow limit from Nielsen (1993).
const chainOf: ReadonlyMap<string, number> = new Map([
  ["quota", 1],
  ["session-quota", 1],
  ["alerts", 0],
  ["resources", 1],
  ["queues", 2],
  ["schedules", 2],
  ["tasks", 3],
  ["ledger", 0],
]);

const budgetOf = (chain: number): number => chain * slowReadMillis + flowLimitMillis;

describe("a printed frame over slow real-size sources", () => {
  for (const module of modules) {
    const chain = chainOf.get(module.id);
    if (chain === undefined) {
      test(`panel ${module.id} names its chain of slow reads`, () => expect(chain).toBeDefined());
      continue;
    }
    test(
      `panel ${module.id} --print answers within ${budgetOf(chain)} ms, ${chain} slow reads and the flow limit`,
      async () => {
        expect(await millisOf(printedPanel(module, frame, slowSources()))).toBeLessThan(budgetOf(chain));
      },
      4 * budgetOf(chain) + 10_000,
    );
  }

  const dashboardChain = Math.max(...chainOf.values());
  test(
    `dashboard --print answers within ${budgetOf(dashboardChain)} ms, its longest chain and the flow limit`,
    async () => {
      expect(await millisOf(printedDashboard(frame, slowSources()))).toBeLessThan(budgetOf(dashboardChain));
    },
    4 * budgetOf(dashboardChain) + 10_000,
  );
});
