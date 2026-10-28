import { describe, expect, test } from "bun:test";
import { printFrameOf } from "@tui-dash/ui";

// Oracle: the frame flags as the panel bins took them, 84 columns and every row a panel needs unless told otherwise,
// with a width under the live panel's 30 column minimum raised to it.
// Rejects a printed frame narrower than a box can draw, or a height cap the caller never asked for.
describe("a printed frame's size", () => {
  test("defaults to 84 columns and as many rows as the panel needs", () => {
    expect(printFrameOf(undefined, undefined, false)).toEqual({ width: 84, height: Number.POSITIVE_INFINITY, color: false });
  });

  test("takes the width, the height and the colour asked for", () => {
    expect(printFrameOf(100, 30, true)).toEqual({ width: 100, height: 30, color: true });
  });

  test("raises a width under the 30 column minimum to it", () => {
    expect(printFrameOf(20, undefined, false).width).toBe(30);
  });
});
