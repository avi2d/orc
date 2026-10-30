import type { Failed } from "@tui-dash/schema";
import { failureLine, failureLines } from "./format";
import { type Block, wrapParts } from "./layout";
import type { Tone } from "./palette";
import { type Line, lineWidth, padEnd, span } from "./text";

export const leastLabelWidth = 9;

export interface Label {
  readonly text: string;
  readonly width: number;
}

export const machineLabel = (label: string, labelWidth: number): Line => [span(padEnd(label, labelWidth), "foreground")];

export const failureText = (failure: Failed): Line => failureLine(failure, Number.POSITIVE_INFINITY);

const separator = span(" · ", "muted");

interface Reading {
  readonly parts: ReadonlyArray<string>;
  readonly tone: Tone;
}

export const reading = (tone: Tone, ...parts: ReadonlyArray<string>): Reading => ({ parts, tone });

export const labelled = (label: Label, block: Block): Block =>
  block.map((line, index): Line => [...machineLabel(index === 0 ? label.text : "", label.width), ...line]);

// The reason is what a reader acts on, such as an ssh error, so it wraps under the label rather than ending in an ellipsis.
export const failureRows = (label: Label, failure: Failed, width: number): Block => labelled(label, failureLines(failure, width - label.width));

export const labelledReadings = (label: Label, readings: ReadonlyArray<Reading>, width: number): Block =>
  readings.reduce<ReadonlyArray<Line>>((lines, { parts, tone }) => {
    const last = lines.at(-1);
    const whole = span(parts.join(" "), tone);
    if (last !== undefined && lineWidth([...last, separator, whole]) <= width) return [...lines.slice(0, -1), [...last, separator, whole]];
    const rows = wrapParts(parts, width - label.width, " ").map(
      (text, index): Line => [...machineLabel(last === undefined && index === 0 ? label.text : "", label.width), span(text, tone)],
    );
    return [...lines, ...rows];
  }, []);
