import type { Failed } from "@tui-dash/schema";
import { failureLines } from "./format";
import { type Block, wrapParts } from "./layout";
import type { Tone } from "./palette";
import { ellipsize, type Line, padEnd, span, widthOf } from "./text";

export const sentence = (text: string, tone: Tone, width: number): Block => wrapParts(text.split(" "), width, " ").map((part): Line => [span(ellipsize(part, width), tone)]);

const moreLine = (hidden: number, what: string): Line => [span(`+${hidden} more ${what}`, "muted")];

// Rows past the room are counted rather than cut, so a reader knows the list goes on.
export const withinRoom = (head: Block, rows: Block, room: number, what: string): Block => {
  if (head.length + rows.length <= room) return [...head, ...rows];
  const shown = Math.max(0, room - head.length - 1);
  return [...head, ...rows.slice(0, shown), ...(room > head.length ? [moreLine(rows.length - shown, what)] : [])].slice(0, Math.max(0, room));
};

export const sourceNotes = (label: string, failure: Failed, width: number): Block => {
  const gutter = widthOf(`${label} `);
  return failureLines(failure, width - gutter, undefined, Number.POSITIVE_INFINITY).map(
    (line, index): Line => [span(padEnd(index === 0 ? label : "", gutter), "error"), ...line],
  );
};

export const machineWidthOf = (machines: ReadonlyArray<string | undefined>): number => {
  const names = [...new Set(machines.filter((machine) => machine !== undefined))];
  return names.length > 1 ? Math.max(...names.map(widthOf)) : 0;
};
