import { TextAttributes, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { blockDocument, type Block } from "@avi2dg/orc-ui";
import { fixture } from "./fixtures";

interface Look {
  readonly fg: string;
  readonly bold: boolean;
  readonly bg: string | undefined;
}

interface Cell extends Look {
  readonly char: string;
}

const blank: Cell = { char: " ", fg: "#ffffff", bold: false, bg: undefined };

const graphemes = new Intl.Segmenter();

const charsOf = (row: string): ReadonlyArray<string> => Array.from(graphemes.segment(row), ({ segment }) => segment);

const fields = (line: string, pattern: RegExp, file: string): ReadonlyArray<string | undefined> => {
  const found = pattern.exec(line);
  if (found === null) throw new Error(`${file} holds an unreadable line: ${JSON.stringify(line)}`);
  return found;
};

const tones: ReadonlyMap<string, string> = new Map(
  fixture("screens/tones.txt")
    .trimEnd()
    .split("\n")
    .map((line) => {
      const [, name = "", hex = ""] = fields(line, /^(\S+) (#[0-9a-f]{6})$/u, "screens/tones.txt");
      return [name, hex] as const;
    }),
);

const hexOfTone = (tone: string, file: string): string => {
  const hex = tones.get(tone);
  if (hex === undefined) throw new Error(`${file} names ${tone}, which screens/tones.txt does not hold`);
  return hex;
};

const toneNames = (hex: string): string => {
  const named = [...tones].filter(([, toneHex]) => toneHex === hex).map(([name]) => name);
  return named.length === 0 ? hex : named.join("/");
};

const lookName = (look: Look | undefined): string => {
  if (look === undefined) return "unpainted";
  return `${toneNames(look.fg)}${look.bold ? " bold" : ""}${look.bg === undefined ? "" : ` on ${toneNames(look.bg)}`}`;
};

const backgroundName = (bg: string | undefined): string => (bg === undefined ? "no background" : `background ${toneNames(bg)}`);

const hexOf = ([red = 0, green = 0, blue = 0]: ReadonlyArray<number>): string =>
  `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

const renderedCells = async (block: Block, columns: number): Promise<ReadonlyArray<ReadonlyArray<Cell>>> => {
  const setup = await createTestRenderer({ width: columns, height: block.length + 1 });
  setup.renderer.root.add(new TextRenderable(setup.renderer, { content: blockDocument(block) }));
  await setup.renderOnce();
  const frame = setup.captureSpans();
  await setup.dispose();
  return frame.lines.map((line) =>
    line.spans.flatMap((part) => {
      const background = part.bg.toInts();
      const look: Look = {
        fg: hexOf(part.fg.toInts()),
        bold: (part.attributes & TextAttributes.BOLD) !== 0,
        bg: background[3] === 0 ? undefined : hexOf(background),
      };
      return charsOf(part.text).flatMap((char) => [
        { ...look, char },
        ...Array.from({ length: Bun.stringWidth(char) - 1 }, () => ({ ...look, char: "" })),
      ]);
    }),
  );
};

// The legend runs to the first empty line and the grid follows it, so a grid whose first row is blank still starts after it.
const pinnedStyle = (screen: string) => {
  const file = `screens/${screen}.style.txt`;
  const content = fixture(file);
  const split = content.indexOf("\n\n");
  if (split === -1) throw new Error(`${file} holds no empty line between its legend and its grid`);
  const legend = new Map(
    content
      .slice(0, split)
      .split("\n")
      .map((line) => {
        const [, code = "", fg = "", bold, bg] = fields(line, /^(\S) {2}(\S+)( bold)?(?: on (\S+))?$/u, file);
        return [code, { fg: hexOfTone(fg, file), bold: bold !== undefined, bg: bg === undefined ? undefined : hexOfTone(bg, file) }] as const;
      }),
  );
  const grid = content.slice(split + 2).replace(/\n$/u, "").split("\n").map(charsOf);
  const lookAt = (row: number, column: number): Look | undefined => {
    const code = grid[row]?.[column] ?? " ";
    if (code === " ") return undefined;
    const look = legend.get(code);
    if (look === undefined) throw new Error(`${file} row ${row + 1} column ${column + 1} holds ${code}, which its legend does not hold`);
    return look;
  };
  return { rows: grid.length, lookAt };
};

const shownDiffs = 20;

// A blank cell shows only its background, so its foreground and weight are not compared.
const cellDiff = (where: string, char: string, expected: Look | undefined, cell: Cell): string | undefined => {
  if (cell.char !== char) return `${where}: expected ${JSON.stringify(char)}, got ${JSON.stringify(cell.char)}`;
  if (char === " ") {
    return expected?.bg === cell.bg ? undefined : `${where} " ": expected ${backgroundName(expected?.bg)}, got ${backgroundName(cell.bg)}`;
  }
  if (expected !== undefined && expected.fg === cell.fg && expected.bold === cell.bold && expected.bg === cell.bg) return undefined;
  return `${where} ${JSON.stringify(char)}: expected ${lookName(expected)}, got ${lookName(cell)}`;
};

export const cellDiffs = async (block: Block, columns: number, screen: string): Promise<ReadonlyArray<string>> => {
  const cells = await renderedCells(block, columns);
  const text = fixture(`screens/${screen}.txt`).replace(/\n$/u, "").split("\n").map(charsOf);
  const style = pinnedStyle(screen);
  const diffs: Array<string> = [];
  for (let row = 0; row < Math.max(cells.length, text.length, style.rows); row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const diff = cellDiff(`row ${row + 1} column ${column + 1}`, text[row]?.[column] ?? " ", style.lookAt(row, column), cells[row]?.[column] ?? blank);
      if (diff !== undefined) diffs.push(diff);
    }
  }
  return diffs.length <= shownDiffs ? diffs : [...diffs.slice(0, shownDiffs), `and ${diffs.length - shownDiffs} more cells`];
};
