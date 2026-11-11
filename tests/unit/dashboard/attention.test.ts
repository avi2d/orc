import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { TestConsole } from "effect/testing";
import { dashboardSources, printedDashboard, recordedAnswer } from "../../lib/dashboard-sources";

// The dashboard reads the orc attention call's fixed answer, so the frame shows the same items the panel does.
const printed = (width: number, height: number): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* printedDashboard({ width, height, color: false }, dashboardSources({ env: {}, run: (command) => Effect.succeed(recordedAnswer(command)) }));
      return (yield* TestConsole.logLines).map(String).join("\n");
    }).pipe(Effect.provide(TestConsole.layer)),
  );

describe("the dashboard's attention queue", () => {
  test("shows the open items and the overdue mark on a wide screen by default, with no layout setting", async () => {
    const frame = await printed(120, 40);
    expect(frame).toContain("3 open \u00b7 1 overdue");
    expect(frame).toContain("! orc-1 \u00b7 user \u00b7 10m overdue");
    expect(frame).toContain("\u00b7 orc-4 \u00b7 user \u00b7 2m");
  });

  test("shows the open and overdue counts in the narrow glance by default", async () => {
    const frame = await printed(84, 24);
    expect(frame).toContain("attention 3 open");
    expect(frame).toContain("1 overdue");
  });
});
