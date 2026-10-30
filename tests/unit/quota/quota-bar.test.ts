import { describe, expect, test } from "bun:test";
import { countdown } from "@tui-dash/quota";
import type { Tone } from "@tui-dash/quota";
import { quotaBar, shortLabel } from "@tui-dash/ui";
import { plain } from "@tui-dash/quota";

// [percent left, quota-axi's timeRemainingPercent, width, what quota-axi 0.1.56's own thinBar draws for them]
const thinBars: ReadonlyArray<readonly [number, number | undefined, number, string]> = [
  [31, 40.8903, 20, "━━━━━━──┃───────────"],
  [98, 23.9139, 20, "━━━━━┃━━━━━━━━━━━━━╸"],
  [100, 40.8903, 20, "━━━━━━━━┃━━━━━━━━━━━"],
  [82, 92.7646, 20, "━━━━━━━━━━━━━━━━╸──┃"],
  [93, 73.6284, 7, "━━━━━┃╸"],
  [0.4, undefined, 10, "╸─────────"],
  [99.8, undefined, 10, "━━━━━━━━━╸"],
  [0, 50, 8, "────┃───"],
  [100, 100, 8, "━━━━━━━┃"],
];

describe("quotaBar against the glyphs quota-axi 0.1.56's thinBar draws for the same reading", () => {
  for (const [left, marker, width, drawn] of thinBars) {
    test(`${left}% left, marker at ${marker ?? "none"}, ${width} cells`, () => {
      expect(plain(quotaBar(left, marker, width))).toBe(drawn);
    });
  }

});

const cells = (tone: Tone, count: number): ReadonlyArray<Tone> => Array.from({ length: count }, () => tone);

// [percent left, quota-axi's timeRemainingPercent, width, the styles dotfiles qdata.py quota_bar gives at c994f7c, before PR 226]
const healthBars: ReadonlyArray<readonly [number, number | undefined, number, ReadonlyArray<Tone>]> = [
  [31, 40.8903, 20, [...cells("warning", 6), "subtle", "subtle", "accent", ...cells("subtle", 11)]],
  [82, 92.7646, 20, [...cells("success", 17), "subtle", "subtle", "accent"]],
  [10, 50, 10, ["error", ...cells("subtle", 4), "accent", ...cells("subtle", 4)]],
  [50, undefined, 4, ["success", "success", "subtle", "subtle"]],
  [20, undefined, 4, ["warning", "subtle", "subtle", "subtle"]],
  [19.6, undefined, 4, ["error", "subtle", "subtle", "subtle"]],
];

describe("quotaBar's colours against the bar before dotfiles PR 226, qdata.py quota_bar at c994f7c", () => {
  for (const [left, marker, width, tones] of healthBars) {
    test(`${left}% left fills in its health colour over a subtle track, the marker in accent`, () => {
      expect(quotaBar(left, marker, width).map((cell) => cell.style)).toEqual(tones.map((tone) => ({ tone })));
    });
  }
});

describe("countdown against quota-axi 0.1.56's formatCountdown", () => {
  test.each([
    [160614, "1d 20h"],
    [199349, "2d 7h"],
    [1986566, "22d"],
    [36580, "10h 9m"],
    [59, "<1m"],
    [0, "now"],
    [3600, "1h 0m"],
    [795600, "9d 5h"],
    [16740, "4h 39m"],
  ])("%d seconds read %s", (seconds, shown) => {
    expect(countdown(seconds)).toBe(shown);
  });
});

describe("shortLabel against quota-axi 0.1.56's shortWindowLabel", () => {
  test.each([
    ["session", "five_hour", "session"],
    ["week", "seven_day", "week"],
    ["Fable week", "x", "fable"],
    ["monthly", "x", "monthly"],
    ["730h window", "x", "730h"],
    ["gpt-5-codex-mini week", "x", "mini"],
    ["Sonnet only", "x", "sonnet…"],
    [" Weekly", "x", "weekly"],
    ["five hour window", "x", "five h…"],
    ["Opus weekly", "x", "opus w…"],
    ["Opus midweek", "x", "opus m…"],
    ["gpt-5", "x", "gpt-5"],
    ["abc-def", "x", "abc-def"],
    ["abcdefgh-", "seven_day", "seven_…"],
    ["", "seven_day", "seven_…"],
    ["  ", "five_hour", "five_h…"],
    ["window", "x", "window"],
    ["a b week", "x", "a b"],
    ["x week y", "x", "x week…"],
  ])("%p with id %p reads %p", (label, id, shown) => {
    expect(shortLabel({ label, id })).toBe(shown);
  });
});
