import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import {
  countedCalls,
  decodeSavedProfiles,
  decodeQuota,
  type HarvestedReading,
  harvestedReadings,
  type LogFile,
  logRecords,
  type Outcome,
  type QuotaBlock,
  type QuotaRead,
  type QuotaReport,
  type QuotaWindow,
  quotaBlocks,
  type SourcedWindow,
} from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { quotaAxiRead, recordedQuotaRead } from "../../lib/quota-read";
import {
  claudeLogFile as claudeLog,
  claudeLogPath as claudePath,
  readBeforeHarvest as readEarlier,
  rolloutFile as rollout,
  rolloutPath,
} from "../../lib/harvest-fixture";

const at = (iso: string): number => Date.parse(iso);

describe("harvestedReadings from a Codex rollout, used_percent read as used, the newest base snapshot kept and the named extra limit kept out", () => {
  test("keeps the newest base snapshot of each window, as what is left", () => {
    expect(harvestedReadings([rollout()])).toEqual([
      {
        provider: "codex",
        harness: "codex",
        via: "log",
        credentialKey: "codex-home",
        windowId: "five_hour",
        cycleSeconds: 18_000,
        percentRemaining: 81.5,
        resetsAt: at("2026-10-13T23:50:00Z"),
        observedAt: at("2026-10-13T19:40:00Z"),
        file: rolloutPath,
      },
      {
        provider: "codex",
        harness: "codex",
        via: "log",
        credentialKey: "codex-home",
        windowId: "weekly",
        cycleSeconds: 604_800,
        percentRemaining: 75,
        resetsAt: at("2026-10-20T08:08:56Z"),
        observedAt: at("2026-10-13T19:40:00Z"),
        file: rolloutPath,
      },
    ]);
  });

  test("names a window of any other length the way quota-axi does, not every other window the same and hours unrounded", () => {
    const snapshot = (minutes: ReadonlyArray<number>) =>
      JSON.stringify({
        timestamp: "2026-10-13T19:50:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: null,
          rate_limits: {
            limit_id: "codex",
            limit_name: null,
            primary: { used_percent: 10, window_minutes: minutes[0], resets_at: 1_791_935_400 },
            secondary: { used_percent: 20, window_minutes: minutes[1], resets_at: 1_791_935_400 },
            credits: null,
            plan_type: "plus",
          },
        },
      });
    const readings = harvestedReadings([rollout([snapshot([1440, 90]), snapshot([100, 10_080])].join("\n"))]);
    expect(readings.map((reading) => reading.windowId)).toEqual(["window:24h", "window:1.5h", "window:1.67h", "weekly"]);
  });

  test("keeps the newest reading of a window whatever order the rollouts are read in", () => {
    const older = { ...rollout(fixture("harvest/codex-rollout.jsonl").replaceAll("2026-10-13T19:40:00.000Z", "2026-10-13T19:20:00.000Z")), path: "/home/tester/older.jsonl" };
    expect(harvestedReadings([rollout(), older]).map((reading) => [reading.percentRemaining, reading.file])).toEqual([
      [81.5, rolloutPath],
      [75, rolloutPath],
    ]);
  });

  test("leaves the calls the rollout counts unchanged", () => {
    const stripped = fixture("harvest/codex-rollout.jsonl").replaceAll(/"rate_limits":\{.*?\}\}\}/gu, '"rate_limits":null}}');
    expect(stripped).not.toContain("used_percent");
    expect(countedCalls([rollout()]).calls).toEqual(countedCalls([rollout(stripped)]).calls);
    expect(countedCalls([rollout()]).calls).toHaveLength(3);
  });
});

describe("harvestedReadings from Claude Code logs, an allowed warning is no exhaustion and a rejection keeps its zero-usage lines", () => {
  test("reads each rejected window as nothing left, until its reset", () => {
    expect(harvestedReadings([claudeLog()])).toEqual([
      {
        provider: "claude",
        harness: "claude-code",
        via: "log",
        credentialKey: undefined,
        windowId: "five_hour",
        cycleSeconds: 18_000,
        percentRemaining: 0,
        resetsAt: at("2026-10-13T16:00:00Z"),
        observedAt: at("2026-10-13T12:00:00Z"),
        file: claudePath,
      },
      {
        provider: "claude",
        harness: "claude-code",
        via: "log",
        credentialKey: undefined,
        windowId: "seven_day",
        cycleSeconds: 604_800,
        percentRemaining: 0,
        resetsAt: at("2026-10-16T17:00:00Z"),
        observedAt: at("2026-10-13T20:00:00Z"),
        file: claudePath,
      },
    ]);
  });

  test("still counts the real call between the rejections, once", () => {
    const ledger = countedCalls([claudeLog()]);
    expect(ledger.calls.map((call) => call.tokens)).toEqual([{ input: 10, output: 400, cacheRead: 30000, cacheWrite: 2000 }]);
    expect(ledger.emptyRowsDropped).toBe(3);
  });
});

const recordedNow = DateTime.makeUnsafe("2026-10-13T20:18:16Z");

const fullReport = (text = fixture("quota-axi/full.json")) => ({ ...decodeQuota(text), capturedAt: recordedNow });

const savedProfiles = () => ({ ...decodeSavedProfiles(fixture("saved-profiles/status.json")), capturedAt: recordedNow });

const windowsOf = (blocks: ReadonlyArray<QuotaBlock>, title: string): ReadonlyArray<SourcedWindow> => {
  const body = blocks.find((block) => block.title === title)?.body;
  return body?.kind === "live" ? body.windows : [];
};

const harvest = () => harvestedReadings([rollout(), claudeLog()]);

const summary = (window: SourcedWindow) => ({
  id: window.id,
  left: "percentRemaining" in window ? window.percentRemaining : undefined,
  source: window.source.kind,
});

// quota-axi was asked about every provider here, as it is whenever no log reading covers one.
describe("quotaBlocks with harvested readings", () => {
  test("keeps quota-axi's window, and says so, when its read is newer than every harvested reading", () => {
    const blocks = quotaBlocks(quotaAxiRead(fullReport(), harvest()), savedProfiles(), recordedNow);
    expect(windowsOf(blocks, "codex").map(summary)).toEqual([
      { id: "five_hour", left: 100, source: "quota-axi" },
      { id: "weekly", left: 82, source: "quota-axi" },
    ]);
    expect(windowsOf(blocks, "codex")[0]?.source).toEqual({
      kind: "quota-axi",
      readAt: DateTime.makeUnsafe("2026-10-13T20:18:15.337Z"),
    });
    expect(windowsOf(blocks, "claude main").map(summary)).toEqual([
      { id: "five_hour", left: 98, source: "quota-axi" },
      { id: "seven_day", left: 31, source: "quota-axi" },
      { id: "model:fable", left: 100, source: "quota-axi" },
    ]);
  });

  test("takes the newer Codex rollout reading, joined by the rollout's own credential key", () => {
    const blocks = quotaBlocks(quotaAxiRead(fullReport(readEarlier(fixture("quota-axi/full.json"))), harvest()), savedProfiles(), recordedNow);
    expect(windowsOf(blocks, "codex").map(summary)).toEqual([
      { id: "five_hour", left: 81.5, source: "harvested" },
      { id: "weekly", left: 75, source: "harvested" },
    ]);
    expect(windowsOf(blocks, "codex")[0]?.source).toEqual({
      kind: "harvested",
      harness: "codex",
      via: "log",
      observedAt: DateTime.makeUnsafe("2026-10-13T19:40:00Z"),
      file: rolloutPath,
      join: { kind: "credential-key", key: "codex-home" },
    });
  });

  test("paces a harvested window against its own reading the way quota-axi paces one, not with quota-axi's pace from its older reading", () => {
    const blocks = quotaBlocks(quotaAxiRead(fullReport(readEarlier(fixture("quota-axi/full.json"))), harvest()), savedProfiles(), recordedNow);
    const [fiveHour, week] = windowsOf(blocks, "codex");
    expect(fiveHour.pace?.status).toBe("behind");
    expect(fiveHour.pace?.timeRemainingPercent).toBeCloseTo(70.5778, 4);
    expect(week.pace?.status).toBe("ahead");
    expect(week.pace?.timeRemainingPercent).toBeCloseTo(92.7646, 4);
    expect(week.pace?.reservePercentPoints).toBeCloseTo(75 - 92.7646, 4);
    expect(week.pace?.projectedExhaustedAt).toBeUndefined();
  });

  test("takes a newer Claude rejection for its week as an assumption, and ignores one whose window has since reset", () => {
    const blocks = quotaBlocks(quotaAxiRead(fullReport(readEarlier(fixture("quota-axi/full.json"))), harvest()), savedProfiles(), recordedNow);
    expect(windowsOf(blocks, "claude main").map(summary)).toEqual([
      { id: "five_hour", left: 98, source: "quota-axi" },
      { id: "seven_day", left: 0, source: "harvested" },
      { id: "model:fable", left: 100, source: "quota-axi" },
    ]);
    const week = windowsOf(blocks, "claude main")[1];
    expect(week.source.kind === "harvested" ? week.source.join : undefined).toEqual({ kind: "only-account" });
  });
});

const sixNow = DateTime.makeUnsafe("2026-10-16T19:30:00Z");

const codexHomeReading: HarvestedReading = {
  provider: "codex",
  harness: "codex",
  via: "log",
  credentialKey: "codex-home",
  windowId: "weekly",
  cycleSeconds: 604_800,
  percentRemaining: 40,
  resetsAt: at("2026-10-22T08:24:11Z"),
  observedAt: at("2026-10-16T19:29:00Z"),
  file: rolloutPath,
};

const sixBlocks = (text: string) =>
  quotaBlocks(quotaAxiRead({ ...decodeQuota(text), capturedAt: sixNow }, [codexHomeReading]), savedProfiles(), sixNow);

describe("the account a harvested reading joins, against the recorded replays, never the other Codex account or an only or default account", () => {
  test("lands a rollout reading on the codex-home account and leaves the Pi Codex key's account alone", () => {
    const blocks = sixBlocks(fixture("quota-axi/schema-6.json"));
    expect(windowsOf(blocks, "codex codex-home").map(summary)).toEqual([
      { id: "five_hour", left: 100, source: "quota-axi" },
      { id: "weekly", left: 40, source: "harvested" },
    ]);
    expect(windowsOf(blocks, "codex openai-codex").map(summary)).toEqual([
      { id: "five_hour", left: 29, source: "quota-axi" },
      { id: "weekly", left: 20, source: "quota-axi" },
    ]);
  });

  // The recording's only Codex account renamed to a Pi key, so an assumed only-account join would take the reading.
  test("joins no account, not even the only one, when no account holds the rollout's credential key", () => {
    const piKeyed = readEarlier(fixture("quota-axi/full.json")).replace('"codex-home"', '"openai-codex"');
    const blocks = quotaBlocks(quotaAxiRead(fullReport(piKeyed), harvest()), savedProfiles(), recordedNow);
    expect(windowsOf(blocks, "codex").map(summary)).toEqual([
      { id: "five_hour", left: 100, source: "quota-axi" },
      { id: "weekly", left: 82, source: "quota-axi" },
    ]);
  });
});

// One Codex five-hour reading at 20:10, after quota-axi's moved 19:30 read, for the window resetting 23:50.
const codexFiveHour = (percentRemaining: number): HarvestedReading => ({
  provider: "codex",
  harness: "codex",
  via: "log",
  credentialKey: "codex-home",
  windowId: "five_hour",
  cycleSeconds: 18_000,
  percentRemaining,
  resetsAt: at("2026-10-13T23:50:00Z"),
  observedAt: at("2026-10-13T20:10:00Z"),
  file: rolloutPath,
});

const earlierBlocks = (readings: ReadonlyArray<HarvestedReading>) =>
  quotaBlocks(quotaAxiRead(fullReport(readEarlier(fixture("quota-axi/full.json"))), readings), savedProfiles(), recordedNow);

const unpaced = (window: QuotaWindow): QuotaWindow => {
  const { pace, ...rest } = window;
  return rest;
};

const withProviders = (
  report: Outcome<QuotaReport>,
  edit: (providers: QuotaReport["providers"]) => QuotaReport["providers"],
): Outcome<QuotaReport> => (report.kind === "ok" ? { ...report, value: { ...report.value, providers: edit(report.value.providers) } } : report);

describe("the edges of a harvested window", () => {
  test("reads a reserve within quota-axi's one point deadband as on pace", () => {
    const [fiveHour] = windowsOf(earlierBlocks([codexFiveHour(71)]), "codex");
    expect(fiveHour.pace?.status).toBe("on_pace");
    expect(fiveHour.pace?.reservePercentPoints).toBeCloseTo(71 - 70.5778, 4);
  });

  test("ignores a reading newer than quota-axi's read once its window has reset", () => {
    const reset: HarvestedReading = {
      provider: "claude",
      harness: "claude-code",
      via: "log",
      credentialKey: undefined,
      windowId: "five_hour",
      cycleSeconds: 18_000,
      percentRemaining: 0,
      resetsAt: at("2026-10-13T20:00:00Z"),
      observedAt: at("2026-10-13T19:30:00Z"),
      file: claudePath,
    };
    expect(windowsOf(earlierBlocks([reset]), "claude main").map(summary)[0]).toEqual({
      id: "five_hour",
      left: 98,
      source: "quota-axi",
    });
  });

  test("paces a harvested window on its own cycle where quota-axi gave its window no pace", () => {
    const report = withProviders(decodeQuota(readEarlier(fixture("quota-axi/full.json"))), (providers) =>
      providers.map((entry) =>
        entry.provider !== "codex" || "kind" in entry
          ? entry
          : { ...entry, windows: entry.windows.map((window) => (window.id === "five_hour" ? unpaced(window) : window)) },
      ),
    );
    const [fiveHour] = windowsOf(
      quotaBlocks(quotaAxiRead({ ...report, capturedAt: recordedNow }, [codexFiveHour(71)]), savedProfiles(), recordedNow),
      "codex",
    );
    expect(summary(fiveHour)).toEqual({ id: "five_hour", left: 71, source: "harvested" });
    expect(fiveHour.pace?.status).toBe("on_pace");
    expect(fiveHour.pace?.timeRemainingPercent).toBeCloseTo(70.5778, 4);
  });
});

const claudeWeekAt = (observedAt: string): HarvestedReading => ({
  provider: "claude",
  harness: "claude-code",
  via: "log",
  credentialKey: undefined,
  windowId: "seven_day",
  cycleSeconds: 604_800,
  percentRemaining: 0,
  resetsAt: at("2026-10-23T17:00:00Z"),
  observedAt: at(observedAt),
  file: claudePath,
});

// The recording's one Claude login, keyed as given, with a second login keyed work listed before it.
const twoClaudeLogins = (defaultKey: string) =>
  withProviders(decodeQuota(fixture("quota-axi/schema-6.json")), (providers) =>
    providers.flatMap((entry) =>
      entry.provider !== "claude" || "kind" in entry
        ? [entry]
        : [
            { ...entry, accountKey: "work", accountKeys: ["work"] },
            { ...entry, accountKey: defaultKey, accountKeys: [defaultKey] },
          ],
    ),
  );

const sourceOf = (window: SourcedWindow) => (window.source.kind === "harvested" ? window.source.join.kind : "quota-axi");

const claudeSources = (report: Outcome<QuotaReport>) =>
  quotaBlocks(quotaAxiRead({ ...report, capturedAt: sixNow }, [claudeWeekAt("2026-10-16T19:29:00Z")]), savedProfiles(), sixNow)
    .filter((block) => block.body.kind === "live" && block.title.startsWith("claude"))
    .map((block) => [block.title, block.body.kind === "live" ? block.body.windows.map(sourceOf) : []]);

describe("a Claude reading with more than one login, never the first login listed", () => {
  test("lands on the default login, as an assumption", () => {
    expect(claudeSources(twoClaudeLogins("default"))).toEqual([
      ["claude main work", ["quota-axi", "quota-axi", "quota-axi"]],
      ["claude main", ["quota-axi", "default-account", "quota-axi"]],
    ]);
  });

  test("joins no login when none is the default", () => {
    expect(claudeSources(twoClaudeLogins("home"))).toEqual([
      ["claude main work", ["quota-axi", "quota-axi", "quota-axi"]],
      ["claude main home", ["quota-axi", "quota-axi", "quota-axi"]],
    ]);
  });
});

const askedOf = (read: QuotaRead) => (read.quotaAxi.kind === "ok" ? read.quotaAxi.value.providers.map((entry) => entry.provider) : []);

// The fixture's 12:00 five-hour rejection moved to 20:05, against the window resetting 23:00, beside the 20:00 week rejection.
const bothClaudeWindowsRejected = (): LogFile => ({
  ...claudeLog(),
  records: logRecords(
    "claude-code",
    fixture("harvest/claude-code.jsonl").replace("2026-10-13T12:00:00.000Z", "2026-10-13T20:05:00.000Z").replaceAll("1791907200", "1791932400"),
  ),
});

describe("readQuota's choice of source", () => {
  test("leaves Codex out of quota-axi's ask and reads both its windows from a rollout 38 minutes old", () => {
    const read = recordedQuotaRead(fixture("quota-axi/full.json"), recordedNow, [rollout(), claudeLog()]);
    expect(askedOf(read)).toEqual(["claude", "opencode-go"]);
    const codex = windowsOf(quotaBlocks(read, savedProfiles(), recordedNow), "codex");
    expect(codex.map(summary)).toEqual([
      { id: "five_hour", left: 81.5, source: "harvested" },
      { id: "weekly", left: 75, source: "harvested" },
    ]);
    expect(codex[0]?.source.kind === "harvested" ? codex[0].source.join : undefined).toEqual({
      kind: "credential-key",
      key: "codex-home",
    });
  });

  test("asks quota-axi about Codex again once the rollout's reading is an hour old", () => {
    const fresh = recordedQuotaRead(fixture("quota-axi/full.json"), DateTime.makeUnsafe("2026-10-13T20:39:59.999Z"), [rollout()]);
    const stale = recordedQuotaRead(fixture("quota-axi/full.json"), DateTime.makeUnsafe("2026-10-13T20:40:00Z"), [rollout()]);
    expect(askedOf(fresh)).toEqual(["claude", "opencode-go"]);
    expect(askedOf(stale)).toEqual(["claude", "codex", "opencode-go"]);
    expect(stale.logAccounts).toEqual([]);
  });

  test("still asks quota-axi about Claude when the logs reject only its week", () => {
    expect(askedOf(recordedQuotaRead(fixture("quota-axi/full.json"), recordedNow, [claudeLog()]))).toEqual([
      "claude",
      "codex",
      "opencode-go",
    ]);
  });

  test("reads Claude from its log alone when both its windows were rejected within the hour", () => {
    const read = recordedQuotaRead(fixture("quota-axi/full.json"), recordedNow, [bothClaudeWindowsRejected()]);
    expect(askedOf(read)).toEqual(["codex", "opencode-go"]);
    const claude = windowsOf(quotaBlocks(read, savedProfiles(), recordedNow), "claude main");
    expect(claude.map(summary)).toEqual([
      { id: "five_hour", left: 0, source: "harvested" },
      { id: "seven_day", left: 0, source: "harvested" },
    ]);
    expect(claude[0]?.source.kind === "harvested" ? claude[0].source.join : undefined).toEqual({ kind: "only-account" });
  });
});
