import type { AttentionItem, AttentionQueue, Outcome } from "@avi2dg/orc-schema";
import { ageText, type Block, failureLines, type Line, sentence, span, truncate, wrapParts } from "@avi2dg/orc-ui";

export const nothingOpen = "nothing needs anyone";

const textRows = 2;

const indent = "  ";

const headLine = (items: ReadonlyArray<AttentionItem>): Line => {
  const overdue = items.filter((item) => item.overdue).length;
  return [span(items.length + " open", "foreground"), ...(overdue === 0 ? [] : [span(" \u00b7 ", "muted"), span(overdue + " overdue", "error")])];
};

const itemHead = (item: AttentionItem, width: number): Line =>
  truncate(
    [
      item.overdue ? span("! ", "error", { bold: true }) : span("\u00b7 ", "muted"),
      span(item.task, "foreground", { bold: true }),
      span(" \u00b7 ", "muted"),
      span(item.owner, item.owner === "user" ? "primary" : "foreground"),
      span(" \u00b7 ", "muted"),
      span(ageText(item.ageSeconds), item.overdue ? "error" : "foreground"),
      ...(item.overdue ? [span(" overdue", "error", { bold: true })] : []),
      span(" \u00b7 " + item.kind, "muted"),
    ],
    width,
  );

const itemText = (text: string, width: number): Block => {
  const rows = wrapParts(text.split(/\s+/u), width - indent.length, " ");
  const kept = rows.length > textRows ? [...rows.slice(0, textRows - 1), rows.slice(textRows - 1).join(" ")] : rows;
  return kept.map((row): Line => truncate([span(indent + row, "foreground")], width));
};

const itemBlock = (item: AttentionItem, width: number): Block => [itemHead(item, width), ...itemText(item.text, width)];

// An item is shown whole or not at all, so the count of the rest names items rather than rows.
const withinItems = (head: Block, items: ReadonlyArray<Block>, room: number): Block => {
  const shown: Array<Block> = [];
  let used = head.length;
  for (const [index, block] of items.entries()) {
    const restAfter = index < items.length - 1 ? 1 : 0;
    if (used + block.length + restAfter > room) break;
    shown.push(block);
    used += block.length;
  }
  const hidden = items.length - shown.length;
  const more: Block = hidden === 0 ? [] : [[span("+" + hidden + " more " + (hidden === 1 ? "item" : "items"), "muted")]];
  return [...head, ...shown.flat(), ...more].slice(0, Math.max(0, room));
};

export const attentionLines = (queue: Outcome<AttentionQueue>, width: number, rows: number): Block => {
  if (queue.kind !== "ok") return failureLines(queue, width);
  const { items } = queue.value;
  if (items.length === 0) return sentence(nothingOpen, "muted", width);
  return withinItems([headLine(items)], items.map((item) => itemBlock(item, width)), rows);
};
