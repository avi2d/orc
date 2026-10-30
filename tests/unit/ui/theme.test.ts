import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Appearance, defaultTheme, printBlock, rgbOfTone, span, themeOf, themeOfSettings } from "@tui-dash/ui";

const escape = String.fromCharCode(27);

const printed = async (theme: ReturnType<typeof themeOf>): Promise<string> => {
  const lines: Array<string> = [];
  const log = console.log;
  console.log = (line: string) => void lines.push(line);
  try {
    await Effect.runPromise(printBlock([[span("hi", "accent")]], 10, true).pipe(Effect.provideService(Appearance, theme)));
  } finally {
    console.log = log;
  }
  return lines.join("\n");
};

// Oracle: hex pairs read as base-16 bytes, worked by hand (#0a141e is 10, 20, 30), and the SGR truecolour form 38;2;r;g;b of ITU T.416.
// Rejects a theme that drops an override, swaps channels, or a painter that ignores the theme it is given.
describe("a theme from the config", () => {
  test("replaces the tones it names and keeps the rest", () => {
    const theme = themeOf({ tones: { accent: "#0a141e" }, providers: { "opencode-go": "#ff0001" } });
    expect(rgbOfTone("accent", theme)).toEqual([10, 20, 30]);
    expect(rgbOfTone("opencodeGo", theme)).toEqual([255, 0, 1]);
    expect(rgbOfTone("warning", theme)).toEqual(rgbOfTone("warning", defaultTheme));
    expect(rgbOfTone("claude", theme)).toEqual(rgbOfTone("claude", defaultTheme));
  });

  test("is read from the appearance section, and refuses a tone it does not know or a hex that is not #rrggbb", async () => {
    const theme = await Effect.runPromise(themeOfSettings({ tones: { accent: "#0A141E" } }));
    expect(rgbOfTone("accent", theme)).toEqual([10, 20, 30]);
    expect(await Effect.runPromise(themeOfSettings(undefined))).toEqual(defaultTheme);
    const refusal = (raw: unknown) => Effect.runPromise(Effect.flip(themeOfSettings(raw)));
    expect((await refusal({ tones: { accnet: "#000000" } })).reason).toStartWith("appearance is not valid: ");
    expect((await refusal({ tones: { accnet: "#000000" } })).reason).toContain('["accnet"]');
    expect((await refusal({ tones: { accent: "#fff" } })).reason).toContain('["accent"]');
    expect((await refusal({ providers: { gemini: "#000000" } })).reason).toContain('["gemini"]');
  });

  test("is what the painter paints with", async () => {
    expect(await printed(themeOf({ tones: { accent: "#0a141e" } }))).toContain(`${escape}[38;2;10;20;30mhi`);
    expect(await printed(defaultTheme)).toContain(`${escape}[38;2;102;207;225mhi`);
  });
});
