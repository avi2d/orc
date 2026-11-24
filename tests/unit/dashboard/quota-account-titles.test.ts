import { expect, test } from "bun:test";
import { DateTime, Effect, Layer } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import { printSessionQuotaFrame } from "@avi2dg/orc-session-quota";
import { dashboardSources, printedDashboard, recordedAnswer } from "../../lib/dashboard-sources";
import { orcQuotaText } from "../../lib/orc-quota";
import { recordedNow } from "../../lib/session-fixture";

test("names the matching Claude account in both frames, not the next dispatch pick", async () => {
  const asked: Array<string> = [];
  const sources = dashboardSources({
    run: (command) => {
      const argv = command.argv.join(" ");
      if (argv === "orc quota --json") {
        asked.push(argv);
        return Effect.succeed(orcQuotaText("main-second"));
      }
      return Effect.succeed(recordedAnswer(command));
    },
  });
  const frameOf = <E>(print: Effect.Effect<void, E>): Promise<string> =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(recordedNow));
        yield* print;
        return (yield* TestConsole.logLines).map(String).join("\n");
      }).pipe(Effect.provide(Layer.mergeAll(TestConsole.layer, TestClock.layer()))),
    );
  const session = await frameOf(printSessionQuotaFrame(84).pipe(Effect.provide(sources)));
  expect(asked.splice(0)).toEqual(["orc quota --json"]);
  expect(session).toContain("● claude second");
  expect(session).not.toContain("claude main");

  const dashboard = await frameOf(printedDashboard({ width: 240, height: 60, color: false }, sources));
  expect(asked).toEqual(["orc quota --json"]);
  expect(dashboard).toContain("● claude second");
  expect(dashboard).toContain("● account main · next run");
  expect(dashboard).toContain("● account second");
  expect(dashboard).toContain("over its share of claude second's week");
  expect(dashboard).not.toContain("claude main");
});
