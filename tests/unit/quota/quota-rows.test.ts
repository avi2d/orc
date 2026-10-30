import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import type { QuotaAvailability, QuotaWindow } from "@tui-dash/schema";
import { quotaLines } from "@tui-dash/quota";
import { type Line, lineWidth, plain } from "@tui-dash/quota";
import type { QuotaBlock, QuotaBlockBody } from "@tui-dash/schema";

const reportedAt = DateTime.makeUnsafe("2026-10-13T20:00:00Z");
const now = DateTime.makeUnsafe("2026-10-13T20:30:00Z");
const inHours = (hours: number) => DateTime.makeUnsafe(DateTime.toEpochMillis(reportedAt) + hours * 3_600_000);

const week = (overrides: Partial<Extract<QuotaWindow, { readonly percentRemaining: number }>> = {}): QuotaWindow => ({
  id: "seven_day",
  label: "week",
  kind: "weekly",
  percentRemaining: 31,
  resetsAt: inHours(48),
  ...overrides,
});

type Runway = NonNullable<QuotaAvailability["runway"]>;

const limitedBy = (runway: Omit<Runway, "limitingWindowId">): QuotaAvailability => ({
  scope: "all",
  status: "known",
  runway: { ...runway, limitingWindowId: "seven_day" },
});

const live = (windows: ReadonlyArray<QuotaWindow>, overrides: Partial<Extract<QuotaBlockBody, { kind: "live" }>> = {}): QuotaBlockBody => ({
  kind: "live",
  plan: "max",
  reportedAt,
  state: { status: "fresh", stale: false },
  windows: windows.map((window) => ({ ...window, source: { kind: "quota-axi", readAt: reportedAt } })),
  exhaustion: [],
  ...overrides,
});

const block = (body: QuotaBlockBody, provider: QuotaBlock["provider"] = "claude", title: string = provider): QuotaBlock => ({
  provider,
  title,
  body,
});

const width = 58;

const linesOf = (blocks: ReadonlyArray<QuotaBlock>, showReset = true) => quotaLines(blocks, width, showReset, now);

const rowText = (body: QuotaBlockBody) => linesOf([block(body)]).slice(1).map(plain);

// The verdict follows the percent left, and two spaces or more end it.
const verdictIn = (row: string): string => (row.split("%  ")[1] ?? "").split(/ {2,}/)[0] ?? "";

const verdictOf = (body: QuotaBlockBody): string => verdictIn(rowText(body)[0] ?? "");

const styleOf = (line: Line, text: string) => line.find((part) => part.text.trim().startsWith(text))?.style;

describe("a window that limits its scope, worded as quota-axi 0.1.56's runwayVerdict words its headline", () => {
  test.each([
    [{ status: "through_reset" }, "on pace ✓"],
    [{ status: "exhausted_now" }, "✗ exhausted now"],
    [{ status: "unknown" }, "runway unknown"],
    [{ status: "projected_exhaustion" }, "exhaustion projected"],
    [{ status: "projected_exhaustion", usableRunwaySeconds: 160614 }, "empty in 1d 20h"],
    [{ status: "projected_exhaustion", projectionConfidence: "early" }, "exhaustion projected · early"],
    [
      { status: "projected_exhaustion", usableRunwaySeconds: 160614, projectionConfidence: "early" },
      "empty in 1d 20h · early",
    ],
  ] as const)("%o reads %s", (runway, words) => {
    expect(verdictOf(live([week()], { exhaustion: [limitedBy(runway)] }))).toBe(words);
  });

  test("an early projection reads muted, never as a warning", () => {
    const row = (runway: Omit<Runway, "limitingWindowId">) =>
      linesOf([block(live([week()], { exhaustion: [limitedBy(runway)] }))])[1] ?? [];
    const dated = row({ status: "projected_exhaustion", usableRunwaySeconds: 160614, projectionConfidence: "early" });
    const dateless = row({ status: "projected_exhaustion", projectionConfidence: "early" });
    expect(styleOf(dated, "empty in")).toEqual({ tone: "muted" });
    expect(styleOf(dateless, "exhaustion")).toEqual({ tone: "muted" });
  });

  test("in quota-axi's styles: dim then a bold ok tick, bold crit, bold warn", () => {
    const row = (runway: Omit<Runway, "limitingWindowId">) =>
      linesOf([block(live([week()], { exhaustion: [limitedBy(runway)] }))])[1] ?? [];
    const through = row({ status: "through_reset" });
    expect([styleOf(through, "on pace"), styleOf(through, "✓")]).toEqual([{ tone: "muted" }, { tone: "success", bold: true }]);
    expect(styleOf(row({ status: "exhausted_now" }), "✗ exhausted")).toEqual({ tone: "error", bold: true });
    expect(styleOf(row({ status: "projected_exhaustion", usableRunwaySeconds: 60 }), "empty in")).toEqual({
      tone: "warning",
      bold: true,
    });
  });
});

describe("a window no scope names as limiting, worded from quota-axi's own pace status", () => {
  test.each([
    ["ahead", "ahead of pace", "warning"],
    ["on_pace", "on pace", "muted"],
    ["behind", "behind pace", "muted"],
    ["unknown", "pace unknown", "muted"],
  ] as const)("%s reads %s in %s", (status, words, tone) => {
    const body = live([week({ pace: { status } })]);
    expect(verdictOf(body)).toBe(words);
    expect(styleOf(linesOf([block(body)])[1] ?? [], words)?.tone).toBe(tone);
  });

  test("a window without pace data says nothing rather than guess, and draws no marker", () => {
    const [row = ""] = rowText(live([week()]));
    expect(verdictIn(row)).toBe("");
    expect(row).not.toContain("┃");
  });
});

describe("the rest of a quota row", () => {
  test("the marker sits at quota-axi's timeRemainingPercent, in the accent colour", () => {
    const [, row = []] = linesOf([block(live([week({ pace: { status: "ahead", timeRemainingPercent: 50 } })]))]);
    const bar = row.filter((part) => /^[━╸─┃]$/.test(part.text));
    expect(bar).toHaveLength(20);
    expect(bar.findIndex((part) => part.text === "┃")).toBe(10);
    expect(styleOf(row, "┃")).toEqual({ tone: "accent" });
  });

  test("the percent left takes quota-axi's health bands", () => {
    const tones = [98, 31, 10].map((left) => styleOf(linesOf([block(live([week({ percentRemaining: left })]))])[1] ?? [], `${left}%`)?.tone);
    expect(tones).toEqual(["success", "warning", "error"]);
  });

  test("a live window counts its reset from quota-axi's report time, as quota-axi's resetCountdown does", () => {
    expect(rowText(live([week({ resetsAt: inHours(1) })]))[0]?.trimEnd()).toEndWith(" 1h 0m");
  });

  test("a window with no reset time leaves the countdown blank, and a narrow row drops the column", () => {
    const { resetsAt: _dropped, ...noReset } = week();
    expect(rowText(live([noReset]))[0]?.trimEnd()).toEndWith("31%");
    expect(plain(linesOf([block(live([week()]))], false)[1] ?? [])).not.toContain("2d");
  });

  test("a window that is a share of another names its parent's short label, or the parent's id when it is missing", () => {
    const share: QuotaWindow = { id: "sonnet", label: "Sonnet only", kind: "model", shareOf: "seven_day" };
    expect(rowText(live([week(), share]))[1]?.trimEnd()).toStartWith("sonnet… share of week");
    expect(rowText(live([share]))[0]?.trimEnd()).toStartWith("sonnet… share of seven_day");
  });
});

describe("a block's header and its state, against the Python dash's quota_text_empty", () => {
  test("names the block in bold in its colour, with the plan in lower case unless it only repeats the provider", () => {
    const lines = linesOf([
      block(live([], { plan: "Max" }), "claude", "claude main"),
      block(live([], { plan: "OpenCode Go" }), "opencode-go"),
    ]);
    expect(lines.map(plain)).toEqual(["● claude main · max", "no windows reported", "● opencode-go", "no windows reported"]);
    expect(lines[0]?.[0]?.style).toEqual({ tone: "claude", bold: true });
  });

  test("keeps each provider's colour on its name and dot, and off every row beneath", () => {
    const providerTones = new Set(["claude", "codex", "opencodeGo"]);
    const lines = linesOf([
      block(live([week({ pace: { status: "ahead", timeRemainingPercent: 50 } })]), "claude"),
      block(live([week()]), "codex"),
      block(live([week()]), "opencode-go"),
    ]);
    const tinted = lines.map((line) => line.filter((part) => providerTones.has(part.style.tone)).map((part) => part.text));
    expect(tinted).toEqual([["● claude"], [], ["● codex"], [], ["● opencode-go"], []]);
  });

  test("paints every claude block in the one claude colour, whatever its position", () => {
    const saved: QuotaBlockBody = { kind: "saved", plan: null, stale: false, age: { kind: "undated" }, windows: [] };
    const blocks = [
      block(live([]), "claude"),
      block(saved, "claude"),
      block(live([]), "codex"),
      block(saved, "claude"),
      block(live([]), "opencode-go"),
    ];
    const headers = linesOf(blocks).filter((line) => plain(line).startsWith("●"));
    expect(headers.map((line) => line[0]?.style.tone)).toEqual(["claude", "claude", "codex", "claude", "opencodeGo"]);
  });

  test("a provider that is not fresh says its state, in warning when stale and in error otherwise", () => {
    const stale = linesOf([block(live([], { state: { status: "stale", stale: true, error: "token expired" } }))]);
    const auth = linesOf([block(live([], { state: { status: "auth_required", stale: false } }))]);
    expect([plain(stale[1] ?? []), plain(auth[1] ?? [])]).toEqual(["! stale: token expired", "! auth required"]);
    expect([stale[1]?.[0]?.style.tone, auth[1]?.[0]?.style.tone]).toEqual(["warning", "error"]);
  });

  test("a header and a missing-provider line wider than a 30 column panel are cut to it", () => {
    const lines = quotaLines(
      [block(live([week()]), "claude", "claude secondary-personal-account"), block({ kind: "absent" }, "codex")],
      30,
      true,
      now,
    ).map(plain);
    expect(lines.map((line) => Bun.stringWidth(line) <= 30)).toEqual([true, true, true, true]);
    expect(lines[0]).toStartWith("● claude secondary");
    expect(lines[3]).toStartWith("✗ missing from");
  });

  test("a provider quota-axi left out of its report says so in the error tone", () => {
    const [, missing = []] = linesOf([block({ kind: "absent" }, "codex")]);
    expect(plain(missing)).toBe("✗ missing from quota-axi's report");
    expect(missing[0]?.style.tone).toBe("error");
  });
});

describe("a saved claude reading, which shows its age where a live one shows pace", () => {
  const saved = (age: Extract<QuotaBlockBody, { kind: "saved" }>["age"]): QuotaBlockBody => ({
    kind: "saved",
    plan: "pro",
    stale: false,
    age,
    windows: [{ label: "7d", percentLeft: 99, resetsAt: DateTime.makeUnsafe("2026-10-14T20:30:00Z") }],
  });

  test.each([
    [{ kind: "dated", fetchedAt: reportedAt, ageSeconds: 1800 }, "read 30m ago"],
    [{ kind: "dated", fetchedAt: now, ageSeconds: 0 }, "read just now"],
    [{ kind: "dated", fetchedAt: DateTime.makeUnsafe("2026-10-13T20:30:30Z"), ageSeconds: -30 }, "read just now"],
    [{ kind: "undated" }, "read time unknown"],
  ] as const)("%o reads %s", (age, words) => {
    expect(verdictOf(saved(age))).toBe(words);
  });

  test("counts its reset from the frame's time, since a saved reading has no report time", () => {
    expect(rowText(saved({ kind: "undated" }))[0]?.trimEnd()).toEndWith(" 1d 0h");
  });

  test("a verdict longer than the usual column widens the column for every row, and a narrow panel cuts it", () => {
    const body = live([week({ id: "five_hour", label: "session" }), week()], {
      exhaustion: [limitedBy({ status: "projected_exhaustion" })],
    });
    const wide = linesOf([block(body)]).slice(1).map(plain);
    expect(wide.map(verdictIn)).toEqual(["", "exhaustion projected"]);
    expect(wide.map((row) => (row.slice(8).match(/[━╸─┃]/gu) ?? []).length)).toEqual([15, 15]);
    expect(wide.every((row) => Bun.stringWidth(row) <= width)).toBe(true);
    const narrow = quotaLines([block(body)], 38, false, now).slice(1).map(plain);
    expect(narrow[1]).toBe("week    ━━────  31%  exhaustion proj… ");
  });

  test("a saved window has no id to fall back on, so an empty label leaves its label cell blank", () => {
    const body: QuotaBlockBody = {
      kind: "saved",
      plan: "pro",
      stale: false,
      age: { kind: "undated" },
      windows: [{ label: "", percentLeft: 99, resetsAt: null }],
    };
    expect(rowText(body)[0]).toStartWith(`${" ".repeat(8)}━`);
  });

  test("an empty saved profile says so", () => {
    expect(rowText({ kind: "saved", plan: "pro", stale: false, age: { kind: "undated" }, windows: [] })).toEqual([
      "no saved windows",
    ]);
  });
});

describe("the edges of a quota row", () => {
  const styled = (line: Line) => line.map((part) => [part.text, part.style.tone, part.style.bold === true]);
  const limiting = (runway: Omit<Runway, "limitingWindowId">) => live([week()], { exhaustion: [limitedBy(runway)] });

  test("runway unknown reads muted, and a projection with no runway reads in bold warning", () => {
    const verdicts = [limiting({ status: "unknown" }), limiting({ status: "projected_exhaustion" })].map(
      (body) => linesOf([block(body)])[1] ?? [],
    );
    expect([styleOf(verdicts[0] ?? [], "runway"), styleOf(verdicts[1] ?? [], "exhaustion")]).toEqual([
      { tone: "muted" },
      { tone: "warning", bold: true },
    ]);
  });

  test("a scope with no runway limits no window, so the window keeps its own pace words", () => {
    const body = live([week({ pace: { status: "ahead" } })], { exhaustion: [{ scope: "all", status: "known" }] });
    expect(verdictOf(body)).toBe("ahead of pace");
  });

  test("a verdict that would touch the next column is cut, keeping one blank cell before it", () => {
    const row = (body: QuotaBlockBody, columns: number) => quotaLines([block(body)], columns, false, now)[1] ?? [];
    expect(plain(row(limiting({ status: "projected_exhaustion" }), 41))).toBe("week    ━━────  31%  exhaustion project… ");
    const cut = row(limiting({ status: "through_reset" }), 30);
    expect(plain(cut)).toBe("week    ━━────  31%  on pace… ");
    expect(styled(cut).at(-2)).toEqual(["on pace…", "muted", false]);
  });

  test("a column too narrow to hold a whole word of its verdict drops out, as the reset column does, and the bar takes its room", () => {
    const row = (body: QuotaBlockBody, columns: number) => plain(quotaLines([block(body)], columns, true, now)[1] ?? []);
    expect(row(live([week({ pace: { status: "behind" } })]), 30)).toBe("week    ━━━───────  31% 2d 0h");
    expect(row(limiting({ status: "projected_exhaustion" }), 39)).toBe(`week    ${"━".repeat(6)}${"─".repeat(13)}  31% 2d 0h`);
    expect(row(limiting({ status: "projected_exhaustion" }), 40)).toBe("week    ━━────  31%  exhaustion…  2d 0h");
  });

  test("a narrow row holds only spans, with no reset column", () => {
    const row = linesOf([block(live([week()]))], false)[1] ?? [];
    expect(row.map((part) => typeof part.text)).not.toContain("undefined");
    expect(lineWidth(row)).toBeLessThanOrEqual(width);
  });

  test("a saved window with no reset time leaves the countdown blank", () => {
    const body: QuotaBlockBody = {
      kind: "saved",
      plan: "pro",
      stale: false,
      age: { kind: "undated" },
      windows: [{ label: "7d", percentLeft: 99, resetsAt: null }],
    };
    expect(rowText(body)[0]?.trimEnd()).toEndWith("read time unknown");
  });

  test("a share row names its label in the foreground and its caption muted, with its reset under the others", () => {
    const share: QuotaWindow = { id: "sonnet", label: "Sonnet only", kind: "model", shareOf: "seven_day", resetsAt: inHours(48) };
    const lines = linesOf([block(live([week(), share]))]).slice(1);
    expect(lines.map((line) => plain(line).indexOf("2d 0h"))).toEqual([52, 52]);
    expect(styled(lines[1] ?? []).slice(0, 2)).toEqual([
      ["sonnet… ", "foreground", false],
      [`share of week${" ".repeat(30)}`, "muted", false],
    ]);
  });

  test("an empty block's words are muted, and an unreachable quota-axi gives its reason in the error tone", () => {
    const saved: QuotaBlockBody = { kind: "saved", plan: null, stale: false, age: { kind: "undated" }, windows: [] };
    const lines = linesOf([
      block(live([])),
      block(saved),
      block({ kind: "unreachable", reason: "ssh exited 255" }, "codex"),
    ]);
    expect(lines.filter((_, index) => index % 2 === 1).map(styled)).toEqual([
      [["no windows reported", "muted", false]],
      [["no saved windows", "muted", false]],
      [["✗ unreachable: ssh exited 255", "error", false]],
    ]);
  });

  test("a plan that only spells the provider without its hyphen is hidden too", () => {
    expect(plain(linesOf([block(live([], { plan: "OpenCodeGo" }), "opencode-go")])[0] ?? [])).toBe("● opencode-go");
  });

  test("a claude block keeps the claude colour even after another provider's", () => {
    const tints = linesOf([block(live([]), "codex"), block(live([]), "claude")])
      .filter((line) => plain(line).startsWith("●"))
      .map((line) => line[0]?.style.tone);
    expect(tints).toEqual(["codex", "claude"]);
  });
});
