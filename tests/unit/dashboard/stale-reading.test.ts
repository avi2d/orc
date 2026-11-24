import { describe, expect, test } from "bun:test";
import { DateTime, Option } from "effect";
import type { QuotaBlock, QuotaBlockBody, QuotaWindow, SessionQuotaView } from "@avi2dg/orc-schema";
import { logFreshMillis } from "@avi2dg/orc-schema";
import { countdown } from "@avi2dg/orc-ui";
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

  test("keeps the countdown on a live row read seconds ago", () => {
    expect(quotaRow(glance(freshReportedAt))).toContain("resets in 2d 20h");
  });
});

// Claude's week read 13 hours before the dashboard at 0 percent left, whose pace flagged three agents.
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
