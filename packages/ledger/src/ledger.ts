import { DateTime } from "effect";
import { ageText, behind, ellipsize, fit, span, widthOf, type Block, type Line, type Tone } from "@tui-dash/ui";
import type { SessionTurn } from "./session-turns";

export type SaidWho = { readonly role: "you" } | { readonly role: "agent"; readonly name: string };

export interface SaidMessage {
  readonly id: string;
  readonly at: DateTime.Utc;
  readonly who: SaidWho;
  readonly text: string;
}

export interface AgentReplies {
  readonly name: string;
  readonly address: string | undefined;
  readonly ack: string | undefined;
}

const unaddressed = (text: string, address: string): string =>
  text.slice(text.length - text.trimStart().length + address.length).replace(/^[ \t]*\n?/, "");

const keptReply = (text: string, replies: AgentReplies): string | undefined => {
  const trimmed = text.trim();
  if (trimmed === replies.ack) return undefined;
  if (replies.address !== undefined && !trimmed.startsWith(replies.address)) return undefined;
  const said = replies.address === undefined ? text : unaddressed(text, replies.address);
  return said.trim() === "" ? undefined : said;
};

const you: SaidWho = { role: "you" };

export const saidOfTurns = (file: string, turns: ReadonlyArray<SessionTurn>, replies: AgentReplies): ReadonlyArray<SaidMessage> =>
  turns.flatMap((turn): ReadonlyArray<SaidMessage> => {
    if (turn.role === "user") {
      if (turn.operational) return [];
      if (turn.text.trim() === "") return [];
      return [{ id: `m-${file}-${turn.line}`, at: turn.at, who: you, text: turn.text }];
    }
    const said = keptReply(turn.text, replies);
    return said === undefined ? [] : [{ id: `m-${file}-${turn.line}`, at: turn.at, who: { role: "agent", name: replies.name }, text: said }];
  });

export const saidToday = (
  said: ReadonlyArray<SaidMessage>,
  now: DateTime.Utc,
  zone: DateTime.TimeZone,
): ReadonlyArray<SaidMessage> => {
  const start = DateTime.toEpochMillis(DateTime.startOf(DateTime.setZone(now, zone), "day"));
  return said
    .filter((message) => DateTime.toEpochMillis(message.at) >= start)
    .toSorted(
      (left, right) => DateTime.toEpochMillis(left.at) - DateTime.toEpochMillis(right.at) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );
};

// A pasted image arrives as its temp path.
const readableClipPaths = (text: string): string =>
  text.replace(/\/[^\s]*pi-clipb[^\s]*/gu, (match) => `pasted image${/[,.;:!?)\]}]+$/u.exec(match)?.[0] ?? ""}`);

// A reply ending its first line on a colon hides its point on the next line, so the row takes both.
const firstLines = (text: string): string => {
  const [first = "", second = ""] = readableClipPaths(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (first === "") return first;
  return first.endsWith(":") && second !== "" ? `${first} ${second}` : first;
};

const marks: Record<SaidWho["role"], { readonly glyph: string; readonly tone: Tone }> = {
  you: { glyph: "\u25cb", tone: "warning" },
  agent: { glyph: "\u25cf", tone: "foreground" },
};

export const ledgerTitle = "ledger \u00b7 today";

export interface LedgerShown {
  readonly lines: Block;
  readonly rows: ReadonlyArray<{ readonly line: number; readonly id: string }>;
  readonly shown: ReadonlyArray<SaidMessage>;
  readonly hidden: number;
}

// Chat order puts the newest message on the bottom row, and the earlier ones fold into one faint count on top.
export const ledgerShown = (
  said: ReadonlyArray<SaidMessage>,
  now: DateTime.Utc,
  inner: number,
  room: number,
  picked: string | undefined,
  tone: Tone | undefined,
): LedgerShown => {
  if (room <= 0 || inner <= 0) return { lines: [], rows: [], shown: [], hidden: said.length };
  const count = said.length <= room ? said.length : Math.max(0, room - 1);
  const shown = said.slice(said.length - count);
  const hidden = said.length - shown.length;
  const lines: Array<Line> = [];
  const rows: Array<{ readonly line: number; readonly id: string }> = [];
  if (hidden > 0) lines.push([span(ellipsize(`\u2191 ${hidden} earlier`, inner), "faint")]);
  for (const message of shown) {
    const { glyph, tone: mark } = marks[message.who.role];
    const body = firstLines(message.text);
    const age = ageText(Math.max(0, (DateTime.toEpochMillis(now) - DateTime.toEpochMillis(message.at)) / 1000));
    // The age tells how stale the words are, so the cut keeps it and spends only the rest on the words.
    const tail = ` \u00b7 ${age}`;
    const bodyRoom = inner - 2 - widthOf(tail);
    const text = bodyRoom < 1 ? ellipsize(`${body}${tail}`, Math.max(0, inner - 2)) : `${ellipsize(body, bodyRoom)}${tail}`;
    const line: Line = [span(`${glyph} `, mark), span(text, "foreground")];
    rows.push({ line: lines.length, id: message.id });
    lines.push(message.id === picked && tone !== undefined ? behind(fit(line, inner), tone) : line);
  }
  return { lines, rows, shown, hidden };
};

const timeOf = (at: DateTime.Utc, zone: DateTime.TimeZone): string => {
  const parts = DateTime.toParts(DateTime.setZone(at, zone));
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
};

const speakerOf = (who: SaidWho): string => (who.role === "you" ? "you" : who.name);

const splitLong = (word: string, width: number): ReadonlyArray<string> => {
  if (width <= 0 || widthOf(word) <= width) return [word];
  const parts: Array<string> = [];
  let chunk = "";
  for (const char of word) {
    if (chunk !== "" && widthOf(chunk + char) > width) {
      parts.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk !== "") parts.push(chunk);
  return parts.length === 0 ? [word] : parts;
};

const splitVerbatim = (line: string): { readonly indent: string; readonly tokens: ReadonlyArray<string> } => {
  const indent = line.match(/^ +/)?.[0] ?? "";
  return { indent, tokens: line.slice(indent.length).match(/ +|[^ ]+/g) ?? [] };
};

const takeChunk = (rest: string, limit: number): string => {
  let chunk = "";
  for (const char of rest) {
    if (chunk !== "" && widthOf(chunk + char) > limit) break;
    chunk += char;
  }
  return chunk;
};

const chunkWord = (token: string, room: number, width: number): ReadonlyArray<string> => {
  const parts: Array<string> = [];
  let rest = token;
  let first = true;
  while (rest !== "") {
    const limit = first ? room : width;
    if (widthOf(rest) <= limit) {
      parts.push(rest);
      break;
    }
    let chunk = takeChunk(rest, limit);
    if (chunk === "") chunk = rest.slice(0, 1);
    parts.push(chunk);
    rest = rest.slice(chunk.length);
    first = false;
  }
  return parts;
};

const packWord = (out: Array<string>, cur: string, token: string, width: number): string => {
  const room = Math.max(1, width - widthOf(cur));
  if (widthOf(token) <= room) return cur + token;
  const [head = "", ...tail] = chunkWord(token, room, width);
  out.push(cur + head);
  const last = tail.pop() ?? "";
  for (const part of tail) out.push(part);
  return last;
};

const packTokens = (indent: string, tokens: ReadonlyArray<string>, width: number): ReadonlyArray<string> => {
  const out: Array<string> = [];
  let cur = indent;
  for (const token of tokens) {
    if (widthOf(cur + token) <= width) {
      cur += token;
      continue;
    }
    if (cur.trim() !== "") {
      out.push(cur);
      cur = "";
    }
    if (token.startsWith(" ")) {
      let rest = token;
      while (widthOf(rest) > width) {
        const chunk = takeChunk(rest, width);
        out.push(chunk);
        rest = rest.slice(chunk.length);
      }
      cur += rest;
      continue;
    }
    cur = packWord(out, cur, token, width);
  }
  out.push(cur);
  return out;
};

const wrapVerbatimLine = (line: string, width: number): ReadonlyArray<string> => {
  if (line === "" || widthOf(line) <= width) return [line];
  const { indent, tokens } = splitVerbatim(line);
  if (widthOf(indent) >= width) return splitLong(line, width);
  return packTokens(indent, tokens, width);
};

const openLines = (message: SaidMessage, zone: DateTime.TimeZone, inner: number): Block => {
  const head = `${timeOf(message.at, zone)} ${speakerOf(message.who)} `;
  const width = Math.max(1, inner - widthOf(head));
  const wrapped = readableClipPaths(message.text).split("\n").flatMap((part) => wrapVerbatimLine(part, width));
  const [first = "", ...rest] = wrapped;
  return [[span(head, "muted"), span(first, "foreground")], ...rest.map((line): Line => [span(`${" ".repeat(head.length)}${line}`, "foreground")])];
};

export const heightsOf = (
  said: ReadonlyArray<SaidMessage>,
  zone: DateTime.TimeZone,
  inner: number,
  open: string | undefined,
): ReadonlyArray<number> => said.map((message) => messageBlock(message, zone, inner, message.id === open).length + 1);

export interface LedgerFull {
  readonly lines: Block;
  readonly rows: ReadonlyArray<{ readonly line: number; readonly id: string }>;
  readonly top: number;
  readonly shown: number;
  readonly hidden: number;
}

const messageBlock = (message: SaidMessage, zone: DateTime.TimeZone, inner: number, open: boolean): Block => {
  if (!open) {
    const head = `${timeOf(message.at, zone)} ${speakerOf(message.who)} `;
    return [[span(head, "muted"), span(ellipsize(firstLines(message.text), Math.max(0, inner - widthOf(head))), "foreground")]];
  }
  return openLines(message, zone, inner);
};

const fitsFrom = (heights: ReadonlyArray<number>, room: number, top: number): number => {
  let used = top > 0 ? 1 : 0;
  let count = 0;
  while (top + count < heights.length && used + (heights[top + count] ?? 0) <= room) {
    used += heights[top + count] ?? 0;
    count += 1;
  }
  return count;
};

// The window ends on the newest message until the cursor climbs out of it, then it follows the cursor.
export const windowOf = (
  heights: ReadonlyArray<number>,
  room: number,
  scroll: number,
  cursor: number,
): { readonly top: number; readonly count: number } => {
  const last = Math.max(0, heights.length - 1);
  let top = Math.min(Math.max(0, scroll), last);
  if (cursor < top) top = Math.max(0, cursor);
  if (top + Math.max(1, fitsFrom(heights, room, top)) <= cursor) {
    top = Math.max(0, cursor);
    while (top > 0) {
      const above = top - 1;
      const block = heights.slice(above, cursor + 1).reduce((total, height) => total + height, 0);
      if ((above > 0 ? 1 : 0) + block > room) break;
      top = above;
    }
  }
  return { top, count: Math.max(heights.length === 0 ? 0 : 1, fitsFrom(heights, room, top)) };
};

const markerRow = (top: number, inner: number): Line | undefined =>
  top > 0 ? [span(ellipsize(`\u2191 ${top} earlier`, inner), "faint")] : undefined;

const pickedLine = (entry: Line, id: string, pick: string | undefined, inner: number, first: boolean): Line =>
  first && id === pick ? behind(fit(entry, inner), "pick") : entry;

const openSlice = (
  said: ReadonlyArray<SaidMessage>,
  zone: DateTime.TimeZone,
  inner: number,
  room: number,
  top: number,
  line: number,
  pick: string | undefined,
  open: string | undefined,
): LedgerFull | undefined => {
  const message = said.at(top);
  if (message === undefined || message.id !== open) return undefined;
  const block = messageBlock(message, zone, inner, true);
  const available = Math.max(0, room - (top > 0 ? 1 : 0));
  if (available <= 0 || block.length < available) return undefined;
  const start = Math.max(0, Math.min(line, block.length - available));
  const marker = markerRow(top, inner);
  const lines: Array<Line> = marker === undefined ? [] : [marker];
  const rows = [{ line: lines.length, id: message.id }];
  for (const [index, entry] of block.slice(start, start + available).entries())
    lines.push(pickedLine(entry, message.id, pick, inner, index === 0));
  return { lines, rows, top, shown: 1, hidden: top };
};

const windowSlice = (
  said: ReadonlyArray<SaidMessage>,
  blocks: ReadonlyArray<Block>,
  top: number,
  count: number,
  room: number,
  pick: string | undefined,
  inner: number,
): { readonly lines: Block; readonly rows: ReadonlyArray<{ readonly line: number; readonly id: string }> } => {
  const marker = markerRow(top, inner);
  const lines: Array<Line> = marker === undefined ? [] : [marker];
  const rows: Array<{ readonly line: number; readonly id: string }> = [];
  for (const [offset, message] of said.slice(top, top + count).entries()) {
    if (lines.length >= room) break;
    const block = blocks[top + offset] ?? [];
    rows.push({ line: lines.length, id: message.id });
    for (const [index, entry] of block.entries()) {
      if (lines.length >= room) break;
      lines.push(pickedLine(entry, message.id, pick, inner, index === 0));
    }
  }
  return { lines, rows };
};

export const ledgerFull = (
  said: ReadonlyArray<SaidMessage>,
  zone: DateTime.TimeZone,
  inner: number,
  room: number,
  cursor: string | undefined,
  open: string | undefined,
  scroll: number,
  line = 0,
): LedgerFull => {
  if (room <= 0 || inner <= 0) return { lines: [], rows: [], top: 0, shown: 0, hidden: said.length };
  const heights = heightsOf(said, zone, inner, open);
  const blocks = said.map((message) => [...messageBlock(message, zone, inner, message.id === open), []]);
  const at = cursor === undefined ? said.length - 1 : said.findIndex((message) => message.id === cursor);
  const pick = cursor ?? said.at(-1)?.id;
  const { top, count } = windowOf(heights, room, scroll, at === -1 ? said.length - 1 : at);
  if (count === 1) {
    const sliced = openSlice(said, zone, inner, room, top, line, pick, open);
    if (sliced !== undefined) return sliced;
  }
  const { lines, rows } = windowSlice(said, blocks, top, count, room, pick, inner);
  return { lines, rows, top, shown: count, hidden: top };
};

export const fullHints = (inner: number): Line => [span(ellipsize("\u2191\u2193 move \u23ce or click open pgup pgdn page l or esc back", inner), "faint")];
