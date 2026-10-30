import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import {
  composedSessionQuota,
  type CountedCall,
  decodeSavedProfiles,
  decodeQuota,
  type LogFile,
  sessionQuotaAlerts,
  type SessionQuotaFlag,
  sessionQuotaReport,
  type SessionQuotaView,
  sessionLogsSince,
  sessionQuotaView,
  sessionQuotaViewOf,
} from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";
import { quotaAxiRead, recordedQuotaRead } from "../../lib/quota-read";
import { call, ended, fifthIn, hour, ledgerOf, reset, type Scenario, six, viewOf, windowOf } from "../../lib/quota-view-fixture";


// Thousands of input tokens each of the six sessions spent, so five burn above twice the fair share.
const spend = [25, 22, 20, 17, 14, 2];

const burning = (now: number): ReadonlyArray<CountedCall> =>
  six.map((session, index) => call(session, now - 10 * 60_000, (spend[index] ?? 0) * 1000));

const fortyMinutesIn = reset + 40 * 60_000;

describe("sessionQuotaView on the Claude week 40 minutes after reset with 1 point used", () => {
  const early = (weekStatus: Scenario["weekStatus"]) =>
    windowOf(viewOf({ now: fortyMinutesIn, weekStatus, weekLeft: 99 }, six, burning(fortyMinutesIn)), "claude", "seven_day");

  test("reads the worked example's sustainable rate and fair share", () => {
    const week = early("on_pace");
    expect(week.usedPoints).toBe(1);
    expect(week.sustainablePointsPerHour).toBeCloseTo(0.59, 2);
    expect(week.activeSessions).toBe(6);
    expect(week.fairPointsPerHour).toBeCloseTo(0.1, 2);
  });

  test("five sessions burn over twice the fair share, the false alarm the gate exists to suppress", () => {
    const week = early("on_pace");
    expect(week.sessions.filter((row) => row.priced.pointsPerHour > 2 * (week.fairPointsPerHour ?? Number.NaN))).toHaveLength(5);
  });

  test("flags no session while quota-axi reads the window on pace", () => {
    expect(early("on_pace").sessions.filter((row) => row.flagged)).toEqual([]);
  });

  test("flags no session even when quota-axi reads it ahead, since the window is inside its first tenth", () => {
    const week = early("ahead");
    expect(week.pastFirstTenth).toBe(false);
    expect(week.sessions.filter((row) => row.flagged)).toEqual([]);
  });
});

describe("sessionQuotaView with a call at the exact instant the week starts", () => {
  const [a] = six;
  const week = () =>
    windowOf(
      viewOf({ now: fortyMinutesIn, weekStatus: "on_pace", weekLeft: 99 }, [a], [call(a, reset, 5000)]),
      "claude",
      "seven_day",
    );

  test("counts the call in the trailing hour and rates it over the 40 minutes since the start", () => {
    expect(week().sessions[0]?.trailingHourTokens).toEqual({ input: 5000, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(week().sessions[0]?.priced.pointsPerHour).toBeCloseTo(1.5, 9);
    expect(week().sessions[0]?.raw.pointsPerHour).toBeCloseTo(1.5, 9);
    expect(week().activeSessions).toBe(1);
  });
});


describe("sessionQuotaView with a call exactly one hour before the read", () => {
  const [a, b] = six;
  const week = () =>
    windowOf(
      viewOf({ now: fifthIn, weekStatus: "ahead", weekLeft: 60 }, [a, b], [call(a, fifthIn - hour, 5000), call(b, fifthIn - hour - 1, 9000)]),
      "claude",
      "seven_day",
    );

  test("counts the call on the boundary in the trailing hour and the one before it out", () => {
    const rows = new Map(week().sessions.map((row) => [row.session.id, row]));
    expect(rows.get("pane:a")?.trailingHourTokens.input).toBe(5000);
    expect(rows.get("pane:b")?.trailingHourTokens.input).toBe(0);
    expect(rows.get("pane:a")?.priced.pointsPerHour).toBeCloseTo(100 / 7, 9);
    expect(rows.get("pane:b")?.priced.pointsPerHour).toBe(0);
  });

  test("flags the session whose call sits on the boundary", () => {
    expect(week().sessions.filter((row) => row.flagged).map((row) => row.session.id)).toEqual(["pane:a"]);
    expect(week().activeSessions).toBe(1);
  });
});

// Worked by hand: the six sessions spend 100,000 tokens in the trailing hour, so 40 points rate f's 2000 at 0.8 points an
// hour, over the fair 60 points over 134.4 hours split six ways, 0.074, like every other session's.
describe("sessionQuotaView past the first tenth of the week", () => {
  test("flags every session over its fair share while the window is ahead of pace", () => {
    const week = windowOf(viewOf({ now: fifthIn, weekStatus: "ahead", weekLeft: 60 }, six, burning(fifthIn)), "claude", "seven_day");
    expect(week.sessions.filter((row) => row.flagged).map((row) => row.session.id)).toEqual(six.map((session) => session.id));
  });

  test("flags nothing while the window is not ahead of pace", () => {
    const week = windowOf(viewOf({ now: fifthIn, weekStatus: "on_pace", weekLeft: 80 }, six, burning(fifthIn)), "claude", "seven_day");
    expect(week.sessions.some((row) => row.flagged)).toBe(false);
  });

  // Worked by hand: z spends 90,000 input tokens in the trailing hour and has ended, so it leads the hour, takes no fair
  // share and holds no flag. The six live sessions still split 60 points over the 134.4 hours left.
  test("never flags an ended session, however much it spent in the trailing hour", () => {
    const gone = ended("z");
    const calls = [...burning(fifthIn), call(gone, fifthIn - 5 * 60_000, 90_000)];
    const week = windowOf(
      viewOf({ now: fifthIn, weekStatus: "ahead", weekLeft: 60, weekRunway: "projected_exhaustion" }, [...six, gone], calls),
      "claude",
      "seven_day",
    );
    expect(week.sessions[0]?.session.id).toBe("file:z");
    expect(week.sessions.filter((row) => row.flagged).map((row) => row.session.id)).toEqual(six.map((session) => session.id));
    expect(week.activeSessions).toBe(6);
    expect(week.fairPointsPerHour).toBeCloseTo(60 / 134.4 / 6, 9);
  });
});

const weekReset = reset + 7 * 24 * hour;

const tenPastReset = weekReset + 10 * 60_000;

describe("sessionQuotaView on a cached week read ten minutes after it reset", () => {
  const [a, b] = six;
  const calls: ReadonlyArray<CountedCall> = [call(a, weekReset - 30 * 60_000, 10_000), call(b, weekReset + 5 * 60_000, 50_000)];
  const week = () =>
    windowOf(viewOf({ now: tenPastReset, weekStatus: "ahead", weekLeft: 40 }, six, calls), "claude", "seven_day");

  test("counts only the call before the reset", () => {
    expect(week().observedCalls).toBe(1);
    expect(week().sessions.map((row) => row.session.id)).toEqual(["pane:a"]);
  });

  test("leaves a call at the reset instant to the next cycle, so no two cycles both count it", () => {
    const [, , c] = six;
    const atReset = [...calls, call(c, weekReset, 20_000)];
    const old = windowOf(viewOf({ now: tenPastReset, weekStatus: "ahead", weekLeft: 40 }, six, atReset), "claude", "seven_day");
    expect(old.sessions.map((row) => row.session.id)).toEqual(["pane:a"]);
  });

  test("closes the gate, since the old cycle's pace says nothing about the new one", () => {
    expect(week().pace).toBe("unknown");
    expect(week().aheadOfPace).toBe(false);
    expect(week().sessions.some((row) => row.flagged)).toBe(false);
  });

  test("has no sustainable rate and no fair share, not 40 points over a one-minute floor", () => {
    expect(week().sustainablePointsPerHour).toBeNull();
    expect(week().fairPointsPerHour).toBeNull();
  });
});

describe("sessionQuotaView on a cached week read two hours after it reset", () => {
  const [a] = six;
  const week = () =>
    windowOf(
      viewOf({ now: weekReset + 2 * hour, weekStatus: "ahead", weekLeft: 40 }, [a], [call(a, weekReset - 15 * 60_000, 10_000)]),
      "claude",
      "seven_day",
    );

  test("keeps the call in the old cycle and holds no trailing-hour spend", () => {
    expect(week().observedCalls).toBe(1);
    expect(week().sessions[0]?.trailingHourTokens.input).toBe(0);
    expect(week().sessions[0]?.priced.pointsPerHour).toBe(0);
    expect(week().sessions[0]?.raw.pointsPerHour).toBe(0);
    expect(week().activeSessions).toBe(0);
  });
});

describe("sessionQuotaView shares, raw and priced", () => {
  const [a, b] = six;
  const now = fifthIn;
  const calls: ReadonlyArray<CountedCall> = [
    { ...call(a, now - 30 * 60_000, 1000), tokens: { input: 1000, output: 100, cacheRead: 10_000, cacheWrite: 0 } },
    call(b, now - 2 * hour, 3000),
  ];
  const week = () => windowOf(viewOf({ now, weekStatus: "on_pace", weekLeft: 60 }, [a, b], calls), "claude", "seven_day");

  test("ranks by the price-weighted share, which reverses the raw order", () => {
    expect(week().sessions.map((row) => row.session.id)).toEqual(["pane:b", "pane:a"]);
    expect(week().sessions.map((row) => row.raw.share)).toEqual([3000 / 14_100, 11_100 / 14_100]);
    expect(week().sessions.map((row) => row.priced.share)).toEqual([3000 / 5500, 2500 / 5500]);
  });

  test("scales each share to the 40 points the vendor reports used", () => {
    expect(week().sessions.map((row) => row.priced.contributionPoints)).toEqual([(3000 / 5500) * 40, (2500 / 5500) * 40]);
  });

  test("rates points per hour from the trailing hour alone", () => {
    expect(week().sessions.map((row) => row.priced.pointsPerHour)).toEqual([0, (2500 * 40) / 5500]);
  });

  test("keeps the measured tokens of each session", () => {
    expect(week().sessions[1]?.tokens).toEqual({ input: 1000, output: 100, cacheRead: 10_000, cacheWrite: 0 });
    expect(week().observedCalls).toBe(2);
  });
});

describe("sessionQuotaView where this machine logged nothing", () => {
  test("leaves every used point of the Codex week unattributed", () => {
    const codex = windowOf(viewOf({ now: fifthIn, weekStatus: "on_pace", weekLeft: 60 }, six, burning(fifthIn)), "codex", "weekly");
    expect(codex.sessions).toEqual([]);
    expect(codex.unattributedPoints).toBe(47);
  });

  test("attributes every used point of a window with local calls, an upper bound", () => {
    const week = windowOf(viewOf({ now: fifthIn, weekStatus: "on_pace", weekLeft: 60 }, six, burning(fifthIn)), "claude", "seven_day");
    expect(week.unattributedPoints).toBe(0);
    expect(week.sessions.reduce((sum, row) => sum + row.priced.contributionPoints, 0)).toBeCloseTo(40, 9);
  });

  test("tracks no model window, which meters something other than the account", () => {
    const view = viewOf({ now: fifthIn, weekStatus: "on_pace", weekLeft: 60 }, six, []);
    const claude = view.accounts.find((account) => account.provider === "claude");
    expect(claude?.body.kind === "windows" ? claude.body.windows.map((window) => window.id) : []).toEqual(["seven_day"]);
  });
});

const schema6 = () => {
  const quota = decodeQuota(fixture("quota-axi/schema-6.json"));
  const savedProfiles = decodeSavedProfiles(fixture("saved-profiles/status.json"));
  const now = DateTime.makeUnsafe("2026-10-16T19:28:55.289Z");
  return { quota: quotaAxiRead({ ...quota, capturedAt: now }), savedProfiles: { ...savedProfiles, capturedAt: now }, now, timeZone: DateTime.zoneMakeNamedUnsafe("UTC") };
};

describe("sessionQuotaView account joins, against the recorded schema-6 replay", () => {
  const at = Date.parse("2026-10-16T19:00:00Z");
  const [a] = six;
  const calls: ReadonlyArray<CountedCall> = [
    { ...call(a, at, 10), route: "openai-codex", quota: "codex", credentialKey: "openai-codex" },
    { ...call(a, at + 1000, 20), harness: "codex", route: "codex", quota: "codex", credentialKey: "codex-home" },
    call(a, at + 2000, 30),
    { ...call(a, at + 3000, 40), route: "openai", quota: undefined },
  ];
  const view = () =>
    sessionQuotaView({
      ...schema6(),
      panes: undefined,
      processes: undefined,
      ledger: ledgerOf(calls),
      sessions: [a],
      sessionOfFile: new Map([[a.files[0] ?? "", a.id]]),
      unmatched: [],
    });

  test("joins a Codex call to the account whose keys hold its credential", () => {
    const joins = view().accounts.map((account) => [account.title, account.joins]);
    expect(joins).toEqual([
      ["claude main", [{ kind: "only-account" }]],
      ["codex codex-home", [{ kind: "credential-key", key: "codex-home" }]],
      ["codex openai-codex", [{ kind: "credential-key", key: "openai-codex" }]],
      ["opencode-go", []],
    ]);
  });

  test("keeps a call no subscription meters apart, by its route", () => {
    expect(view().unmetered).toEqual([
      { route: "openai", calls: 1, tokens: { input: 40, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]);
  });

  // A rollout from Codex's own home read at 19:20, inside quota-axi's hour of reuse, for both Codex account windows.
  const freshRollout: LogFile = {
    path: "/home/tester/.codex/sessions/2026/10/16/rollout-2026-10-16T19-00-00-a.jsonl",
    harness: "codex",
    modifiedAt: 0,
    records: [
      {
        kind: "codex-limits",
        at: Date.parse("2026-10-16T19:20:00Z"),
        windows: [
          { usedPercent: 10, windowMinutes: 300, resetsAt: Date.parse("2026-10-16T21:00:00Z") },
          { usedPercent: 60, windowMinutes: 10_080, resetsAt: Date.parse("2026-10-22T08:24:11Z") },
        ],
      },
    ],
  };
  const harvestedView = () => {
    const { savedProfiles, now, timeZone } = schema6();
    return sessionQuotaView({
      quota: recordedQuotaRead(fixture("quota-axi/schema-6.json"), now, [freshRollout]),
      savedProfiles,
      panes: undefined,
      processes: undefined,
      ledger: ledgerOf(calls),
      sessions: [a],
      sessionOfFile: new Map([[a.files[0] ?? "", a.id]]),
      unmatched: [],
      now,
      timeZone,
    });
  };

  test("joins no account to a Codex call keyed to a credential the rollout did not read", () => {
    const harvested = harvestedView();
    expect(harvested.accounts.map((account) => [account.title, account.joins])).toEqual([
      ["claude main", [{ kind: "only-account" }]],
      ["codex", [{ kind: "credential-key", key: "codex-home" }]],
      ["opencode-go", []],
    ]);
    expect(harvested.unjoinedCalls).toBe(1);
  });

  test("names the codex-home account by the same credential whether quota-axi or the rollout read it, not by accountKey", () => {
    const codexHome = (read: SessionQuotaView) =>
      sessionQuotaReport(read).accounts.find((account) => account.provider === "codex" && account.credentialKey === "codex-home");
    const read = codexHome(view());
    const harvested = codexHome(harvestedView());
    expect([read?.accountKey, harvested?.accountKey]).toEqual(["codex-home", null]);
    const flagOn = (account: typeof read): SessionQuotaFlag => ({
      session: a.id,
      label: a.id,
      account: {
        provider: "codex",
        accountKey: account?.accountKey ?? null,
        credentialKey: account?.credentialKey ?? null,
        title: account?.title ?? "",
      },
      window: "weekly",
      windowLabel: "week",
      pricedPointsPerHour: 2,
      fairPointsPerHour: 1,
      pricedShare: 0.5,
      rawShare: 0.5,
    });
    expect(sessionQuotaAlerts([flagOn(harvested)], [flagOn(read)], DateTime.makeUnsafe("2026-10-16T19:29:25Z"))).toEqual([]);
  });

  test("composes this machine's rollout account and a peer's codex-home row into one Codex account, legacy peers included, not split by accountKey", () => {
    const report = sessionQuotaReport(view());
    const legacy = {
      ...report,
      accounts: report.accounts.map(({ credentialKey: _, ...account }) => account),
      windows: report.windows.map(({ source: _, account: { credentialKey: __, ...account }, ...window }) => ({ ...window, account })),
    };
    for (const peer of [report, legacy]) {
      const south = valueOf(sessionQuotaViewOf(peer, "south"));
      const composed = composedSessionQuota(harvestedView(), "north", [{ name: "south", reading: { kind: "ok", value: south } }]);
      const codex = composed.accounts.filter((account) => account.provider === "codex");
      expect(codex.map((account) => account.joins)).toEqual([
        [{ kind: "credential-key", key: "codex-home" }],
        [{ kind: "credential-key", key: "openai-codex" }],
      ]);
      const home = codex.at(0)?.body;
      const week = home?.kind === "windows" ? home.windows.find((window) => window.id === "weekly") : undefined;
      expect(week?.sessions.map((row) => row.session.machine).toSorted()).toEqual(["north", "south"]);
    }
  });

  test("names a row quota-axi coalesced with the native login by codex-home, as the rollout names it", () => {
    const { quota: read, savedProfiles, now, timeZone } = schema6();
    const quota = read.quotaAxi;
    if (quota.kind !== "ok") throw new Error("the schema-6 fixture does not decode");
    const providers = quota.value.providers.map((entry) =>
      "kind" in entry || entry.accountKey !== "codex-home"
        ? entry
        : { ...entry, accountKey: "openai-codex-work", accountKeys: ["openai-codex-work", "codex-home"] },
    );
    const coalesced = sessionQuotaView({
      quota: quotaAxiRead({ ...quota, value: { ...quota.value, providers } }),
      savedProfiles,
      panes: undefined,
      processes: undefined,
      ledger: ledgerOf([]),
      sessions: [],
      sessionOfFile: new Map(),
      unmatched: [],
      now,
      timeZone,
    });
    expect(
      sessionQuotaReport(coalesced)
        .accounts.filter((account) => account.provider === "codex")
        .map((account) => [account.accountKey, account.credentialKey]),
    ).toEqual([
      ["openai-codex-work", "codex-home"],
      ["openai-codex", "openai-codex"],
    ]);
  });

  test("reads each harness back as far as its earliest window or local midnight, whichever is earlier", () => {
    const { quota, now, timeZone } = schema6();
    const since = sessionLogsSince(quota, now, timeZone);
    expect(new Date(since["claude-code"] ?? Number.NaN).toISOString()).toBe("2026-10-16T00:00:00.000Z");
    expect(new Date(since.pi ?? Number.NaN).toISOString()).toBe("2026-10-08T10:51:51.000Z");
    expect(new Date(since.codex ?? Number.NaN).toISOString()).toBe("2026-10-15T08:24:11.000Z");
  });
});
