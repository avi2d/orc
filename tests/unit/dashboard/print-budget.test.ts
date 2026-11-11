import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { TestConsole } from "effect/testing";
import { modules } from "@avi2dg/orc-cli";
import { flowLimitMillis, slowReadMillis } from "../../lib/budgets";
import { dashboardSources, printedDashboard, printedPanel, tasksCommand } from "../../lib/dashboard-sources";
import { writeDispatchBacklog } from "../../lib/dispatch-fixture";
import { realSizeAnswer } from "../../lib/real-size";
import { spentOn } from "../../lib/spent";

const frame = { width: 120, height: 40, color: false };

type Sources = ReturnType<typeof dashboardSources>;

const millisOf = async <E>(printed: (sources: Sources) => Effect.Effect<void, E>): Promise<number> => {
  const root = await mkdtemp(join(tmpdir(), "orc-print-budget-"));
  try {
    await writeDispatchBacklog(join(root, "backlog"));
    const spent = await spentOn((fileSystem) =>
      Effect.provide(
        Effect.orDie(
          printed(
            dashboardSources({
              env: { ORC_DASH_TASKS: tasksCommand, ORC_HOME: root },
              run: (command) => Effect.delay(Effect.sync(() => realSizeAnswer(command)), slowReadMillis),
              fileSystem,
            }),
          ),
        ),
        TestConsole.layer,
      ),
    );
    return spent.waitedMillis + spent.workedMillis;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

// Flow limit from Nielsen (1993).
const chainOf: ReadonlyMap<string, number> = new Map([
  ["quota", 1],
  ["session-quota", 1],
  ["alerts", 0],
  ["resources", 1],
  ["queues", 2],
  ["schedules", 2],
  ["dispatch", 1],
  ["attention", 1],
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
    test(`panel ${module.id} --print answers within ${budgetOf(chain)} ms, ${chain} slow reads and the flow limit, not each read after the last`, async () => {
      expect(await millisOf((sources) => printedPanel(module, frame, sources))).toBeLessThan(budgetOf(chain));
    });
  }

  const dashboardChain = Math.max(...chainOf.values());
  test(`dashboard --print answers within ${budgetOf(dashboardChain)} ms, its longest chain and the flow limit, not each panel after the last`, async () => {
    expect(await millisOf((sources) => printedDashboard(frame, sources))).toBeLessThan(budgetOf(dashboardChain));
  });
});
