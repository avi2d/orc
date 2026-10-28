import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, DateTime, Effect, Layer } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import {
  CommandRunner,
  herdrSourceLayer,
  linuxHarnessProcessSourceLayer,
  quotaSourceLayer,
  sessionMachinesLayer,
} from "@tui-dash/schema";
import { harvestLogSourceLive, printSessionQuotaFrame, sessionLogSourceLive } from "@tui-dash/session-quota";
import { fixture } from "../../lib/fixtures";
import { copyFixtureHome, recordedNow } from "../../lib/session-fixture";
import { escape, stripSgr } from "../../e2e/lib/print-color";
import { isSavedProfilesCall, recordedSavedProfilesLayer } from "../../lib/saved-profiles";

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tui-dash-session-quota-color-"));
  copyFixtureHome(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const atHome = (text: string): string => text.replaceAll("/home/tester", home);

const printed = (color: boolean): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(recordedNow));
      yield* printSessionQuotaFrame(84, Number.POSITIVE_INFINITY, color);
      return (yield* TestConsole.logLines).map(String).join("\n");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mergeAll(quotaSourceLayer, recordedSavedProfilesLayer, herdrSourceLayer, linuxHarnessProcessSourceLayer, sessionMachinesLayer).pipe(
            Layer.provide(
              Layer.succeed(CommandRunner, {
                run: (command) => {
                  if (command.argv[0] === "quota-axi") return Effect.succeed(fixture("quota-axi/full.json"));
                  if (isSavedProfilesCall(command)) return Effect.succeed(fixture("saved-profiles/status.json"));
                  if (command.argv[0] === "herdr") return Effect.succeed(atHome(fixture("session-logs/herdr-agents.json")));
                  return Effect.succeed(atHome(fixture("session-logs/harness-processes.txt")));
                },
              }),
            ),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
          ),
          Layer.merge(sessionLogSourceLive, harvestLogSourceLive).pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: home }))),
          ),
          TestConsole.layer,
          TestClock.layer(),
        ),
      ),
    ),
  );

describe("the session quota --print --color frame", () => {
  test("paints the caption promise in muted #969aa3", async () => {
    expect(await printed(true)).toContain(`${escape}[38;2;150;154;163mestimates from`);
  });

  test("carries no visible text the plain frame does not carry, which itself carries no escape", async () => {
    const plain = await printed(false);
    expect(plain).not.toContain(escape);
    expect(stripSgr(await printed(true))).toBe(plain);
  });
});
