import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import type { QuotaBlock } from "@tui-dash/schema";
import { dashboardNow } from "../../lib/dashboard-fixture";
import { boxLines, glanceLines } from "../../lib/host-fixture";

const threeMinutesBefore = DateTime.subtract(dashboardNow, { minutes: 3 });

// quota-axi's answer when the Claude endpoint refuses the check: its last reading from the cache, marked stale.
const refusedClaude = (refreshedAt: DateTime.Utc | undefined): QuotaBlock => ({
  provider: "claude",
  title: "claude second",
  body: {
    kind: "live",
    plan: "max",
    reportedAt: dashboardNow,
    state: {
      status: "stale",
      stale: true,
      error: "Claude quota endpoint rate limited",
      ...(refreshedAt === undefined ? {} : { refreshedAt }),
    },
    windows: [
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentRemaining: 62,
        resetsAt: DateTime.add(dashboardNow, { hours: 2 }),
        source: { kind: "quota-axi", readAt: refreshedAt ?? dashboardNow },
      },
    ],
    exhaustion: [],
  },
});

const glance = (block: QuotaBlock): string => glanceLines({ blocks: [block] }).join("\n");

const compact = (block: QuotaBlock): string => boxLines({ blocks: [block] }).join("\n");

describe("a Claude reading quota-axi served from its cache after the check was refused", () => {
  test("shows how long ago it was checked in the quota panel, not that it is out of date", () => {
    const frame = glance(refusedClaude(threeMinutesBefore));
    expect(frame).toContain("checked 3m ago");
    expect(frame).not.toContain("out of date");
    expect(frame).toContain("62%");
  });

  test("shows how long ago it was checked in the compact box, not that it is out of date", () => {
    const frame = compact(refusedClaude(threeMinutesBefore));
    expect(frame).toContain("checked 3m ago");
    expect(frame).not.toContain("out of date");
  });

  test("still says it is out of date when quota-axi gives no time it was read", () => {
    const frame = glance(refusedClaude(undefined));
    expect(frame).toContain("reading out of date");
    expect(frame).not.toContain("checked");
  });
});

describe("a non-Claude reading marked stale", () => {
  test("keeps the out-of-date warning in the quota panel", () => {
    const frame = glance({ ...refusedClaude(threeMinutesBefore), provider: "codex", title: "codex" });
    expect(frame).toContain("reading out of date");
    expect(frame).not.toContain("checked");
  });

  test("keeps the out-of-date warning in the compact box", () => {
    const frame = compact({ ...refusedClaude(threeMinutesBefore), provider: "codex", title: "codex" });
    expect(frame).toContain("reading out of date");
    expect(frame).not.toContain("checked");
  });
});
