import { describe, expect, test } from "bun:test";
import { ellipsize, span, widthOf } from "@tui-dash/ui";

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
