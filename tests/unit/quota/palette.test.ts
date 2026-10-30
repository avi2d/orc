import { describe, expect, test } from "bun:test";
import { type Rgb, rgbOfTone, type Tone } from "@tui-dash/quota";

const rgb = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

// The dotfiles palette.py, generated from color/tokens.toml.
const dotfilesPalette: ReadonlyArray<readonly [Tone, string]> = [
  ["primary", "#60aaf3"],
  ["accent", "#66cfe1"],
  ["warning", "#e3b667"],
  ["error", "#ed7473"],
  ["success", "#68ca80"],
  ["foreground", "#d3d8e1"],
  ["muted", "#969aa3"],
  ["subtle", "#adb1ba"],
  ["codex", "#60aaf3"],
  ["opencodeGo", "#66cfe1"],
];

describe("the tones, against the theme in the dotfiles palette", () => {
  test.each(dotfilesPalette)("%s is %s", (tone, hex) => {
    expect(rgbOfTone(tone)).toEqual(rgb(hex));
  });
});

describe("the claude tint, against the clay fill of the Claude mark on Anthropic's own pages", () => {
  test("is the clay #d97757", () => {
    expect(rgbOfTone("claude")).toEqual(rgb("#d97757"));
  });

  test("every claude block shares it, and no health tone borrows it", () => {
    expect(rgbOfTone("claude")).not.toEqual(rgbOfTone("warning"));
    expect(rgbOfTone("claude")).not.toEqual(rgbOfTone("error"));
    expect(rgbOfTone("claude")).not.toEqual(rgbOfTone("success"));
  });
});
