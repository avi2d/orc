import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigProvider, DateTime, Effect, Layer } from "effect";
import { TestClock, TestConsole } from "effect/testing";
import { CommandRunner, quotaSourceLayer } from "@tui-dash/schema";
import { printQuotaFrame } from "@tui-dash/quota";
import { harvestLogSourceLive } from "@tui-dash/session-quota";
import { fixture } from "../../lib/fixtures";
import { claudeLogRelative, readBeforeHarvest, rolloutRelative } from "../../lib/harvest-fixture";
import { quotaAxiJsonFor } from "../../lib/quota-read";
import { recordedSavedProfilesLayer } from "../../lib/saved-profiles";

let home = "";

const place = (relative: string, text: string) => {
  const target = join(home, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tui-dash-quota-harvest-"));
  place(claudeLogRelative, fixture("harvest/claude-code.jsonl"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const recordedNow = DateTime.makeUnsafe("2026-10-13T20:18:16Z");

interface Printed {
  readonly frame: string;
  readonly quotaAxiAsked: ReadonlyArray<ReadonlyArray<string>>;
}

const printed = async (quotaJson: string, env: Readonly<Record<string, string>> = {}): Promise<Printed> => {
  const quotaAxiAsked: Array<ReadonlyArray<string>> = [];
  const frame = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(recordedNow));
      yield* printQuotaFrame(84);
      return (yield* TestConsole.logLines).map(String).join("\n");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.merge(quotaSourceLayer, recordedSavedProfilesLayer).pipe(
            Layer.provide(
              Layer.succeed(CommandRunner, {
                run: (command) => {
                  if (command.argv[0] !== "quota-axi") return Effect.succeed(fixture("saved-profiles/status.json"));
                  quotaAxiAsked.push(command.argv);
                  return Effect.succeed(quotaAxiJsonFor(command.argv, quotaJson));
                },
              }),
            ),
          ),
          harvestLogSourceLive.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ HOME: home, ...env })))),
          TestConsole.layer,
          TestClock.layer(),
        ),
      ),
    ),
  );
  return { frame, quotaAxiAsked };
};

const rowsOf = (frame: string) => frame.split("\n").map((row) => row.trimEnd());

const pinnedFrame = () => rowsOf(fixture("screens/quota-84x13.txt")).join("\n").trimEnd();

const askedEveryone = [["quota-axi", "--full", "--json", "--provider", "claude,codex,opencode-go", "--max-age", "5m"]];

// The fallback skips a provider only while a log reading younger than an hour covers it.
describe("the printed quota frame over harness logs on disk", () => {
  test("does not ask quota-axi about Codex while a rollout reading is fresh, and prints the rollout's session 82 and week 75, not quota-axi's 100 and 82", async () => {
    place(rolloutRelative, fixture("harvest/codex-rollout.jsonl"));
    const { frame, quotaAxiAsked } = await printed(readBeforeHarvest(fixture("quota-axi/full.json")));
    expect(quotaAxiAsked).toEqual([["quota-axi", "--full", "--json", "--provider", "claude,opencode-go", "--max-age", "5m"]]);
    const rows = rowsOf(frame);
    expect(rows.slice(0, 6)).toEqual([
      "● claude main · max",
      "  week from claude code log 18m ago · assumed the only login",
      "  session, fable from quota-axi 1h 18m ago",
      expect.stringMatching(/^session read 1h 18m ago$/u),
      expect.stringMatching(/^week {4}.* {3}0% {2}✗ exhausted now +2d 20h$/u),
      expect.stringMatching(/^fable +read 1h 18m ago$/u),
    ]);
    const codex = rows.indexOf("● codex");
    expect(rows.slice(codex + 1, codex + 4)).toEqual([
      "  session, week from codex rollout 38m ago · joined by credential key",
      expect.stringMatching(/^session .* 82% {2}behind pace +3h 31m$/u),
      expect.stringMatching(/^week {4}.* 75% {2}ahead of pace +6d 11h$/u),
    ]);
  });

  test("counts a harvested window reset down from now as 2d 20h not 2d 21h from an older report", async () => {
    place(rolloutRelative, fixture("harvest/codex-rollout.jsonl"));
    const olderReport = readBeforeHarvest(fixture("quota-axi/full.json")).replace(
      '"generatedAt": "2026-10-13T20:18:15.620Z"',
      '"generatedAt": "2026-10-13T19:30:00.000Z"',
    );
    const rows = rowsOf((await printed(olderReport)).frame);
    expect(rows).toContainEqual(expect.stringMatching(/^session .* 82% {2}behind pace +3h 31m$/u));
    expect(rows).toContainEqual(expect.stringMatching(/^week {4}.* {3}0% {2}✗ exhausted now +2d 20h$/u));
  });

  test("falls back to quota-axi for Codex when the rollout's newest reading is over an hour old", async () => {
    place(rolloutRelative, fixture("harvest/codex-rollout.jsonl").replaceAll("2026-10-13T19:40:00.000Z", "2026-10-13T19:15:00.000Z"));
    const { frame, quotaAxiAsked } = await printed(fixture("quota-axi/full.json"));
    expect(quotaAxiAsked).toEqual(askedEveryone);
    expect(rowsOf(frame).join("\n").trimEnd()).toBe(pinnedFrame());
  });

  // A rollout under HOME's .codex may belong to another login, so Codex reads come from CODEX_HOME.
  test("reads Codex's rollouts from CODEX_HOME, and falls back to quota-axi when only HOME's .codex holds one", async () => {
    place(rolloutRelative, fixture("harvest/codex-rollout.jsonl"));
    const elsewhere = await printed(fixture("quota-axi/full.json"), { CODEX_HOME: join(home, "work-codex") });
    expect(elsewhere.quotaAxiAsked).toEqual(askedEveryone);
    expect(rowsOf(elsewhere.frame).join("\n").trimEnd()).toBe(pinnedFrame());
    place(rolloutRelative.replace(".codex/", "work-codex/"), fixture("harvest/codex-rollout.jsonl"));
    const there = await printed(fixture("quota-axi/full.json"), { CODEX_HOME: join(home, "work-codex") });
    expect(there.quotaAxiAsked).toEqual([["quota-axi", "--full", "--json", "--provider", "claude,opencode-go", "--max-age", "5m"]]);
  });

  // A token is tied to no config folder, so no Claude Code log can speak for its account.
  test("takes no Claude reading from the logs while an OAuth token selects the Claude account", async () => {
    const { frame } = await printed(readBeforeHarvest(fixture("quota-axi/full.json")), { CLAUDE_CODE_OAUTH_TOKEN: "token" });
    const rows = rowsOf(frame);
    expect(rows.slice(0, 2)).toEqual(["● claude main · max", expect.stringMatching(/^session read 1h 18m ago$/u)]);
    expect(rows).toContainEqual(expect.stringMatching(/^week +read 1h 18m ago$/u));
  });

  test("falls back to quota-axi for Codex when no rollout is on disk", async () => {
    const { frame, quotaAxiAsked } = await printed(fixture("quota-axi/full.json"));
    expect(quotaAxiAsked).toEqual(askedEveryone);
    expect(rowsOf(frame).join("\n").trimEnd()).toBe(pinnedFrame());
  });
});
