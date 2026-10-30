import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import {
  type CountedCall,
  decodeSavedProfiles,
  decodeQuota,
  type Session,
  type SessionQuotaReport,
  type SessionQuotaView,
  sessionQuotaView,
  type WindowView,
} from "@tui-dash/schema";
import { composedSessionQuota, sessionQuotaReport, sessionQuotaViewOf } from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { valueOf } from "../../lib/outcomes";
import { quotaAxiRead } from "../../lib/quota-read";
import { call, ended, fifthIn, hour, ledgerOf, six, viewOf, windowOf } from "../../lib/quota-view-fixture";

const multipleOfFair = (window: WindowView, id: string): number =>
  (window.sessions.find((row) => row.session.id === id)?.priced.pointsPerHour ?? Number.NaN) / (window.fairPointsPerHour ?? Number.NaN);

const flaggedIds = (window: WindowView): ReadonlyArray<string> =>
  window.sessions.filter((row) => row.flagged).map((row) => row.session.id);

describe("sessionQuotaView flags a session only over its fair share of a limit running ahead", () => {
  const gone = ended("z");
  const [a, b, c, d, e] = six;

  // a alone burns, so its fair share is the whole 60/134.4 points an hour, and 1000 of 154,483 window tokens rate it at 0.58 of that.
  test("leaves unflagged the trailing hour's top spender at 0.58 of its fair share", () => {
    const calls = [call(a, fifthIn - 10 * 60_000, 1000), call(gone, fifthIn - 30 * hour, 153_483)];
    const week = windowOf(viewOf({ now: fifthIn, weekStatus: "ahead", weekLeft: 60 }, [a, gone], calls), "claude", "seven_day");
    expect(week.aheadOfPace && week.pastFirstTenth).toBe(true);
    expect(week.sessions.toSorted((left, right) => right.priced.pointsPerHour - left.priced.pointsPerHour).at(0)?.session.id).toBe("pane:a");
    expect(multipleOfFair(week, "pane:a")).toBeCloseTo(0.58, 4);
    expect(flaggedIds(week)).toEqual([]);
  });

  // The month resets 20 days after the week did, so it is 0.38 through with 66 points left over 446.4 hours. a alone burns,
  // and 1000 of 28,391 window tokens times the 34 points used rate it at 8.1 times that fair share.
  test("leaves unflagged a session at 8.1 times its fair share of the OpenCode Go month while that month is on pace", () => {
    const opencode = (session: Session, at: number, input: number): CountedCall => ({ ...call(session, at, input), route: "opencode-go", quota: "opencode-go" });
    const calls = [opencode(a, fifthIn - 10 * 60_000, 1000), opencode(gone, fifthIn - 30 * hour, 27_391)];
    const month = (monthStatus: "ahead" | "on_pace") =>
      windowOf(viewOf({ now: fifthIn, weekStatus: "ahead", weekLeft: 60, monthStatus }, [a, gone], calls), "opencode-go", "monthly");
    expect(month("on_pace").pastFirstTenth).toBe(true);
    expect(multipleOfFair(month("on_pace"), "pane:a")).toBeCloseTo(8.1, 3);
    expect(flaggedIds(month("on_pace"))).toEqual([]);
    expect(flaggedIds(month("ahead"))).toEqual(["pane:a"]);
  });

  // Five live sessions burn, so each fair share is a fifth of 60/134.4 points an hour. Their trailing-hour tokens are
  // 46, 19, 18, 5 and 2 thousand of 4.48 million window tokens, which rate them at 4.6, 1.9, 1.8, 0.5 and 0.2 of it.
  test("flags the three sessions at 4.6, 1.9 and 1.8 times their fair share of the Claude week running ahead, and no other", () => {
    const hourSpend = [46_000, 19_000, 18_000, 5000, 2000];
    const burners = [a, b, c, d, e];
    const calls = [
      ...burners.map((session, index) => call(session, fifthIn - 10 * 60_000, hourSpend[index] ?? 0)),
      call(gone, fifthIn - 30 * hour, 4_390_000),
    ];
    const week = windowOf(
      viewOf({ now: fifthIn, weekStatus: "ahead", weekLeft: 60, weekRunway: "projected_exhaustion" }, [...burners, gone], calls),
      "claude",
      "seven_day",
    );
    expect(week.activeSessions).toBe(5);
    expect(burners.map((session) => multipleOfFair(week, session.id))).toEqual([4.6, 1.9, 1.8, 0.5, 0.2].map((m) => expect.closeTo(m, 9)));
    expect(flaggedIds(week)).toEqual(["pane:a", "pane:b", "pane:c"]);
  });
});

describe("an early exhaustion projection defers to the live rate", () => {
  const gone = ended("z");
  const [a, b] = six;

  test("flags two sessions over their fair share while the week's exhaustion is still an early projection, not a firm false", () => {
    const calls = [call(a, fifthIn - 10 * 60_000, 37_500), call(b, fifthIn - 10 * 60_000, 30_000), call(gone, fifthIn - 30 * hour, 4_390_000)];
    const week = windowOf(
      viewOf({ now: fifthIn, weekStatus: "ahead", weekLeft: 60, weekRunway: "early" }, [a, b, gone], calls),
      "claude",
      "seven_day",
    );
    expect(week.exhaustsBeforeReset).toBe(true);
    expect([multipleOfFair(week, "pane:a"), multipleOfFair(week, "pane:b")]).toEqual([expect.closeTo(1.5, 1), expect.closeTo(1.2, 1)]);
    expect(flaggedIds(week)).toEqual(["pane:a", "pane:b"]);
  });
});

describe("a stale provider runway leaves the live rate to decide, not a stale verdict either way", () => {
  const gone = ended("z");
  const [a, b] = six;
  const stale = { now: fifthIn, weekStatus: "ahead", weekLeft: 60 } as const;

  test("leaves unflagged a session over its fair share while the live total stays under the sustainable rate", () => {
    const calls = [call(a, fifthIn - 10 * 60_000, 32_500), call(b, fifthIn - 10 * 60_000, 5000), call(gone, fifthIn - 30 * hour, 4_390_000)];
    const week = windowOf(
      viewOf({ ...stale, weekRunway: "projected_exhaustion", weekStale: true }, [a, b, gone], calls),
      "claude",
      "seven_day",
    );
    expect(week.aheadOfPace && week.pastFirstTenth).toBe(true);
    expect(week.verdict).toBeNull();
    expect(multipleOfFair(week, "pane:a")).toBeGreaterThan(1);
    expect(week.exhaustsBeforeReset).toBe(false);
    expect(flaggedIds(week)).toEqual([]);
  });

  test("flags sessions over their fair share while the live total runs over the sustainable rate", () => {
    const calls = [call(a, fifthIn - 10 * 60_000, 37_500), call(b, fifthIn - 10 * 60_000, 30_000), call(gone, fifthIn - 30 * hour, 4_390_000)];
    const week = windowOf(
      viewOf({ ...stale, weekRunway: "through_reset", weekStale: true }, [a, b, gone], calls),
      "claude",
      "seven_day",
    );
    expect(week.verdict).toBeNull();
    expect(week.exhaustsBeforeReset).toBe(true);
    expect(flaggedIds(week)).toEqual(["pane:a", "pane:b"]);
  });
});

describe("a peer's report flags again by the fair share rule, not by its old flags", () => {
  const gone = ended("z");
  const [a, b, c, d, e] = six;

  const topSpenderOnly = (view: SessionQuotaView): SessionQuotaReport => {
    const report = sessionQuotaReport(view);
    return {
      ...report,
      windows: report.windows.map((window) => ({
        ...window,
        sessions: window.sessions.map((row) => ({ ...row, flagged: window.gate.open && row.session === "pane:a" })),
      })),
    };
  };

  // The peer's account is the only one, as when this machine lacks it, so its window composes alone.
  const peerWeek = (view: SessionQuotaView): WindowView => {
    const south = valueOf(sessionQuotaViewOf(topSpenderOnly(view), "south"));
    return windowOf(composedSessionQuota({ ...view, accounts: [] }, "north", [{ name: "south", reading: { kind: "ok", value: south } }]), "claude", "seven_day");
  };

  test("leaves unflagged the top spender at 0.58 of its fair share", () => {
    const calls = [call(a, fifthIn - 10 * 60_000, 1000), call(gone, fifthIn - 30 * hour, 153_483)];
    const view = viewOf({ now: fifthIn, weekStatus: "ahead", weekLeft: 60 }, [a, gone], calls);
    expect(topSpenderOnly(view).windows.find((window) => window.id === "seven_day")?.sessions.filter((row) => row.flagged)).toHaveLength(1);
    expect(flaggedIds(peerWeek(view))).toEqual([]);
  });

  test("flags all three sessions over their fair share, the top spender's rates unchanged", () => {
    const hourSpend = [46_000, 19_000, 18_000, 5000, 2000];
    const burners = [a, b, c, d, e];
    const calls = [
      ...burners.map((session, index) => call(session, fifthIn - 10 * 60_000, hourSpend[index] ?? 0)),
      call(gone, fifthIn - 30 * hour, 4_390_000),
    ];
    const view = viewOf({ now: fifthIn, weekStatus: "ahead", weekLeft: 60 }, [...burners, gone], calls);
    const week = peerWeek(view);
    expect(flaggedIds(week)).toEqual(["pane:a", "pane:b", "pane:c"]);
    expect(burners.map((session) => multipleOfFair(week, session.id))).toEqual([4.6, 1.9, 1.8, 0.5, 0.2].map((m) => expect.closeTo(m, 9)));
  });
});

describe("a burst on a healthy month shows its multiple without a flag", () => {
  const monthReset = Date.parse("2026-11-08T10:51:51.000Z");
  const monthStart = monthReset - 31 * 24 * hour;
  const monthNow = Math.round(monthStart + 0.39 * 31 * 24 * hour);

  const monthReport = (runway: unknown): string =>
    JSON.stringify({
      generatedAt: new Date(monthNow).toISOString(),
      schemaVersion: 5,
      providers: [
        {
          provider: "opencode-go",
          quotaSemantics: {
            status: "known",
            effectiveAvailability: [{ scope: "all_models", status: "known", runway }],
          },
          windows: [
            {
              id: "monthly",
              label: "month",
              kind: "monthly",
              percentRemaining: 60,
              resetsAt: new Date(monthReset).toISOString(),
              pace: {
                status: "ahead",
                cycleSeconds: 31 * 24 * 3600,
                projectedExhaustedAt: "2026-11-07T08:55:08.857Z",
                projectionConfidence: "established",
              },
            },
          ],
          state: { status: "fresh", stale: false },
        },
      ],
    });

  const [a, b, c] = six;
  const burners = [a, b, c];
  const gone = ended("z");
  const opencode = (session: Session, at: number, input: number): CountedCall => ({
    ...call(session, at, input),
    route: "opencode-go",
    quota: "opencode-go",
  });
  const calls = [
    opencode(a, monthNow - 10 * 60_000, 6500),
    opencode(b, monthNow - 10 * 60_000, 3700),
    opencode(c, monthNow - 10 * 60_000, 3600),
    opencode(gone, monthNow - 30 * hour, 893_880),
  ];

  const monthView = (runway: unknown): SessionQuotaView => {
    const quota = decodeQuota(monthReport(runway));
    const savedProfiles = decodeSavedProfiles(fixture("saved-profiles/status.json"));
    const now = DateTime.makeUnsafe(monthNow);
    return sessionQuotaView({
      quota: quotaAxiRead({ ...quota, capturedAt: now }),
      savedProfiles: { ...savedProfiles, capturedAt: now },
      panes: undefined,
      processes: undefined,
      ledger: ledgerOf(calls),
      sessions: [...burners, gone],
      sessionOfFile: new Map([...burners, gone].map((session) => [session.files[0] ?? "", session.id])),
      unmatched: [],
      now,
      timeZone: DateTime.zoneMakeNamedUnsafe("UTC"),
    });
  };

  const month = (runway: unknown): WindowView => windowOf(monthView(runway), "opencode-go", "monthly");

  test("a 6.5x fair burst stays unflagged while the verdict is through_reset", () => {
    const view = month({ status: "through_reset", limitingWindowId: "monthly" });
    expect(view.elapsedFraction).toBeCloseTo(0.39, 3);
    expect(view.aheadOfPace && view.pastFirstTenth).toBe(true);
    expect(view.exhaustsBeforeReset).toBe(false);
    expect(view.activeSessions).toBe(3);
    expect(burners.map((session) => multipleOfFair(view, session.id))).toEqual([6.5, 3.7, 3.6].map((m) => expect.closeTo(m, 0)));
    expect(flaggedIds(view)).toEqual([]);
  });

  test("the same 6.5x share flags when exhaustion is projected before the reset", () => {
    const view = month({
      status: "projected_exhaustion",
      limitingWindowId: "monthly",
      projectedExhaustedAt: "2026-10-28T12:00:00.000Z",
      usableRunwaySeconds: 686913,
      projectionConfidence: "established",
    });
    expect(view.exhaustsBeforeReset).toBe(true);
    expect(burners.map((session) => multipleOfFair(view, session.id))).toEqual([6.5, 3.7, 3.6].map((m) => expect.closeTo(m, 0)));
    expect(flaggedIds(view)).toEqual(["pane:a", "pane:b", "pane:c"]);
  });
});

describe("a harvested window judges exhaustion by its live sessions' total rate, not the never-exhausts or alone-over-sustainable rule", () => {
  const weekNow = Date.parse("2026-10-16T12:00:00Z");
  const weekReset = weekNow + 72 * hour;

  const codexReport = (): string =>
    JSON.stringify({
      generatedAt: new Date(weekNow - 30 * 60_000).toISOString(),
      schemaVersion: 5,
      providers: [
        {
          provider: "codex",
          accountKeys: ["codex-home"],
          windows: [
            {
              id: "weekly",
              label: "week",
              kind: "weekly",
              percentRemaining: 90,
              resetsAt: new Date(weekReset).toISOString(),
              pace: { status: "behind", cycleSeconds: 604800 },
            },
          ],
          state: { status: "fresh", stale: false },
        },
      ],
    });

  const [a, b] = six;
  const gone = ended("z");
  const codex = (session: Session, at: number, input: number): CountedCall => ({
    ...call(session, at, input),
    route: "codex",
    quota: "codex",
  });
  const calls = [
    codex(a, weekNow - 10 * 60_000, 3000),
    codex(b, weekNow - 10 * 60_000, 3000),
    codex(gone, weekNow - 30 * hour, 694_000),
  ];

  const week = (): WindowView => {
    const quota = decodeQuota(codexReport());
    const savedProfiles = decodeSavedProfiles(fixture("saved-profiles/status.json"));
    const now = DateTime.makeUnsafe(weekNow);
    const view = sessionQuotaView({
      quota: quotaAxiRead({ ...quota, capturedAt: now }, [
        {
          provider: "codex",
          harness: "codex",
          via: "log",
          credentialKey: "codex-home",
          windowId: "weekly",
          cycleSeconds: 604800,
          percentRemaining: 30,
          resetsAt: weekReset,
          observedAt: weekNow - 10 * 60_000,
          file: "/logs/rollout.jsonl",
        },
      ]),
      savedProfiles: { ...savedProfiles, capturedAt: now },
      panes: undefined,
      processes: undefined,
      ledger: ledgerOf(calls),
      sessions: [a, b, gone],
      sessionOfFile: new Map([a, b, gone].map((session) => [session.files[0] ?? "", session.id])),
      unmatched: [],
      now,
      timeZone: DateTime.zoneMakeNamedUnsafe("UTC"),
    });
    return windowOf(view, "codex", "weekly");
  };

  test("flags both sessions over their fair share while neither alone passes the sustainable rate", () => {
    const view = week();
    expect(view.source.kind).toBe("harvested");
    expect(view.aheadOfPace && view.pastFirstTenth).toBe(true);
    expect(view.sustainablePointsPerHour).toBeCloseTo(0.417, 3);
    expect(view.exhaustsBeforeReset).toBe(true);
    expect(view.activeSessions).toBe(2);
    expect([multipleOfFair(view, "pane:a"), multipleOfFair(view, "pane:b")]).toEqual([expect.closeTo(1.44, 1), expect.closeTo(1.44, 1)]);
    expect(flaggedIds(view)).toEqual(["pane:a", "pane:b"]);
  });
});

describe("an exhausted harvested window reads as exhausting before its reset, never a 0-over-0 reading", () => {
  const weekNow = Date.parse("2026-10-16T12:00:00Z");
  const weekReset = weekNow + 72 * hour;

  const codexReport = (): string =>
    JSON.stringify({
      generatedAt: new Date(weekNow - 30 * 60_000).toISOString(),
      schemaVersion: 5,
      providers: [
        {
          provider: "codex",
          accountKeys: ["codex-home"],
          windows: [
            {
              id: "weekly",
              label: "week",
              kind: "weekly",
              percentRemaining: 90,
              resetsAt: new Date(weekReset).toISOString(),
              pace: { status: "behind", cycleSeconds: 604800 },
            },
          ],
          state: { status: "fresh", stale: false },
        },
      ],
    });

  const [a, b] = six;
  const codex = (session: Session, at: number, input: number): CountedCall => ({
    ...call(session, at, input),
    route: "codex",
    quota: "codex",
  });

  test("marks the dry week exhausting with no flags while its sessions sit idle", () => {
    const quota = decodeQuota(codexReport());
    const savedProfiles = decodeSavedProfiles(fixture("saved-profiles/status.json"));
    const now = DateTime.makeUnsafe(weekNow);
    const view = sessionQuotaView({
      quota: quotaAxiRead({ ...quota, capturedAt: now }, [
        {
          provider: "codex",
          harness: "codex",
          via: "log",
          credentialKey: "codex-home",
          windowId: "weekly",
          cycleSeconds: 604800,
          percentRemaining: 0,
          resetsAt: weekReset,
          observedAt: weekNow - 10 * 60_000,
          file: "/logs/rollout.jsonl",
        },
      ]),
      savedProfiles: { ...savedProfiles, capturedAt: now },
      panes: undefined,
      processes: undefined,
      ledger: ledgerOf([codex(a, weekNow - 30 * hour, 5000), codex(b, weekNow - 30 * hour, 4000)]),
      sessions: [a, b],
      sessionOfFile: new Map([a, b].map((session) => [session.files[0] ?? "", session.id])),
      unmatched: [],
      now,
      timeZone: DateTime.zoneMakeNamedUnsafe("UTC"),
    });
    const week = windowOf(view, "codex", "weekly");
    expect(week.source.kind).toBe("harvested");
    expect(week.aheadOfPace && week.pastFirstTenth).toBe(true);
    expect(week.sustainablePointsPerHour).toBe(0);
    expect(week.exhaustsBeforeReset).toBe(true);
    expect(flaggedIds(week)).toEqual([]);
  });
});
