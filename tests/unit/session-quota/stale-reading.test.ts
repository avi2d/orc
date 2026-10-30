import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { flagLines, sessionLines, sessionLinesWithin } from "@tui-dash/session-quota";
import { plain } from "@tui-dash/ui";
import { fixture } from "../../lib/fixtures";
import { fixtureSessionView, recordedNow, sessionViewOfQuota } from "../../lib/session-fixture";

const weekAtZero = fixture("quota-axi/full.json").replace(/"percentRemaining": 31,/u, '"percentRemaining": 0,');
const readThirteenHoursAgo = weekAtZero.replace('"refreshedAt": "2026-10-13T20:18:15.232Z"', '"refreshedAt": "2026-10-13T07:18:15.232Z"');

const panel = (quotaJson: string): ReadonlyArray<string> => sessionLines(sessionViewOfQuota(quotaJson, recordedNow), 84).map(plain);

const claudeMain = (rows: ReadonlyArray<string>): ReadonlyArray<string> =>
  rows.slice(rows.indexOf("● claude main · assumed the only login"), rows.indexOf("● codex · joined by credential key"));

describe("a session quota window read thirteen hours ago at 0 percent", () => {
  test("shows its age instead of 100 points used, the fair rate or the pace", () => {
    const rows = claudeMain(panel(readThirteenHoursAgo));
    expect(rows).toContain("7d window read 13h 0m ago");
    expect(rows).toContain("5h window read 13h 0m ago");
    expect(rows.join("\n")).not.toMatch(/pp used|fair|pace/u);
  });

  test("keeps each session's logged shares and drops the points scaled from the reading", () => {
    const rows = claudeMain(panel(readThirteenHoursAgo));
    expect(rows).toContainEqual(expect.stringMatching(/^● shop-a1b2c3\/1 w1A:p2 +51% {2}50%$/u));
    expect(rows.join("\n")).not.toContain("≤");
  });

  test("flags none of its sessions", () => {
    const rows = panel(readThirteenHoursAgo);
    expect(claudeMain(rows).join("\n")).not.toContain("⚑");
    const summary = flagLines(sessionViewOfQuota(readThirteenHoursAgo, recordedNow), 84, 40).map(plain);
    expect(summary.filter((row) => row.startsWith("⚑ "))).toEqual([expect.stringContaining("opencode-go 31d window")]);
  });

  test("keeps the points used and the flags when read seconds ago instead of reading every window as stale", () => {
    const rows = claudeMain(panel(weekAtZero));
    expect(rows).toContainEqual(expect.stringMatching(/^7d window 100pp used · /u));
    expect(rows.join("\n")).toContain("⚑");
  });
});

describe("an all-stale multi-account view on an 84 by 12 terminal", () => {
  test("shows a reading age in the compact summary instead of only the caption and no session flagged", () => {
    const now = DateTime.makeUnsafe("2026-10-14T08:18:16Z");
    const readAt = DateTime.makeUnsafe("2026-10-13T20:18:15.232Z");
    const ageMillis = DateTime.toEpochMillis(now) - DateTime.toEpochMillis(readAt);
    expect(ageMillis).toBeGreaterThan(3600000);
    const ageText = "read 12h 0m ago";
    const view = fixtureSessionView("quota-axi/full.json", now);
    expect(view.accounts.length).toBeGreaterThan(1);
    const frame = sessionLinesWithin(view, 84, 12, Number.POSITIVE_INFINITY, now).map(plain);
    expect(frame.length).toBeLessThanOrEqual(12);
    expect(frame.join("\n")).toContain(ageText);
    expect(frame.join("\n")).not.toContain("no session flagged");
  });
});
