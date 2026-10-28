import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import type { QuotaBlock, QuotaBlockBody, QuotaWindow } from "@tui-dash/schema";
import { logFreshMillis } from "@tui-dash/schema";
import { countdown, plain, quotaLines } from "@tui-dash/quota";

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

const savedFetchedAt = DateTime.makeUnsafe("2026-10-13T07:18:16Z");
const freshSnapAt = DateTime.makeUnsafe("2026-10-13T07:19:16Z");
const freshSnapAgeSeconds = Math.floor((DateTime.toEpochMillis(freshSnapAt) - DateTime.toEpochMillis(savedFetchedAt)) / 1000);
const savedAgeSeconds = Math.floor((DateTime.toEpochMillis(thirteenHoursLater) - DateTime.toEpochMillis(savedFetchedAt)) / 1000);
const savedAgeText = "read " + countdown(savedAgeSeconds) + " ago";

const saved = (): QuotaBlockBody => ({
  kind: "saved",
  plan: "pro",
  stale: true,
  age: { kind: "dated", fetchedAt: savedFetchedAt, ageSeconds: savedAgeSeconds },
  windows: [{ label: "week", percentLeft: 0, resetsAt: DateTime.makeUnsafe("2026-10-16T17:00:00Z") }],
});

const savedText = (now: DateTime.Utc): string => quotaLines([block(saved())], 84, true, now).map(plain).join("\n");

describe("a saved claude profile thirteen hours old and stale", () => {
  test("shows its age instead of a live percentage", () => {
    expect(DateTime.toEpochMillis(thirteenHoursLater) - DateTime.toEpochMillis(savedFetchedAt)).toBeGreaterThan(logFreshMillis);
    const frame = savedText(thirteenHoursLater);
    expect(frame).toContain(savedAgeText);
    expect(frame).not.toContain("used up");
    expect(frame).not.toContain("exhausted now");
    expect(frame).not.toContain("0%");
    expect(frame).not.toContain("%");
  });
});

describe("a saved claude profile restored from cache a day later", () => {
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
    const frame = quotaLines([{ provider: "claude", title: "claude main", body }], 84, true, reopenedAt).map(plain).join("\n");
    expect(reopenedAgeSeconds).toBeGreaterThan(cachedAgeSeconds);
    expect(frame).toContain(reopenedAgeText);
    expect(frame).not.toContain(staleAgeText);
    expect(frame).not.toContain("used up");
    expect(frame).not.toContain("%");
  });
});

describe("a saved claude profile cached fresh and reopened thirteen hours later", () => {
  test("reads stale from its timestamp instead of a live percentage", () => {
    const elapsed = DateTime.toEpochMillis(thirteenHoursLater) - DateTime.toEpochMillis(savedFetchedAt);
    expect(elapsed).toBeGreaterThan(logFreshMillis);
    const body: QuotaBlockBody = {
      kind: "saved",
      plan: "pro",
      stale: false,
      age: { kind: "dated", fetchedAt: savedFetchedAt, ageSeconds: freshSnapAgeSeconds },
      windows: [{ label: "week", percentLeft: 0, resetsAt: DateTime.makeUnsafe("2026-10-16T17:00:00Z") }],
    };
    const frame = quotaLines([{ provider: "claude", title: "claude main", body }], 84, true, thirteenHoursLater).map(plain).join("\n");
    expect(frame).toContain(savedAgeText);
    expect(frame).not.toContain("used up");
    expect(frame).not.toContain("exhausted now");
    expect(frame).not.toContain("0%");
    expect(frame).not.toContain("%");
  });
});

describe("a saved claude profile stale in a narrow quota panel", () => {
  test("shows its whole age instead of cutting it", () => {
    const frame = quotaLines([{ provider: "claude", title: "claude main", body: saved() }], 40, true, thirteenHoursLater)
      .map(plain)
      .join("\n");
    const row = frame.split("\n").find((line) => line.includes("week")) ?? "";
    expect(row).toContain(savedAgeText);
    expect(row).not.toContain("…");
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

  test("leaves the reset column blank on a stale saved row", () => {
    const row = weekRow(savedText(thirteenHoursLater));
    expect(row).toContain(savedAgeText);
    expect(row).not.toContain("2d 20h");
  });

  test("keeps the reset on a live row read thirty minutes ago", () => {
    expect(weekRow(text(thirtyMinutesLater))).toMatch(/ 3d 9h$/u);
  });
});
