import { type Decoded, decoded, rejected } from "../decode";

export const nonEmptyLines = (text: string): ReadonlyArray<string> =>
  text.split("\n").filter((line) => line.trim() !== "");

export const splitEach = <A>(
  lines: ReadonlyArray<string>,
  what: string,
  split: (line: string) => A | undefined,
): Decoded<ReadonlyArray<A>> => {
  const rows: Array<A> = [];
  for (const [index, line] of lines.entries()) {
    const row = split(line);
    if (row === undefined) return rejected(`line ${index + 1} does not read as ${what}`);
    rows.push(row);
  }
  return decoded(rows);
};
