import { describe, expect, test } from "bun:test";
import { ConfigProvider, DateTime, Effect, Layer } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import { actionsSourceLayer, CommandRunner, pueueMachinesLayer } from "@tui-dash/schema";
import { printQueuesFrame } from "@tui-dash/queues";
import { fixtureActionsRepo, queueAnswers, queuesNow } from "../../lib/queues-fixture";
import { escape, stripSgr } from "../../e2e/lib/print-color";

const recordedAnswer = (asked: string): string => queueAnswers.find(([answers]) => asked.startsWith(answers))?.[1] ?? "";

const printed = (color: boolean): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(queuesNow));
      yield* printQueuesFrame(84, Number.POSITIVE_INFINITY, color);
      return (yield* TestConsole.logLines).map(String).join("\n");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mergeAll(pueueMachinesLayer, actionsSourceLayer).pipe(
            Layer.provide(
              Layer.succeed(CommandRunner, {
                run: (command) => Effect.succeed(recordedAnswer(command.argv.join(" "))),
              }),
            ),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ TUI_DASH_MACHINE: "north", TUI_DASH_ACTIONS_REPO: fixtureActionsRepo }))),
          ),
          TestConsole.layer,
          TestClock.layer(),
        ),
      ),
    ),
  );

describe("the queues --print --color frame", () => {
  test("paints the running mark in primary", async () => {
    expect(await printed(true)).toContain(`${escape}[38;2;96;170;243m\u25b6`);
  });

  test("carries no visible text the plain frame does not carry, which itself carries no escape", async () => {
    const plain = await printed(false);
    expect(plain).not.toContain(escape);
    expect(stripSgr(await printed(true))).toBe(plain);
  });
});
