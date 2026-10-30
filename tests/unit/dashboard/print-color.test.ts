import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import { dashboardSources, printedDashboard, recordedAnswer } from "../../lib/dashboard-sources";
import { escape, stripSgr } from "../../e2e/lib/print-color";

const printed = (color: boolean): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-19T19:20:00Z")));
      yield* printedDashboard({ width: 84, height: 30, color }, dashboardSources({ env: {}, run: (command) => Effect.succeed(recordedAnswer(command)) }));
      return (yield* TestConsole.logLines).map(String).join("\n");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(TestConsole.layer, TestClock.layer()),
      ),
    ),
  );

describe("the dashboard --print --color frame", () => {
  test("paints the composed account mark in its brand tint", async () => {
    expect(await printed(true)).toContain(`${escape}[38;2;217;119;87;1m\u25cf claude`);
  });

  test("carries no visible text the plain frame does not carry, which itself carries no escape", async () => {
    const plain = await printed(false);
    expect(plain).not.toContain(escape);
    expect(stripSgr(await printed(true))).toBe(plain);
  });
});
