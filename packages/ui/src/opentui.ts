import { StyledText, TextAttributes, TextRenderable, bg, bold, fg, type TextChunk } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { Effect } from "effect";
import type { Block } from "./layout";
import type { Span } from "./text";
import { defaultTheme, rgbOfTone, type Theme, type Tone } from "./palette";

export const hexOfTone = (tone: Tone, theme: Theme = defaultTheme): string => {
  const [red, green, blue] = rgbOfTone(tone, theme);
  return "#" + red.toString(16).padStart(2, "0") + green.toString(16).padStart(2, "0") + blue.toString(16).padStart(2, "0");
};

const chunkOf = (part: Span, theme: Theme): TextChunk => {
  const painted = fg(hexOfTone(part.style.tone, theme))(part.text);
  const emphasised = part.style.bold === true ? bold(painted) : painted;
  return part.style.background === undefined ? emphasised : bg(hexOfTone(part.style.background, theme))(emphasised);
};

export const blockDocument = (block: Block, theme: Theme = defaultTheme): StyledText => {
  const newline = fg(hexOfTone("foreground", theme))("\n");
  const chunks: Array<TextChunk> = [];
  block.forEach((line, index) => {
    if (index > 0) chunks.push(newline);
    for (const part of line) chunks.push(chunkOf(part, theme));
  });
  return new StyledText(chunks);
};

const escape = String.fromCharCode(27);

const paintedSpan = (
  text: string,
  red: number,
  green: number,
  blue: number,
  background: readonly [number, number, number] | undefined,
  bolded: boolean,
): string => {
  const codes = [`38;2;${red};${green};${blue}`];
  if (background !== undefined) codes.push(`48;2;${background[0]};${background[1]};${background[2]}`);
  if (bolded) codes.push("1");
  return `${escape}[${codes.join(";")}m${text}${escape}[0m`;
};

const withTestFrame = <A>(
  document: StyledText,
  width: number,
  height: number,
  capture: (setup: TestRendererSetup) => A,
): Effect.Effect<A> =>
  Effect.promise(() =>
    createTestRenderer({ width, height }).then((setup) => {
      const text = new TextRenderable(setup.renderer, { content: document });
      setup.renderer.root.add(text);
      return setup
        .renderOnce()
        .then(() => capture(setup))
        .finally(() => setup.dispose());
    }),
  );

export const frameAnsi = (document: StyledText, width: number, height: number): Effect.Effect<string> =>
  withTestFrame(document, width, height, (setup) => {
    const frame = setup.captureSpans();
    const rows = frame.lines.map((line) => {
            const parts = line.spans.map((part) => ({ part, text: part.text }));
            while (parts.length > 0) {
              const last = parts.at(-1);
              if (last === undefined) break;
              const trimmed = last.text.replace(/\s+$/u, "");
              if (trimmed !== "") {
                last.text = trimmed;
                break;
              }
              parts.pop();
            }
            return parts
              .map(({ part, text: kept }) => {
                if (kept === "") return "";
                const [red, green, blue] = part.fg.toInts();
                const [bred, bgreen, bblue, balpha] = part.bg.toInts();
                return paintedSpan(
                  kept,
                  red,
                  green,
                  blue,
                  balpha === 0 ? undefined : [bred, bgreen, bblue],
                  (part.attributes & TextAttributes.BOLD) !== 0,
                );
              })
              .join("");
          });
    let end = rows.length;
    while (end > 0 && rows[end - 1] === "") end -= 1;
    return rows.slice(0, end).join("\n");
  });

export const frameText = (document: StyledText, width: number, height: number): Effect.Effect<string> =>
  withTestFrame(document, width, height, (setup) =>
    setup
      .captureCharFrame()
      .split("\n")
      .map((row) => row.replaceAll(/\s+$/gu, ""))
      .join("\n")
      .trimEnd(),
  );
