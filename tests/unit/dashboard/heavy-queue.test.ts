import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import { CommandUnreachable } from "@avi2dg/orc-schema";
import { dashboardSources, printedDashboard, recordedAnswer } from "../../lib/dashboard-sources";
import { fixture } from "../../lib/fixtures";
import { boxText } from "../../lib/host-fixture";

const remoteHeavyCommand = "ssh south.example.com orc heavy check --json";

const remotePueueCommand = "ssh south.example.com pueue status --json";

const remoteResourcesCommand = "ssh south.example.com orc-dash-resources --json";

const printedAt = "2026-11-10T09:00:00.000Z";

const southAnswer = (command: string): Effect.Effect<string, CommandUnreachable> | undefined => {
  if (command === remoteHeavyCommand) return Effect.fail(new CommandUnreachable({ reason: southBeforeFirstRun }));
  if (command === remotePueueCommand) return Effect.succeed(fixture("pueue/status.json"));
  if (command === remoteResourcesCommand) return Effect.succeed(fixture("resources/south.json").replace("2026-10-13T20:18:10.000Z", printedAt));
  return undefined;
};

const southBeforeFirstRun = "sh exited 1: orc: heavy check: the heavy group is missing, run orc heavy path to create it";

const printedTwoMachines = (): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(printedAt)));
      yield* printedDashboard(
        { width: 200, height: 70, color: false },
        dashboardSources({
          env: {
            ORC_DASH_MACHINE: "north",
            ORC_DASH_REMOTE_MACHINE: "south",
            ORC_DASH_REMOTE_HEAVY: remoteHeavyCommand,
            ORC_DASH_REMOTE_PUEUE: remotePueueCommand,
            ORC_DASH_REMOTE_RESOURCES: remoteResourcesCommand,
          },
          run: (command) => southAnswer(command.argv[2]) ?? Effect.succeed(recordedAnswer(command)),
        }),
      );
      return (yield* TestConsole.logLines).map(String).join("\n");
    }).pipe(Effect.provide(Layer.mergeAll(TestConsole.layer, TestClock.layer()))),
  );

const rowsOf = (box: string): ReadonlyArray<string> => box.split("\n").map((row) => row.slice(2, -1).trimEnd());

describe("the heavy queue on a dashboard with two machines", () => {
  test("gives each machine its own heavy line in the queue box rather than one machine's depth for both", async () => {
    const rows = rowsOf(boxText(await printedTwoMachines(), "queue | scheduled"));
    expect(rows).toContain("heavy north 1/1 running \u00b7 2 queued, oldest 9m \u00b7 2 bypasses this week");
    expect(rows.find((row) => row.startsWith("heavy south"))).toBe("heavy south queue not set up");
  }, 30_000);

  test("puts each machine's heavy check under that machine in the machines box rather than under the other", async () => {
    const rows = rowsOf(boxText(await printedTwoMachines(), "machines"));
    const north = rows.findIndex((row) => row.startsWith("north "));
    const south = rows.findIndex((row) => row.startsWith("south "));
    expect(rows[north + 1]).toBe("  heavy 1/1 running \u00b7 2 queued, oldest 9m \u00b7 2 bypasses this week");
    expect(rows.slice(south + 1).join(" ").replaceAll(/\s+/gu, " ")).toContain("heavy queue not set up");
    expect(rows.slice(south + 1).join(" ")).not.toContain("1/1 running");
  }, 30_000);
});
