import { describe, expect, test } from "bun:test";
import { DateTime, type Schema } from "effect";
import {
  capturedOf,
  captureRecords,
  ClaudeStatuslineInput,
  countedCalls,
  decodeJson,
  expiredDayFiles,
  type LedgerFile,
  type LogFile,
  logRecords,
  PiCallInput,
  piCallRecord,
  resolveSessions,
  statuslineRecord,
  sumTokens,
  tokenTotal,
  withCaptured,
} from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";

const at = (iso: string): number => Date.parse(iso);

const decoded = <A>(schema: Schema.Decoder<A>, text: string): A => {
  const input = decodeJson(schema)(text);
  if (input.kind !== "ok") throw new Error(input.issue);
  return input.value;
};

const ledgerOf = (path: string, lines: ReadonlyArray<unknown>): LedgerFile => ({
  path,
  records: captureRecords(lines.map((line) => JSON.stringify(line)).join("\n")),
});

const everything = { pi: 0, "claude-code": 0, codex: 0 };

describe("piCallRecord, from the fields of Pi's assistant message, stamped with the message's own time, not the entry time", () => {
  const input = decoded(PiCallInput, fixture("capture/pi-message-end.json"));
  const now = DateTime.makeUnsafe("2026-10-17T10:00:16.020Z");

  test("keeps the session, provider, model, the message's own stamp and the four token counts", () => {
    expect(piCallRecord(input, now)).toEqual({
      schemaVersion: 1,
      kind: "pi-call",
      at: now,
      sessionId: "aaaaaaaa-0000-4000-8000-00000000a0c1",
      sessionFile: "/home/tester/.pi/agent/sessions/--home-tester-shop--/2026-10-17T10-00-00-000Z_aaaaaaaa-0000-4000-8000-00000000a0c1.jsonl",
      cwd: "/home/tester/shop",
      provider: "claude-bridge",
      model: "claude-opus-5-5",
      messageAt: DateTime.makeUnsafe("2026-10-17T10:00:08.000Z"),
      tokens: { input: 3, output: 120, cacheRead: 40000, cacheWrite: 500 },
    });
  });

  test("never holds the message's content", () => {
    const record = piCallRecord(input, now);
    expect(JSON.stringify(record)).not.toContain("never hold");
    expect(Object.keys(record ?? {})).not.toContain("content");
  });

  test("writes nothing for a message that spent no tokens", () => {
    expect(piCallRecord({ ...input, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, now)).toBeUndefined();
  });
});

describe("statuslineRecord, from Claude Code's statusline input, used_percentage read as used and resets_at in seconds", () => {
  const input = decoded(ClaudeStatuslineInput, fixture("capture/claude-statusline.json"));
  const now = DateTime.makeUnsafe("2026-10-17T10:05:00Z");

  test("keeps both windows' used percent and reset, the session and the API time", () => {
    expect(statuslineRecord(input, now, "/home/tester/.claude/")).toEqual({
      schemaVersion: 1,
      kind: "claude-code-reading",
      at: now,
      sessionId: "cccccccc-0000-4000-8000-0000000c0de1",
      cwd: "/home/tester/notes",
      claudeHome: "/home/tester/.claude",
      totalApiDurationMs: 42000,
      windows: [
        { window: "five_hour", usedPercent: 23, resetsAt: DateTime.makeUnsafe("2026-10-17T14:00:00Z") },
        { window: "seven_day", usedPercent: 41, resetsAt: DateTime.makeUnsafe("2026-10-21T17:00:00Z") },
      ],
    });
  });

  test("holds none of the statusline's model, cost or context numbers", () => {
    const text = JSON.stringify(statuslineRecord(input, now, "/home/tester/.claude"));
    for (const absent of ["Opus", "total_cost_usd", "1.25", "49988", "transcript"]) expect(text).not.toContain(absent);
  });

  test("is no reading before Claude Code's first response, when it passes no rate limits", () => {
    const { rate_limits: _, ...before } = input;
    expect(statuslineRecord(before, now, "/home/tester/.claude")).toBeUndefined();
  });
});

const headlessLine = (minute: string, used: number, session = "h1", claudeHome = "/home/tester/.claude") => ({
  schemaVersion: 1,
  kind: "claude-headless-reading",
  at: `2026-10-17T10:${minute}:00.000Z`,
  sessionId: session,
  claudeHome,
  windows: [{ window: "five_hour", usedPercent: used, resetsAt: "2026-10-17T14:00:00.000Z" }],
});

const statuslineLine = (minute: string, used: number, apiMillis: number, session = "c1", claudeHome = "/home/tester/.claude") => ({
  schemaVersion: 1,
  kind: "claude-code-reading",
  at: `2026-10-17T10:${minute}:00.000Z`,
  sessionId: session,
  cwd: "/home/tester/notes",
  claudeHome,
  totalApiDurationMs: apiMillis,
  windows: [{ window: "five_hour", usedPercent: used, resetsAt: "2026-10-17T14:00:00.000Z" }],
});

describe("capturedOf, reading the statusline's Claude readings back, an idle session's repeat keeps its first date", () => {
  const projects = "/home/tester/.claude/projects";

  test("dates an idle session's repeated reading by its first sighting, and a new response by its own", () => {
    const ledger = ledgerOf("/state/2026-10-17.jsonl", [
      statuslineLine("00", 20, 1000),
      statuslineLine("01", 20, 1000),
      statuslineLine("40", 20, 1000),
      statuslineLine("41", 21, 2000),
    ]);
    const readings = capturedOf([ledger], everything, projects, []).readings;
    expect(readings.map((reading) => [reading.percentRemaining, new Date(reading.observedAt).toISOString()])).toEqual([
      [80, "2026-10-17T10:00:00.000Z"],
      [79, "2026-10-17T10:41:00.000Z"],
    ]);
    expect(readings[0]).toMatchObject({
      provider: "claude",
      harness: "claude-code",
      via: "statusline",
      credentialKey: undefined,
      windowId: "five_hour",
      cycleSeconds: 18_000,
      resetsAt: at("2026-10-17T14:00:00Z"),
      file: "/state/2026-10-17.jsonl",
    });
  });

  test("keeps a repeat that follows a response, since the API time moved", () => {
    const ledger = ledgerOf("/state/2026-10-17.jsonl", [statuslineLine("00", 20, 1000), statuslineLine("30", 20, 1500)]);
    expect(capturedOf([ledger], everything, projects, []).readings.map((reading) => reading.observedAt)).toEqual([
      at("2026-10-17T10:00:00Z"),
      at("2026-10-17T10:30:00Z"),
    ]);
  });

  test("keeps only the readings taken under the Claude home whose logs this reader reads, never a pinned worker's account reading charged to the default login", () => {
    const ledger = ledgerOf("/state/2026-10-17.jsonl", [
      statuslineLine("00", 20, 1000),
      statuslineLine("01", 70, 1000, "w1", "/home/tester/work-claude"),
    ]);
    expect(capturedOf([ledger], everything, projects, []).readings.map((reading) => reading.percentRemaining)).toEqual([80]);
    expect(capturedOf([ledger], everything, "/home/tester/work-claude/projects", []).readings.map((reading) => reading.percentRemaining)).toEqual([30]);
  });

  test("keys a reading taken under an account's folder by that account's name, and gives it to no other, not to second or the shared home", () => {
    const main = { name: "main", folder: "/home/tester/.claude-accounts/main" };
    const second = { name: "second", folder: "/home/tester/.claude-accounts/second" };
    const ledger = ledgerOf("/state/2026-10-17.jsonl", [
      statuslineLine("00", 20, 1000),
      statuslineLine("01", 70, 1000, "w1", main.folder),
      statuslineLine("02", 70, 1000, "w1", main.folder),
    ]);
    const captured = capturedOf([ledger], everything, projects, [main, second]);
    expect(captured.readings.map((reading) => [reading.percentRemaining, reading.credentialKey])).toEqual([[80, undefined]]);
    expect(
      captured.accounts.map((account) => [account.name, account.readings.map((reading) => [reading.percentRemaining, reading.credentialKey, reading.observedAt])]),
    ).toEqual([
      ["main", [[30, "main", at("2026-10-17T10:01:00Z")]]],
      ["second", []],
    ]);
  });

  test("lists every account, with no reading while the read asks nothing of Claude Code", () => {
    const main = { name: "main", folder: "/home/tester/.claude-accounts/main" };
    const ledger = ledgerOf("/state/2026-10-17.jsonl", [statuslineLine("01", 70, 1000, "w1", main.folder)]);
    expect(capturedOf([ledger], { pi: 0 }, projects, [main]).accounts).toEqual([{ name: "main", readings: [] }]);
  });

  test("reads no reading when the read asks nothing of Claude Code, and none older than it asks", () => {
    const ledger = ledgerOf("/state/2026-10-17.jsonl", [statuslineLine("00", 20, 1000), statuslineLine("41", 21, 2000)]);
    expect(capturedOf([ledger], { pi: 0 }, projects, []).readings).toEqual([]);
    const since = { "claude-code": at("2026-10-17T10:30:00Z") };
    expect(capturedOf([ledger], since, projects, []).readings.map((reading) => reading.percentRemaining)).toEqual([79]);
  });

  test("skips a torn line, a line of another version and a line that is not JSON", () => {
    const text = [
      JSON.stringify(statuslineLine("00", 20, 1000)),
      JSON.stringify({ ...statuslineLine("01", 30, 2000), schemaVersion: 2 }),
      '{"schemaVersion":1,"kind":"pi-call"',
      "not json",
    ].join("\n");
    expect(captureRecords(text)).toHaveLength(1);
  });
});

describe("capturedOf, reading the bridge's headless rate-limit entries back", () => {
  const projects = "/home/tester/.claude/projects";
  const main = { name: "main", folder: "/home/tester/.claude-accounts/main" };

  test("keeps every headless event as its own observation even when its numbers repeat", () => {
    const ledger = ledgerOf("/state/2026-10-17.jsonl", [
      headlessLine("00", 14),
      headlessLine("01", 14),
      headlessLine("41", 15),
    ]);
    const readings = capturedOf([ledger], everything, projects, []).readings;
    expect(readings.map((reading) => [reading.via, reading.percentRemaining, new Date(reading.observedAt).toISOString()])).toEqual([
      ["headless", 86, "2026-10-17T10:00:00.000Z"],
      ["headless", 86, "2026-10-17T10:01:00.000Z"],
      ["headless", 85, "2026-10-17T10:41:00.000Z"],
    ]);
    expect(readings[0]).toMatchObject({
      provider: "claude",
      harness: "claude-code",
      credentialKey: undefined,
      windowId: "five_hour",
      cycleSeconds: 18_000,
      resetsAt: at("2026-10-17T14:00:00Z"),
      file: "/state/2026-10-17.jsonl",
    });
  });

  test("keys a headless reading taken under an account's folder by that account's name, beside a statusline one", () => {
    const ledger = ledgerOf("/state/2026-10-17.jsonl", [
      statuslineLine("00", 20, 1000),
      headlessLine("01", 30, "w1", main.folder),
    ]);
    const captured = capturedOf([ledger], everything, projects, [main]);
    expect(captured.readings.map((reading) => [reading.via, reading.percentRemaining])).toEqual([["statusline", 80]]);
    expect(
      captured.accounts.map((account) => [account.name, account.readings.map((reading) => [reading.via, reading.percentRemaining, reading.credentialKey])]),
    ).toEqual([["main", [["headless", 70, "main"]]]]);
  });

  test("reads a headless line of another version as no reading", () => {
    const text = [JSON.stringify({ ...headlessLine("00", 14), schemaVersion: 2 })].join("\n");
    expect(captureRecords(text)).toHaveLength(0);
  });
});

describe("withCaptured, counting the ledger's Pi calls beside the logs, each Pi call counted once", () => {
  const messageStarts = ["2026-10-16T10:00:58.000Z", "2026-10-16T10:01:58.000Z"] as const;
  const piPath = "/home/a/.pi/agent/sessions/--work-alpha--/s1.jsonl";
  const piText = fixture("session-logs/appendix-c/pi.jsonl")
    .split("\n")
    .map((line) => {
      if (!line.includes('"usage"')) return line;
      const start = line.includes('"input":2') ? messageStarts[0] : messageStarts[1];
      return line.replace('"usage"', `"timestamp":${at(start)},"usage"`);
    })
    .join("\n");
  const piLog: LogFile = { path: piPath, harness: "pi", modifiedAt: 0, records: logRecords("pi", piText) };
  const claudeLog: LogFile = {
    path: "/home/a/.claude/projects/-work-alpha/c.jsonl",
    harness: "claude-code",
    modifiedAt: 0,
    records: logRecords("claude-code", fixture("session-logs/appendix-c/claude-code.jsonl")),
  };
  const usages = [
    { input: 2, output: 100, cacheRead: 5000, cacheWrite: 300 },
    { input: 1, output: 50, cacheRead: 7000, cacheWrite: 0 },
  ];
  const ended = ["2026-10-16T10:01:00.020Z", "2026-10-16T10:02:00.020Z"];
  const capturedCalls = (file: string | null) =>
    capturedOf(
      [
        ledgerOf(
          "/state/2026-10-16.jsonl",
          usages.map((tokens, index) => ({
            schemaVersion: 1,
            kind: "pi-call",
            at: ended[index],
            sessionId: "s1",
            sessionFile: file,
            cwd: "/work/alpha",
            provider: "claude-bridge",
            model: "claude-opus-5-5",
            messageAt: messageStarts[index],
            tokens,
          })),
        ),
      ],
      everything,
      "/home/a/.claude/projects",
      [],
    ).calls;
  const total = (files: ReadonlyArray<LogFile>) => tokenTotal(sumTokens(countedCalls(files).calls.map((call) => call.tokens)));

  test("counts a call the ledger and the Pi log both hold once, 13387 machine-wide", () => {
    const files = withCaptured([piLog, claudeLog], capturedCalls(piPath));
    expect(total(files)).toBe(13387);
    expect(total(files)).not.toBe(25840);
    expect(countedCalls(files).bridgeCopiesDropped).toBe(2);
  });

  test("still drops the Claude Code copies of the bridge calls when only the ledger holds them", () => {
    const files = withCaptured([claudeLog], capturedCalls(piPath));
    expect(total(files)).toBe(13387);
    expect(total(files)).not.toBe(25840);
    expect(countedCalls(files).calls.map((call) => [call.file, call.route, tokenTotal(call.tokens)])).toEqual([
      [piPath, "claude-bridge", 5402],
      [piPath, "claude-bridge", 7051],
      ["/home/a/.claude/projects/-work-alpha/c.jsonl", "claude-code", 934],
    ]);
  });

  test("falls back to the logs alone where the ledger holds nothing", () => {
    expect(total(withCaptured([piLog, claudeLog], []))).toBe(13387);
  });

  test("keeps a call the ledger missed, counting it from the log", () => {
    expect(total(withCaptured([piLog, claudeLog], capturedCalls(piPath).slice(0, 1)))).toBe(13387);
  });

  test("names a session that keeps no file by its id, in the working directory it ran in", () => {
    const files = withCaptured([], capturedCalls(null));
    expect(files.map((file) => [file.path, file.harness])).toEqual([["pi-session:s1", "pi"]]);
    const live = { home: "/home/a", roots: { pi: "/p", "claude-code": "/c", codex: "/x" }, panes: [], processes: [] };
    const resolved = resolveSessions(files, countedCalls(files).calls, live);
    expect(resolved.sessions.map((session) => [session.id, session.cwd, session.identity.kind])).toEqual([
      ["file:pi-session:s1", "/work/alpha", "ended"],
    ]);
  });
});

describe("the ledger's day files, kept for 31 days and not pruned at a week", () => {
  const names = ["2026-09-14.jsonl", "2026-09-15.jsonl", "2026-09-16.jsonl", "2026-10-17.jsonl", "notes.txt", "2026-9-1.jsonl"];
  const now = at("2026-10-17T09:00:00Z");

  test("prune only the days older than the month the longest window reaches back", () => {
    expect(expiredDayFiles(names, now)).toEqual(["2026-09-14.jsonl"]);
  });
});
