import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { ConfigProvider, DateTime, Effect, Layer } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import { printAlertsFrame } from "@tui-dash/alerts";
import { escape, stripSgr } from "../../e2e/lib/print-color";
import { recordedSettings } from "../../lib/alerts-fixture";

const alertFixtures = join(import.meta.dir, "..", "..", "fixtures", "alerts");

const printed = (color: boolean): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-19T19:20:00Z")));
      yield* printAlertsFrame(recordedSettings(), 84, Number.POSITIVE_INFINITY, color);
      return (yield* TestConsole.logLines).map(String).join("\n");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunFileSystem.layer,
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              HOME: "/home/tester",
              TUI_DASH_ALERTS_VERDICTS: join(alertFixtures, "verdicts.jsonl"),
            }),
          ),
          TestConsole.layer,
          TestClock.layer(),
        ),
      ),
    ),
  );

// Oracle: the title in packages/alerts/src/panels.ts paints the panel name in bold foreground, and the palette holds
// foreground at #d3d8e1. Rejects a colour frame that maps the title to another colour.
describe("the alerts --print --color frame", () => {
  test("paints the panel title in bold foreground", async () => {
    expect(await printed(true)).toContain(`${escape}[38;2;211;216;225;1malerts`);
  });

  test("carries no visible text the plain frame does not carry, which itself carries no escape", async () => {
    const plain = await printed(false);
    expect(plain).not.toContain(escape);
    expect(stripSgr(await printed(true))).toBe(plain);
  });
});
