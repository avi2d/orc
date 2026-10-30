import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { capturedOf, captureRecords, decodeSavedProfiles, decodeQuota, quotaBlocks } from "@tui-dash/schema";
import { plain, quotaLines } from "@tui-dash/quota";
import { fixture } from "../../lib/fixtures";
import { quotaAxiRead, recordedQuotaRead } from "../../lib/quota-read";

const now = DateTime.makeUnsafe("2026-10-16T19:28:55.289Z");

const blocks = () => {
  const quota = decodeQuota(fixture("quota-axi/schema-6.json"));
  const savedProfiles = decodeSavedProfiles(fixture("saved-profiles/status.json"));
  if (quota.kind !== "ok" || savedProfiles.kind !== "ok") throw new Error("the fixtures do not decode");
  return quotaBlocks(quotaAxiRead({ ...quota, capturedAt: now }), { ...savedProfiles, capturedAt: now }, now);
};

const styleOf = (text: string) =>
  quotaLines(blocks(), 84, true, now)
    .flatMap((line) => line)
    .find((part) => part.text.includes(text))?.style;

describe("the quota panel, against the recorded schema-6 replay", () => {
  test("headers name one block per account, leaving the default filler out", () => {
    const headers = quotaLines(blocks(), 84, true, now).map(plain).filter((line) => line.startsWith("●"));
    expect(headers).toEqual([
      "● claude main · max",
      "● claude second · pro",
      "● codex codex-home · plus",
      "● codex openai-codex · plus",
      "● opencode-go",
    ]);
  });

  test("each account row shows its own numbers", () => {
    const rows = quotaLines(blocks(), 84, true, now).map(plain);
    const weekOf = (header: string): string => {
      const start = rows.findIndex((row) => row === header);
      const week = rows.slice(start).find((row) => row.startsWith("week"));
      if (week === undefined) throw new Error("no week row under " + header);
      return week;
    };
    expect(weekOf("● codex codex-home · plus")).toContain("52%");
    expect(weekOf("● codex openai-codex · plus")).toContain("20%");
  });

  test("an early projection reads muted with its reason, an established one still warns", () => {
    expect(styleOf("empty in 3d 8h · early")).toEqual({ tone: "muted" });
    expect(styleOf("empty in 20d")).toEqual({ tone: "warning", bold: true });
  });
});

// Claude Code's statusline reports used_percentage, so 23 used is 77 left.
describe("the quota panel, with an account's statusline reading", () => {
  const main = { name: "main", folder: "/home/tester/.claude-accounts/main" };
  const second = { name: "second", folder: "/home/tester/.claude-accounts/second" };
  const reading = {
    schemaVersion: 1,
    kind: "claude-code-reading",
    at: "2026-10-16T19:20:00.000Z",
    sessionId: "c1",
    cwd: "/home/tester/notes",
    claudeHome: main.folder,
    totalApiDurationMs: 1000,
    windows: [
      { window: "five_hour", usedPercent: 23, resetsAt: "2026-10-16T22:00:00.000Z" },
      { window: "seven_day", usedPercent: 41, resetsAt: "2026-10-20T10:00:00.000Z" },
    ],
  };
  const records = captureRecords(JSON.stringify(reading));
  const captured = capturedOf([{ path: "/state/2026-10-16.jsonl", records }], { "claude-code": 0 }, "/home/tester/.claude/projects", [main, second]);
  const noProfiles = { kind: "ok", value: { schema: 2, active_profile: null, profiles: [] }, capturedAt: now } as const;
  const rows = quotaLines(
    quotaBlocks(recordedQuotaRead(fixture("quota-axi/schema-6.json"), now, [], captured), noProfiles, now),
    84,
    true,
    now,
  ).map(plain);
  const blockOf = (header: string): ReadonlyArray<string> => {
    const start = rows.indexOf(header);
    if (start === -1) throw new Error("no block " + header);
    const end = rows.findIndex((row, index) => index > start && row.startsWith("●"));
    return rows.slice(start + 1, end === -1 ? undefined : end);
  };

  test("draws the reading on the account whose folder took it, from the statusline", () => {
    const block = blockOf("● claude main");
    expect(block[0]).toBe("  session, week from claude code statusline 8m ago");
    expect(block.find((row) => row.startsWith("session"))).toContain("77%");
    expect(block.find((row) => row.startsWith("week"))).toContain("59%");
  });

  test("leaves the other account's block without a reading", () => {
    expect(blockOf("● claude second")).toEqual(["no statusline reading in the last hour"]);
  });
});

// Oracle: the replacement plan's step 3a, which reads the bridge's headless rate_limit_event entries from the usage
// ledger, tagged by config folder. The recorded SDK turn carries 0.14 and 0.01 utilization, so 86 and 99 are left.
// Rejects main's reading drawn on second's block, and a headless join named beside its source line.
describe("the quota panel, with an account's headless reading", () => {
  const main = { name: "main", folder: "/home/tester/.claude-accounts/main" };
  const second = { name: "second", folder: "/home/tester/.claude-accounts/second" };
  const reading = {
    schemaVersion: 1,
    kind: "claude-headless-reading",
    at: "2026-10-16T19:20:00.000Z",
    sessionId: "h1",
    claudeHome: main.folder,
    windows: [
      { window: "five_hour", usedPercent: 14, resetsAt: "2026-10-16T22:00:00.000Z" },
      { window: "seven_day", usedPercent: 1, resetsAt: "2026-10-20T10:00:00.000Z" },
    ],
  };
  const records = captureRecords(JSON.stringify(reading));
  const captured = capturedOf([{ path: "/state/2026-10-16.jsonl", records }], { "claude-code": 0 }, "/home/tester/.claude/projects", [main, second]);
  const noProfiles = { kind: "ok", value: { schema: 2, active_profile: null, profiles: [] }, capturedAt: now } as const;
  const rows = quotaLines(
    quotaBlocks(recordedQuotaRead(fixture("quota-axi/schema-6.json"), now, [], captured), noProfiles, now),
    84,
    true,
    now,
  ).map(plain);
  const blockOf = (header: string): ReadonlyArray<string> => {
    const start = rows.indexOf(header);
    if (start === -1) throw new Error("no block " + header);
    const end = rows.findIndex((row, index) => index > start && row.startsWith("●"));
    return rows.slice(start + 1, end === -1 ? undefined : end);
  };

  test("draws the reading on the account whose folder took it, from headless", () => {
    const block = blockOf("● claude main");
    expect(block[0]).toBe("  session, week from claude code headless 8m ago");
    expect(block.find((row) => row.startsWith("session"))).toContain("86%");
    expect(block.find((row) => row.startsWith("week"))).toContain("99%");
  });

  test("leaves the other account's block without a reading", () => {
    expect(blockOf("● claude second")).toEqual(["no statusline reading in the last hour"]);
  });
});

