import { type Duration } from "effect";
import type { Freshness } from "@tui-dash/schema";
import { ageText, type Block, everyText, lineWidth, type Line, plain, type ScreenSize, span, truncate, withinRows } from "@tui-dash/ui";

export interface GlanceSection {
  readonly id: string;
  readonly name: string;
  readonly cadence: Duration.Input;
  readonly savedAt: Freshness | undefined;
  // A refresh in flight while the box shows saved copies stays saved, never reading.
  readonly savedOnly: boolean;
  readonly refreshing: boolean;
  // From the fullest to the shortest, never empty.
  readonly candidates: ReadonlyArray<Block>;
}

const agedLine = (heading: string, aged: ReadonlyArray<{ readonly name: string; readonly at: number }>, now: number): Block =>
  aged.length === 0 ? [] : [[span(`${heading} \u00b7 ${aged.map(({ name, at }) => `${name} ${ageText((now - at) / 1000)} ago`).join(" \u00b7 ")}`, "muted")]];

const readingLine = (names: ReadonlyArray<string>): Block =>
  names.length === 0 ? [] : [[span(`reading \u00b7 ${names.join(" \u00b7 ")}`, "muted")]];

const lineSaysReading = (line: Line): boolean => {
  if (line.some((part) => part.text.startsWith("reading") && part.text.endsWith("\u2026"))) return true;
  const text = plain(line);
  return text.startsWith("reading") && text.endsWith("\u2026");
};

const saysReading = (candidate: Block): boolean => candidate.some(lineSaysReading);

const savedLine = (sections: ReadonlyArray<GlanceSection>, now: number): Block =>
  agedLine("saved readings", sections.flatMap(({ name, savedAt }) => (savedAt === undefined ? [] : [{ name, at: savedAt.at }])), now);

const cadenceLegend = (sections: ReadonlyArray<GlanceSection>): string =>
  [...Map.groupBy(sections, (section) => everyText(section.cadence))]
    .map(([every, alike]) => `${alike.map((section) => section.name).join(", ")} ${every}`)
    .join(" \u00b7 ");

// The glance has no box titles, and a row of its own would push out a section's row, so the intervals sit at the right edge of the first line when they fit.
const withLegend = (section: Block, legend: string, width: number): Block => {
  const first = section.at(0);
  const room = first === undefined ? 0 : width - lineWidth(first) - legend.length;
  if (first === undefined || room < 1) return section;
  return [[...first, span(" ".repeat(room), "foreground"), span(legend, "muted")], ...section.slice(1)];
};

const candidateAt = (section: GlanceSection, pick: number): Block => section.candidates.at(Math.min(pick, section.candidates.length - 1)) ?? [];

const givingWay = (sections: ReadonlyArray<GlanceSection>, givesWay: ReadonlyArray<string>): ReadonlyArray<number> => {
  const indexes = sections.map((_, index) => index);
  const named = givesWay.flatMap((id) => indexes.filter((index) => sections.at(index)?.id === id));
  return [...named, ...indexes.toReversed().filter((index) => !named.includes(index))];
};

// Each section gives way one candidate at a time, in the order it gives way.
const shrinkSteps = (sections: ReadonlyArray<GlanceSection>, givesWay: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<number>> => {
  const steps: Array<ReadonlyArray<number>> = [sections.map(() => 0)];
  for (const index of givingWay(sections, givesWay)) {
    const candidates = sections.at(index)?.candidates.length ?? 0;
    for (let pick = 1; pick < candidates; pick += 1) {
      const last = steps.at(-1) ?? [];
      steps.push(last.map((before, at) => (at === index ? pick : before)));
    }
  }
  return steps;
};

export const glanceLines = (all: ReadonlyArray<GlanceSection>, givesWay: ReadonlyArray<string>, { columns: width, rows }: ScreenSize, now: number): Block => {
  const sections = all.filter((section) => section.candidates.length > 0);
  const legend = cadenceLegend(sections);
  const saved = savedLine(sections, now);
  const drawnAt = (section: GlanceSection, pick: number): Block => candidateAt(section, pick).map((line) => truncate(line, width));
  const readingAt = (picks: ReadonlyArray<number>): Block =>
    readingLine(
      sections
        .filter((section, index) => section.refreshing && !section.savedOnly && !saysReading(drawnAt(section, picks.at(index) ?? 0)))
        .map(({ name }) => name),
    );
  const blocks = (picks: ReadonlyArray<number>): ReadonlyArray<Block> =>
    sections.map((section, index) => {
      const block = drawnAt(section, picks.at(index) ?? 0);
      return index === 0 ? withLegend(block, legend, width) : block;
    });
  const joined = (picks: ReadonlyArray<number>, gaps: boolean): Block => [...saved, ...readingAt(picks), ...blocks(picks).flatMap((block, index) => (index > 0 && gaps ? [[], ...block] : block))];
  const steps = shrinkSteps(sections, givesWay);
  const fitting = steps.flatMap((picks) => [joined(picks, true), joined(picks, false)]).find((block) => block.length <= rows);
  if (fitting !== undefined) return fitting;
  // Every section is at its shortest here, and the last one is kept whole while the rest are cut.
  const last = steps.at(-1) ?? [];
  const shortest = blocks(last);
  const rest = shortest.at(-1) ?? [];
  return withinRows([...withinRows([...saved, ...readingAt(last), ...shortest.slice(0, -1).flat()], rows - rest.length), ...rest], rows);
};
