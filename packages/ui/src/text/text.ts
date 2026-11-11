import type { Tone } from "./palette";

export interface Style {
  readonly tone: Tone;
  readonly bold?: true;
  readonly background?: Tone;
}

export interface Span {
  readonly text: string;
  readonly style: Style;
  readonly right?: true;
  readonly tab?: string;
}

export type Line = ReadonlyArray<Span>;

const droppedFormat = /(?:(?!\u200C)(?!\u200D)(?![\u{E0020}-\u{E007F}])\p{Cf})/gu;

const unmeasuredFormat = /(?:(?!\u200D)\p{Cf})/gu;

const printable = (text: string): string =>
  text.replaceAll(droppedFormat, "").replaceAll(/\p{Cc}/gu, (control) => (/\s/.test(control) ? " " : ""));

export const rightSpan = (text: string, tone: Tone): Span => ({ ...span(text, tone), right: true });

export const span = (text: string, tone: Tone, emphasis: Omit<Style, "tone"> = {}): Span => ({
  text: printable(text),
  style: { tone, ...emphasis },
});

export const widthOf = (text: string): number => Bun.stringWidth(printable(text).replaceAll(unmeasuredFormat, ""));

export const lineWidth = (line: Line): number => line.reduce((sum, part) => sum + widthOf(part.text), 0);

export const plain = (line: Line): string => line.map((part) => part.text).join("");

const ellipsis = "…";

const graphemes = new Intl.Segmenter();

const cutToWidth = (text: string, width: number): string => {
  let kept = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const next = widthOf(segment);
    if (used + next > width) break;
    kept += segment;
    used += next;
  }
  return kept;
};

export const ellipsize = (text: string, width: number): string => {
  const flat = printable(text).replaceAll(/\s+/g, " ").trim();
  if (widthOf(flat) <= width) return flat;
  if (width <= 0) return "";
  return `${cutToWidth(flat, width - 1).trimEnd()}${ellipsis}`;
};

export const padEnd = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - widthOf(text)));

export const padStart = (text: string, width: number): string =>
  " ".repeat(Math.max(0, width - widthOf(text))) + text;

const clip = (line: Line, width: number): Line => {
  const kept: Array<Span> = [];
  let room = width;
  for (const part of line) {
    const text = cutToWidth(part.text, room);
    if (text !== "") kept.push({ ...part, text });
    room -= widthOf(text);
  }
  return kept;
};

export const truncate = (line: Line, width: number): Line => {
  if (lineWidth(line) <= width) return line;
  const kept = clip(line, width - 1);
  const last = kept.at(-1);
  return last === undefined ? [] : [...kept.slice(0, -1), { ...last, text: `${last.text.trimEnd()}${ellipsis}` }];
};

export const keyedName = (head: string, tone: Tone, emphasis: Omit<Style, "tone"> = {}, key?: string): Line => {
  if (key === undefined) return [span(head, tone, emphasis)];
  const at = head.indexOf(key);
  if (at === -1) return [span(head, tone, emphasis)];
  return [
    ...(at > 0 ? [span(head.slice(0, at), tone, emphasis)] : []),
    span(key, "accent", { bold: true }),
    ...(at + key.length < head.length ? [span(head.slice(at + key.length), tone, emphasis)] : []),
  ];
};

export const behind = (line: Line, background: Tone): Line =>
  line.map((part) => ({ ...part, style: { ...part.style, background } }));

export const fit = (line: Line, width: number): Line => {
  const clipped = clip(line, width);
  const pad = width - lineWidth(clipped);
  return pad > 0 ? [...clipped, span(" ".repeat(pad), "foreground")] : clipped;
};

// A wide character the cut lands inside leaves spaces for its uncovered columns, so the line keeps its width.
const dropped = (line: Line, columns: number): Line => {
  const kept: Array<Span> = [];
  let skip = columns;
  for (const part of line) {
    let text = "";
    for (const { segment } of graphemes.segment(part.text)) {
      if (skip <= 0) {
        text += segment;
        continue;
      }
      const next = widthOf(segment);
      if (next > skip) text += " ".repeat(next - skip);
      skip -= next;
    }
    if (text !== "") kept.push({ ...part, text });
  }
  return kept;
};

export const overlaid = (line: Line, at: number, label: Line): Line => [...fit(line, at), ...label, ...dropped(line, at + lineWidth(label))];
