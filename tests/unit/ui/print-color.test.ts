import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  binArgsExit,
  blockDocument,
  colorWithoutPrintExit,
  frameAnsi,
  frameText,
  printColor,
  printPanelKnown,
  span,
} from "@tui-dash/ui";

const escape = String.fromCharCode(27);

const sgr = (sequence: string): string => `${escape}[${sequence}m`;

const stripSgr = (frame: string): string => frame.replaceAll(new RegExp(`${escape}\\[[0-9;]*m`, "gu"), "");

const rendered = async (color: boolean): Promise<string> => {
  const block = [
    [span("hello", "accent"), span(" world", "foreground", { bold: true }), span(" bg", "foreground", { background: "pick" })],
  ];
  const document = blockDocument(block);
  return Effect.runPromise(color ? frameAnsi(document, 20, 2) : frameText(document, 20, 2));
};

// Oracle: the palette hexes in packages/ui/src/palette.ts, transcribed by hand: accent #66cfe1, foreground #d3d8e1,
// pick #2d4f7c. Rejects a print path that maps a tone to another colour, drops the background, or loses bold.
describe("the colour print path", () => {
  test("paints each span in its own style, and the invisible padding in none", async () => {
    const frame = await rendered(true);
    expect(frame).toContain(`${sgr("38;2;102;207;225")}hello${sgr("0")}`);
    expect(frame).toContain(`${sgr("38;2;211;216;225;1")} world${sgr("0")}`);
    expect(frame).toContain(`${sgr("38;2;211;216;225;48;2;45;79;124")} bg${sgr("0")}`);
    expect(frame).not.toContain(sgr("38;2;255;255;255"));
  });

  test("carries no visible text the plain frame does not carry", async () => {
    expect(stripSgr(await rendered(true))).toBe(await rendered(false));
  });

  test("leaves the plain frame without escape sequences", async () => {
    expect(await rendered(false)).not.toContain(escape);
  });
});

// Oracle: the bin contract that --color rides on --print, refused the way unknown flags are.
// Rejects a --color the usage hides, a lone --color that runs the live panel, or a refusal with another message.
describe("the --color flag plumbing", () => {
  test("is known on print panels and reads as a boolean", () => {
    expect(printPanelKnown.has("--color")).toBe(true);
    expect(printColor(["--print", "--color"])).toBe(true);
    expect(printColor(["--print"])).toBe(false);
  });

  test("refuses --color without --print the way binArgsExit refuses unknown flags", () => {
    const usage = "usage: tui-dash-quota";
    const errors: Array<string> = [];
    const report = console.error;
    console.error = (message: string) => void errors.push(message);
    try {
      expect(binArgsExit(["--bogus"], usage, printPanelKnown)).toBe(1);
      expect(colorWithoutPrintExit(["--color"], usage)).toBe(1);
    } finally {
      console.error = report;
    }
    expect(errors).toEqual([`Unknown flag: --bogus\n\n${usage}`, `Unknown flag: --color\n\n${usage}`]);
    expect(colorWithoutPrintExit(["--print", "--color"], usage)).toBeUndefined();
    expect(colorWithoutPrintExit(["--print"], usage)).toBeUndefined();
    expect(colorWithoutPrintExit([], usage)).toBeUndefined();
  });
});
