import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, DateTime, Effect, Layer } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import { CommandRunner, quotaSourceLayer } from "@tui-dash/schema";
import { printQuotaFrame } from "@tui-dash/quota";
import { harvestLogSourceLive } from "@tui-dash/session-quota";
import { fixture } from "../../lib/fixtures";
import { escape, stripSgr } from "../../e2e/lib/print-color";
import { recordedSavedProfilesLayer } from "../../lib/saved-profiles";

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tui-dash-quota-color-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const printed = (color: boolean): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-13T20:18:16Z")));
      yield* printQuotaFrame(84, Number.POSITIVE_INFINITY, color);
      return (yield* TestConsole.logLines).map(String).join("\n");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.merge(quotaSourceLayer, recordedSavedProfilesLayer).pipe(
            Layer.provide(
              Layer.succeed(CommandRunner, {
                run: (command) =>
                  Effect.succeed(command.argv[0] === "quota-axi" ? fixture("quota-axi/full.json") : fixture("saved-profiles/status.json")),
              }),
            ),
          ),
          harvestLogSourceLive.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: home })))),
          TestConsole.layer,
          TestClock.layer(),
        ),
      ),
    ),
  );

describe("the quota --print --color frame", () => {
  test("paints the account mark in palette claude brand tint", async () => {
    expect(await printed(true)).toContain(`${escape}[38;2;217;119;87;1m\u25cf claude`);
  });

  test("carries no visible text the plain frame does not carry, which itself carries no escape", async () => {
    const plain = await printed(false);
    expect(plain).not.toContain(escape);
    expect(stripSgr(await printed(true))).toBe(plain);
  });
});
