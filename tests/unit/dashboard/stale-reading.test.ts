import { describe, expect, test } from "bun:test";
import { DateTime, Option } from "effect";
import type { QuotaBlock, QuotaBlockBody, QuotaWindow, SessionQuotaView } from "@tui-dash/schema";
import { logFreshMillis } from "@tui-dash/schema";
import { countdown } from "@tui-dash/ui";
import { dashboardNow } from "../../lib/dashboard-fixture";
import { boxLines, glanceLines } from "../../lib/host-fixture";
import { fixture } from "../../lib/fixtures";
import { sessionViewOfQuota } from "../../lib/session-fixture";

const reportedAt = DateTime.makeUnsafe("2026-10-13T07:18:16Z");
const freshReportedAt = DateTime.makeUnsafe("2026-10-13T20:18:15Z");

const thirteenHoursMillis = DateTime.toEpochMillis(dashboardNow) - DateTime.toEpochMillis(reportedAt);
const freshMillis = DateTime.toEpochMillis(dashboardNow) - DateTime.toEpochMillis(freshReportedAt);
const ageText = "read " + countdown(thirteenHoursMillis / 1000) + " ago";

const week = (): QuotaWindow => ({
  id: "seven_day",
  label: "week",
  kind: "weekly",
  percentRemaining: 0,
  resetsAt: DateTime.makeUnsafe("2026-10-16T17:00:00Z"),
  pace: { status: "ahead", cycleSeconds: 604800 },
});

const live = (at: DateTime.Utc): QuotaBlockBody => ({
  kind: "live",
  plan: "max",
  reportedAt: at,
  state: { status: "fresh", stale: false },
  windows: [{ ...week(), source: { kind: "quota-axi", readAt: at } }],
  exhaustion: [
    {
      scope: "all",
      status: "known",
      runway: { status: "exhausted_now", limitingWindowId: "seven_day" },
    },
  ],
});

const block = (at: DateTime.Utc): QuotaBlock => ({ provider: "claude", title: "claude main", body: live(at) });

const glanceAt = (blocks: ReadonlyArray<QuotaBlock>, now: DateTime.Utc = dashboardNow): string => glanceLines({ blocks, now }).join("\n");

const glanceOf = (blocks: ReadonlyArray<QuotaBlock>): string => glanceAt(blocks);

const boxOf = (blocks: ReadonlyArray<QuotaBlock>): string => boxLines({ blocks }).join("\n");

const glance = (at: DateTime.Utc): string => glanceOf([block(at)]);

const quotaRow = (frame: string): string => {
  const row = frame.split("\n").find((line) => line.includes("  week "));
  if (row === undefined) throw new Error("no week row under claude main");
  return row;
};

describe("a quota-axi reading thirteen hours old on the dashboard", () => {
  test("shows its age in the row instead of used up or a live percentage", () => {
    expect(thirteenHoursMillis).toBeGreaterThan(logFreshMillis);
    const frame = glance(reportedAt);
    expect(quotaRow(frame)).toContain(ageText);
    expect(frame).not.toContain("used up");
    expect(quotaRow(frame)).not.toContain("%");
  });

  test("shows its age in the compact box instead of used up or a live percentage", () => {
    expect(thirteenHoursMillis).toBeGreaterThan(logFreshMillis);
    const frame = boxOf([block(reportedAt)]);
    expect(frame).toContain(ageText);
    expect(frame).not.toContain("used up");
    expect(quotaRow(frame)).not.toContain("%");
  });
});

const savedFetchedAt = DateTime.makeUnsafe("2026-10-13T07:18:16Z");
const freshSnapAt = DateTime.makeUnsafe("2026-10-13T07:19:16Z");
const freshSnapAgeSeconds = Math.floor((DateTime.toEpochMillis(freshSnapAt) - DateTime.toEpochMillis(savedFetchedAt)) / 1000);
const savedAgeSeconds = Math.floor((DateTime.toEpochMillis(dashboardNow) - DateTime.toEpochMillis(savedFetchedAt)) / 1000);
const savedAgeText = "read " + countdown(savedAgeSeconds) + " ago";

const saved = (): Extract<QuotaBlockBody, { kind: "saved" }> => ({
  kind: "saved",
  plan: "pro",
  stale: true,
  age: { kind: "dated", fetchedAt: savedFetchedAt, ageSeconds: savedAgeSeconds },
  windows: [{ label: "week", percentLeft: 0, resetsAt: DateTime.makeUnsafe("2026-10-16T17:00:00Z") }],
});

const savedBlock = (): QuotaBlock => ({ provider: "claude", title: "claude second", body: saved() });

const savedGlance = (): string => glanceOf([savedBlock()]);

describe("a saved claude profile thirteen hours old and stale on the dashboard", () => {
  test("shows its age in the row instead of used up or a live percentage", () => {
    expect(DateTime.toEpochMillis(dashboardNow) - DateTime.toEpochMillis(savedFetchedAt)).toBeGreaterThan(logFreshMillis);
    const frame = savedGlance();
    expect(frame).toContain(savedAgeText);
    expect(frame).not.toContain("used up");
    expect(quotaRow(frame)).not.toContain("0%");
    expect(quotaRow(frame)).not.toContain("%");
  });

  test("shows its age in the compact box instead of used up or a live percentage", () => {
    expect(DateTime.toEpochMillis(dashboardNow) - DateTime.toEpochMillis(savedFetchedAt)).toBeGreaterThan(logFreshMillis);
    const frame = boxOf([savedBlock()]);
    expect(frame).toContain(savedAgeText);
    expect(frame).not.toContain("used up");
    expect(quotaRow(frame)).not.toContain("0%");
    expect(quotaRow(frame)).not.toContain("%");
  });
});

describe("a saved claude profile restored from cache a day later on the dashboard", () => {
  test("recomputes its age from the reading timestamp instead of the cached age", () => {
    const fetchedAt = DateTime.makeUnsafe("2026-10-13T07:18:16Z");
    const cachedAt = DateTime.makeUnsafe("2026-10-13T20:18:16Z");
    const reopenedAt = DateTime.makeUnsafe("2026-10-14T08:18:16Z");
    const cachedAgeSeconds = Math.floor((DateTime.toEpochMillis(cachedAt) - DateTime.toEpochMillis(fetchedAt)) / 1000);
    const reopenedAgeSeconds = Math.floor((DateTime.toEpochMillis(reopenedAt) - DateTime.toEpochMillis(fetchedAt)) / 1000);
    const reopenedAgeText = "read " + countdown(reopenedAgeSeconds) + " ago";
    const staleAgeText = "read " + countdown(cachedAgeSeconds) + " ago";
    const body: QuotaBlockBody = {
      kind: "saved",
      plan: "pro",
      stale: true,
      age: { kind: "dated", fetchedAt, ageSeconds: cachedAgeSeconds },
      windows: [{ label: "week", percentLeft: 0, resetsAt: DateTime.makeUnsafe("2026-10-16T17:00:00Z") }],
    };
    const frame = glanceAt([{ provider: "claude", title: "claude second", body }], reopenedAt);
    expect(reopenedAgeSeconds).toBeGreaterThan(cachedAgeSeconds);
    expect(frame).toContain(reopenedAgeText);
    expect(frame).not.toContain("checked ");
    expect(frame).not.toContain(staleAgeText);
    expect(frame).not.toContain("used up");
    expect(quotaRow(frame)).not.toContain("0%");
    expect(quotaRow(frame)).not.toContain("%");
  });
});

describe("a saved claude profile cached fresh and reopened thirteen hours later on the dashboard", () => {
  test("reads stale from its timestamp instead of a live percentage", () => {
    const elapsed = DateTime.toEpochMillis(dashboardNow) - DateTime.toEpochMillis(savedFetchedAt);
    expect(elapsed).toBeGreaterThan(logFreshMillis);
    const body: QuotaBlockBody = {
      kind: "saved",
      plan: "pro",
      stale: false,
      age: { kind: "dated", fetchedAt: savedFetchedAt, ageSeconds: freshSnapAgeSeconds },
      windows: [{ label: "week", percentLeft: 0, resetsAt: DateTime.makeUnsafe("2026-10-16T17:00:00Z") }],
    };
    const frame = glanceAt([{ provider: "claude", title: "claude second", body }], dashboardNow);
    expect(frame).toContain(savedAgeText);
    expect(frame).not.toContain("checked ");
    expect(frame).not.toContain("used up");
    expect(quotaRow(frame)).not.toContain("0%");
    expect(quotaRow(frame)).not.toContain("%");
  });

  test("reads stale from its timestamp in the compact box instead of a live percentage", () => {
    const elapsed = DateTime.toEpochMillis(dashboardNow) - DateTime.toEpochMillis(savedFetchedAt);
    expect(elapsed).toBeGreaterThan(logFreshMillis);
    const body: QuotaBlockBody = {
      kind: "saved",
      plan: "pro",
      stale: false,
      age: { kind: "dated", fetchedAt: savedFetchedAt, ageSeconds: freshSnapAgeSeconds },
      windows: [{ label: "week", percentLeft: 0, resetsAt: DateTime.makeUnsafe("2026-10-16T17:00:00Z") }],
    };
    const frame = boxOf([{ provider: "claude", title: "claude second", body }]);
    expect(frame).toContain(savedAgeText);
    expect(frame).not.toContain("used up");
    expect(quotaRow(frame)).not.toContain("0%");
    expect(quotaRow(frame)).not.toContain("%");
  });
});

describe("a saved claude profile never checked on the dashboard", () => {
  test("keeps its window visible in the row instead of dropping it", () => {
    const body: QuotaBlockBody = {
      kind: "saved",
      plan: null,
      stale: false,
      age: { kind: "undated" },
      windows: [{ label: "week", percentLeft: 99, resetsAt: null }],
    };
    const frame = glanceAt([{ provider: "claude", title: "claude second", body }], dashboardNow);
    expect(frame).toContain("not checked yet");
    expect(quotaRow(frame)).toContain("99%");
  });

  test("keeps its window visible in the compact box instead of dropping it", () => {
    const body: QuotaBlockBody = {
      kind: "saved",
      plan: null,
      stale: false,
      age: { kind: "undated" },
      windows: [{ label: "week", percentLeft: 99, resetsAt: null }],
    };
    const frame = boxOf([{ provider: "claude", title: "claude second", body }]);
    expect(frame).toContain("not checked yet");
    expect(quotaRow(frame)).toContain("99%");
  });
});

describe("a claude block mixing a stale and a fresh window on the dashboard", () => {
  test("shows no reset on the stale row and keeps the fresh row's", () => {
    const freshAt = DateTime.makeUnsafe("2026-10-13T20:10:00Z");
    const resetsAt = DateTime.makeUnsafe("2026-10-16T17:00:00Z");
    const body: QuotaBlockBody = {
      kind: "live",
      plan: "max",
      reportedAt: freshAt,
      state: { status: "fresh", stale: false },
      windows: [
        { id: "five_hour", label: "session", kind: "session", percentRemaining: 50, resetsAt, source: { kind: "quota-axi", readAt: reportedAt } },
        { id: "seven_day", label: "week", kind: "weekly", percentRemaining: 31, resetsAt, source: { kind: "quota-axi", readAt: freshAt } },
      ],
      exhaustion: [],
    };
    const frame = glanceAt([{ provider: "claude", title: "claude main", body }], dashboardNow);
    const rows = frame.split("\n").filter((line) => line.includes("resets in"));
    expect(rows).toEqual([expect.stringMatching(/^ {2}week .*resets in 2d 20h$/u)]);
    expect(frame.split("\n").find((line) => line.startsWith("  5 hours "))).toMatch(/read 13h 0m ago$/u);
  });
});

describe("a quota-axi reading seconds old on the dashboard", () => {
  test("keeps its live percentage and its used up verdict", () => {
    expect(freshMillis).toBeLessThan(logFreshMillis);
    const frame = glance(freshReportedAt);
    expect(frame).toContain("used up");
    expect(quotaRow(frame)).toContain("0% left");
  });
});

describe("a stale reading's reset on the dashboard", () => {
  test("leaves the countdown off a live row read thirteen hours ago", () => {
    const row = quotaRow(glance(reportedAt));
    expect(row).toContain(ageText);
    expect(row).not.toContain("resets in");
    expect(row).not.toContain("3d 9h");
  });

  test("leaves the countdown off a live row read thirteen hours ago in the compact box", () => {
    const row = quotaRow(boxOf([block(reportedAt)]));
    expect(row).toContain(ageText);
    expect(row).not.toContain("3d 9h");
    expect(row).not.toContain("2d 20h");
  });

  test("leaves the countdown off a stale saved row", () => {
    const row = quotaRow(savedGlance());
    expect(row).toContain(savedAgeText);
    expect(row).not.toContain("resets in");
  });

  test("keeps the countdown on a live row read seconds ago", () => {
    expect(quotaRow(glance(freshReportedAt))).toContain("resets in 2d 20h");
  });
});

describe("a stale saved claude profile's header on the dashboard", () => {
  test("leaves the age to the row instead of repeating it", () => {
    const frame = savedGlance();
    expect(frame.split("\n")).toContainEqual(expect.stringMatching(/^● claude second · pro {2,}quota/u));
    expect(frame).not.toContain("checked");
    expect(quotaRow(frame)).toContain(savedAgeText);
  });

  test("leaves the age to the row in the compact box", () => {
    const frame = boxOf([savedBlock()]);
    expect(frame).not.toContain("checked");
    expect(quotaRow(frame)).toContain(savedAgeText);
  });

  test("keeps the age in the header when the profile holds no window", () => {
    const empty: QuotaBlock = { provider: "claude", title: "claude second", body: { ...saved(), windows: [] } };
    expect(glanceOf([empty])).toContain("checked " + countdown(savedAgeSeconds) + " ago");
  });

  test("keeps the age in a fresh profile's header", () => {
    const fetchedAt = DateTime.makeUnsafe("2026-10-13T19:48:16Z");
    const fresh: QuotaBlock = {
      provider: "claude",
      title: "claude second",
      body: { ...saved(), stale: false, age: { kind: "dated", fetchedAt, ageSeconds: 1800 } },
    };
    const frame = glanceOf([fresh]);
    expect(frame).toContain("checked 30m ago");
    expect(quotaRow(frame)).toContain("0%");
  });
});

// Claude main's week read 13 hours before the dashboard at 0 percent left, whose pace flagged three agents.
const staleWeekSessions = () =>
  sessionViewOfQuota(
    fixture("quota-axi/full.json")
      .replace(/"percentRemaining": 31,/u, '"percentRemaining": 0,')
      .replace('"refreshedAt": "2026-10-13T20:18:15.232Z"', '"refreshedAt": "2026-10-13T07:18:15.232Z"'),
    dashboardNow,
  );

const agentsGlance = (): ReadonlyArray<string> => glanceLines({ blocks: [], sessions: Option.some<SessionQuotaView>(staleWeekSessions()) });

describe("the agents column over a session quota week read thirteen hours ago", () => {
  test("shows the reading's age instead of the stale week's pace flags", () => {
    const rows = agentsGlance();
    expect(rows.join("\n")).not.toContain("claude main's week");
    expect(rows).toContain("! claude main's 5 hours and week read 13h 0m ago, too old to flag its agents");
  });

  test("keeps the flags of a limit read seconds ago", () => {
    expect(agentsGlance().filter((row) => row.startsWith("⚑ "))).toEqual(["⚑ my-home is spending over its share of opencode-go's month"]);
  });

  test("shows the reading's age instead of the stale week's pace flags in the compact box", () => {
    const frame = boxLines({ sessions: Option.some(staleWeekSessions()) }).join("\n");
    expect(frame).not.toContain("claude main's week");
    expect(frame).toContain("! claude main's 5 hours and week read 13h 0m ago, too");
  });
});
