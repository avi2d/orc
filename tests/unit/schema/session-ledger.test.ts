import { describe, expect, test } from "bun:test";
import { countedCalls, type Harness, type LogFile, logRecords, sumTokens, tokenTotal } from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";

const fileOf = (path: string, harness: Harness, text: string): LogFile => ({
  path,
  harness,
  modifiedAt: 0,
  records: logRecords(harness, text),
});

const appendixC = (): ReadonlyArray<LogFile> => [
  fileOf("/home/a/.pi/agent/sessions/--work-alpha--/s1.jsonl", "pi", fixture("session-logs/appendix-c/pi.jsonl")),
  fileOf(
    "/home/a/.claude/projects/-work-alpha/c.jsonl",
    "claude-code",
    fixture("session-logs/appendix-c/claude-code.jsonl"),
  ),
];

const countedTotal = (files: ReadonlyArray<LogFile>): number =>
  tokenTotal(sumTokens(countedCalls(files).calls.map((call) => call.tokens)));

describe("countedCalls, against the investigation's counting fixture", () => {
  test("the fixture's Claude Code lines really sum to the inflated 31242", () => {
    const lines = logRecords("claude-code", fixture("session-logs/appendix-c/claude-code.jsonl"));
    const lineSum = lines.reduce((sum, record) => sum + ("tokens" in record ? tokenTotal(record.tokens) : 0), 0);
    expect(lineSum).toBe(31242);
  });

  test("counts every call once machine-wide, 13387 tokens, and never the line sum", () => {
    expect(countedTotal(appendixC())).toBe(13387);
    expect(countedTotal(appendixC())).not.toBe(31242);
  });

  test("keeps the two Pi bridge calls and drops their two Claude Code twins", () => {
    const ledger = countedCalls(appendixC());
    expect(ledger.bridgeCopiesDropped).toBe(2);
    expect(ledger.calls.map((call) => [call.harness, call.route, tokenTotal(call.tokens)])).toEqual([
      ["pi", "claude-bridge", 5402],
      ["pi", "claude-bridge", 7051],
      ["claude-code", "claude-code", 934],
    ]);
  });

  test("drops the three repeated content-block lines and the zero-usage synthetic row", () => {
    const ledger = countedCalls(appendixC());
    expect(ledger.repeatedLinesDropped).toBe(3);
    expect(ledger.emptyRowsDropped).toBe(1);
  });

  test("charges every call to the claude quota", () => {
    expect(new Set(countedCalls(appendixC()).calls.map((call) => call.quota))).toEqual(new Set(["claude"]));
  });
});

const piLine = (timestamp: string, provider: string, usage: Record<string, number>): string =>
  JSON.stringify({ type: "message", timestamp, message: { role: "assistant", provider, model: "m", usage } });

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});

describe("countedCalls on Pi sessions", () => {
  test("counts a call a fork copied into a later file once, in the earlier file", () => {
    const copied = piLine("2026-10-16T10:01:00.000Z", "opencode-go", usage(10, 20, 30, 40));
    const ledger = countedCalls([
      fileOf("/s/--w--/2026-10-16T11-00_b.jsonl", "pi", [copied, piLine("2026-10-16T11:01:00.000Z", "opencode-go", usage(1, 1, 1, 1))].join("\n")),
      fileOf("/s/--w--/2026-10-16T10-00_a.jsonl", "pi", copied),
    ]);
    expect(ledger.forkCopiesDropped).toBe(1);
    expect(ledger.calls.map((call) => [call.file, tokenTotal(call.tokens)])).toEqual([
      ["/s/--w--/2026-10-16T10-00_a.jsonl", 100],
      ["/s/--w--/2026-10-16T11-00_b.jsonl", 4],
    ]);
  });

  test("names each provider's quota, and the Codex Pi key as the credential", () => {
    const at = (minute: number) => `2026-10-16T10:0${minute}:00.000Z`;
    const ledger = countedCalls([
      fileOf(
        "/s/--w--/a.jsonl",
        "pi",
        [
          piLine(at(1), "anthropic", usage(1, 0, 0, 0)),
          piLine(at(2), "openai-codex", usage(2, 0, 0, 0)),
          piLine(at(3), "openai-codex-work", usage(3, 0, 0, 0)),
          piLine(at(4), "opencode-go", usage(4, 0, 0, 0)),
          piLine(at(5), "openai", usage(5, 0, 0, 0)),
        ].join("\n"),
      ),
    ]);
    expect(ledger.calls.map((call) => [call.route, call.quota, call.credentialKey])).toEqual([
      ["anthropic", "claude", undefined],
      ["openai-codex", "codex", "openai-codex"],
      ["openai-codex-work", "codex", "openai-codex-work"],
      ["opencode-go", "opencode-go", undefined],
      ["openai", undefined, undefined],
    ]);
  });

  test("skips a zero-usage message, a user message and a line that is not JSON", () => {
    const text = [
      piLine("2026-10-16T10:01:00.000Z", "opencode-go", usage(0, 0, 0, 0)),
      JSON.stringify({ type: "message", timestamp: "2026-10-16T10:02:00.000Z", message: { role: "user", usage: "no" } }),
      '{"type":"message","usage"',
    ].join("\n");
    expect(countedCalls([fileOf("/s/--w--/a.jsonl", "pi", text)]).calls).toEqual([]);
  });
});

const tokenCount = (timestamp: string, total: number, last: number | undefined): string =>
  JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, total_tokens: total },
        ...(last === undefined
          ? {}
          : { last_token_usage: { input_tokens: last, cached_input_tokens: 0, output_tokens: 0, total_tokens: last } }),
      },
      rate_limits: null,
    },
  });

const codexTotal = (lines: ReadonlyArray<string>): number =>
  countedTotal([fileOf("/c/rollout-a.jsonl", "codex", lines.join("\n"))]);

describe("countedCalls on Codex rollouts", () => {
  test("sums last_token_usage, skips a repeated total, and re-baselines when the total falls after a restart", () => {
    const turns = [
      tokenCount("2026-10-16T10:01:00.000Z", 100, 100),
      tokenCount("2026-10-16T10:01:05.000Z", 100, 100),
      tokenCount("2026-10-16T10:02:00.000Z", 250, 150),
      tokenCount("2026-10-16T10:03:00.000Z", 40, 40),
      tokenCount("2026-10-16T10:04:00.000Z", 90, 50),
    ];
    expect(codexTotal(turns)).toBe(100 + 150 + 40 + 50);
    expect(codexTotal(turns)).not.toBe(100 + 100 + 150 + 40 + 50);
  });

  test("diffs the cumulative totals when a count carries no last_token_usage", () => {
    const turns = [
      tokenCount("2026-10-16T10:01:00.000Z", 100, undefined),
      tokenCount("2026-10-16T10:02:00.000Z", 250, undefined),
      tokenCount("2026-10-16T10:03:00.000Z", 40, undefined),
    ];
    expect(codexTotal(turns)).toBe(100 + 150 + 40);
    expect(codexTotal(turns)).not.toBe(100 + 150 - 210);
  });

  test("counts cached input as a cache read, apart from the rest of the input", () => {
    const line = JSON.stringify({
      timestamp: "2026-10-16T10:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 30, total_tokens: 1030 },
          last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 30, total_tokens: 1030 },
        },
      },
    });
    const call = countedCalls([fileOf("/c/rollout-a.jsonl", "codex", line)]).calls.at(0);
    expect(call?.tokens).toEqual({ input: 200, output: 30, cacheRead: 800, cacheWrite: 0 });
    expect(call?.credentialKey).toBe("codex-home");
  });
});
