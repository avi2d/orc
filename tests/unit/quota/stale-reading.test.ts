import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import type { QuotaBlock, QuotaBlockBody, QuotaWindow } from "@avi2dg/orc-schema";
import { logFreshMillis } from "@avi2dg/orc-schema";
import { countdown, plain, quotaLines } from "@avi2dg/orc-quota";

const reportedAt = DateTime.makeUnsafe("2026-10-13T07:18:16Z");
const thirteenHoursLater = DateTime.makeUnsafe("2026-10-13T20:18:16Z");
const thirtyMinutesLater = DateTime.makeUnsafe("2026-10-13T07:48:16Z");

const thirteenHoursMillis = DateTime.toEpochMillis(thirteenHoursLater) - DateTime.toEpochMillis(reportedAt);
const thirtyMinutesMillis = DateTime.toEpochMillis(thirtyMinutesLater) - DateTime.toEpochMillis(reportedAt);
const ageText = "read " + countdown(thirteenHoursMillis / 1000) + " ago";

const week = (): QuotaWindow => ({
  id: "seven_day",
  label: "week",
  kind: "weekly",
  percentRemaining: 0,
  resetsAt: DateTime.makeUnsafe("2026-10-16T17:00:00Z"),
  pace: { status: "ahead", cycleSeconds: 604800 },
});

const live = (): QuotaBlockBody => ({
  kind: "live",
  plan: "max",
  reportedAt,
  state: { status: "fresh", stale: false },
  windows: [{ ...week(), source: { kind: "quota-axi", readAt: reportedAt } }],
  exhaustion: [
    {
      scope: "all",
      status: "known",
      runway: { status: "exhausted_now", limitingWindowId: "seven_day" },
    },
  ],
});

const block = (body: QuotaBlockBody): QuotaBlock => ({ provider: "claude", title: "claude main", body });

const text = (now: DateTime.Utc): string => quotaLines([block(live())], 84, true, now).map(plain).join("\n");

describe("a quota-axi reading thirteen hours old", () => {
  test("shows its age instead of a live percentage or an exhausted verdict", () => {
    expect(thirteenHoursMillis).toBeGreaterThan(logFreshMillis);
    const frame = text(thirteenHoursLater);
    expect(frame).toContain(ageText);
    expect(frame).not.toContain("exhausted now");
    expect(frame).not.toContain("used up");
    expect(frame).not.toContain("%");
  });
});

describe("a quota-axi reading thirty minutes old", () => {
  test("keeps its live percentage and its exhausted verdict", () => {
    expect(thirtyMinutesMillis).toBeLessThan(logFreshMillis);
    const frame = text(thirtyMinutesLater);
    expect(frame).toContain("0%");
    expect(frame).toContain("exhausted now");
  });
});
const weekRow = (frame: string): string => frame.split("\n").find((line) => line.startsWith("week ")) ?? "";

describe("a stale reading's reset in the quota panel", () => {
  // A stale reading's reset point is not trusted, so the reset column stays blank.
  test("leaves the reset column blank on a live row read thirteen hours ago", () => {
    const row = weekRow(text(thirteenHoursLater));
    expect(row).toContain(ageText);
    expect(row).not.toContain("3d 9h");
    expect(row).not.toContain("2d 20h");
  });

  test("keeps the reset on a live row read thirty minutes ago", () => {
    expect(weekRow(text(thirtyMinutesLater))).toMatch(/ 3d 9h$/u);
  });
});
