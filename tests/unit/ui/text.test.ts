import { describe, expect, test } from "bun:test";
import * as fc from "fast-check";
import { ellipsize, fit, plain, span, truncate, widthOf } from "@avi2dg/orc-ui";

const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";

const england = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E007F}";

const persian = "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645";

// Oracle: the renderer's exact-fit probe, where twenty visible columns plus a leading
// U+2063 wraps a cell to the next row while the same columns without it fit.
// Rejects a format character measured as zero but still emitted to the terminal,
// and a joiner stripped out of an emoji sequence it keeps joined.
describe("invisible format characters", () => {
  test("measure as zero and never reach the terminal", () => {
    expect(widthOf("\u2063AGENT_OP")).toBe(widthOf("AGENT_OP"));
    expect(span("\u2063AGENT_OP", "foreground").text).toBe("AGENT_OP");
  });

  test("leave no room error behind when a marked row is cut", () => {
    const cut = ellipsize("\u2063AGENT_OP watcher wake", 12);
    expect(cut).not.toContain("\u2063");
    expect(widthOf(cut)).toBeLessThanOrEqual(12);
  });

  test("keeps the joiner in an emoji sequence joined", () => {
    expect(widthOf(family)).toBe(2);
    expect(span(family, "foreground").text).toBe(family);
  });
});

// Oracle: the Unicode tag sequence, where the England flag is a base flag plus
// tag letters that draw nothing on their own, and the Persian half-space,
// where U+200C keeps two letters apart without taking a column.
// Rejects tag letters stripped down to a black flag, a half-space lost, and
// either measured as a column the terminal never draws.
describe("format characters that shape graphemes", () => {
  test("stay emitted and measure as zero", () => {
    expect(span(england, "foreground").text).toBe(england);
    expect(widthOf(england)).toBe(widthOf("\u{1F3F4}"));
    expect(span(persian, "foreground").text).toBe(persian);
    expect(widthOf(persian)).toBe(widthOf("\u0645\u06CC\u062E\u0648\u0627\u0647\u0645"));
  });

  test("leave no room error behind when a flag row is cut", () => {
    const cut = ellipsize(`${england} ships today`, 12);
    expect(cut).toContain("\u{E0067}");
    expect(widthOf(cut)).toBeLessThanOrEqual(12);
  });
});

const referencePrintable = (text: string): string =>
  text.replaceAll(/(?:(?!\u200C)(?!\u200D)(?![\u{E0020}-\u{E007F}])\p{Cf})/gu, "").replaceAll(/\p{Cc}/gu, (control) => (/\s/.test(control) ? " " : ""));

const referenceWidth = (text: string): number => Bun.stringWidth(referencePrintable(text).replaceAll(/(?:(?!\u200D)\p{Cf})/gu, ""));

const referenceCut = (text: string, width: number): string => {
  let kept = "";
  let used = 0;
  for (const { segment } of new Intl.Segmenter().segment(text)) {
    const next = referenceWidth(segment);
    if (used + next > width) break;
    kept += segment;
    used += next;
  }
  return kept;
};

const referenceFit = (text: string, width: number): string => {
  const cut = referenceCut(referencePrintable(text), width);
  return cut + " ".repeat(Math.max(0, width - referenceWidth(cut)));
};

const referenceEllipsize = (text: string, width: number): string => {
  const flat = referencePrintable(text).replaceAll(/\s+/g, " ").trim();
  if (referenceWidth(flat) <= width) return flat;
  if (width <= 0) return "";
  return `${referenceCut(flat, width - 1).trimEnd()}\u2026`;
};

const drawnCharacters = Array.from(new Intl.Segmenter().segment("abcXYZ019 -_./:%()[]·–…›←↑→↓≥⏎─━│┃┏┓┗┛╭╮╯╰╸▶○●⚑✓✗"), ({ segment }) => segment);

const joiningCharacters = ["e\u0301", "\u0301", "\u200D", "\uFE0F", "\u20E3", "\u{1F44D}", "\u{1F3FB}", "\u4E2D", "\u1100", "\u1161", "\u{1F1FA}", "\u{1F1F8}", "\t", "\r", "\n", "\u2063", "\u00AD", "\u200C", family];

const mixedText = fc.array(fc.constantFrom(...drawnCharacters, ...joiningCharacters), { maxLength: 24 }).map((characters) => characters.join(""));

describe("measuring and cutting text", () => {
  test("every character of the basic plane measures as it does grapheme by grapheme, rejecting one the length shortcut counts as a cell when it is not", () => {
    const wrong = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code))
      .filter((character) => !/\p{Cs}/u.test(character))
      .filter((character) => widthOf(character) !== referenceWidth(character));
    expect(wrong).toEqual([]);
  });

  test("a text of drawn and joining characters measures, fits and ellipsizes as it does grapheme by grapheme, rejecting a joined pair cut apart", () => {
    fc.assert(
      fc.property(mixedText, fc.integer({ min: -2, max: 30 }), (text, width) => {
        expect(widthOf(text)).toBe(referenceWidth(text));
        expect(plain(fit([span(text, "foreground")], width))).toBe(referenceFit(text, width));
        expect(ellipsize(text, width)).toBe(referenceEllipsize(text, width));
        expect(referenceWidth(plain(truncate([span(text, "foreground")], width)))).toBeLessThanOrEqual(Math.max(0, width));
      }),
      { numRuns: 2000 },
    );
  });
});
