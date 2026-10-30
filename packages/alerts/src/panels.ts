import type { DateTime } from "effect";
import {
  type AlertEvent,
  type AlertRule,
  alertRules,
  type AlertSettings,
  judgesFire,
  type MemoryLimit,
  type Outcome,
  type RuleFire,
  type RuleRecord,
  ruleRecords,
  type RuleVerdict,
  type VerdictLog,
} from "@tui-dash/schema";
import { agoWords, type Block, countdown, type Line, padEnd, secondsBetween, span, type Tone, truncate, widthOf, wrapParts } from "@tui-dash/ui";

export type LogReading = Outcome<{ readonly path: string; readonly log: VerdictLog }>;

export interface AlertReadings {
  readonly settings: AlertSettings;
  readonly verdicts: LogReading;
}

const labelWidth = 9;

const verdictRows = 3;

const figure = (value: number): string => String(Number(value.toPrecision(3)));

const duration = (seconds: number): string => {
  if (seconds < 60) return `${figure(seconds)}s`;
  return seconds < 3600 ? `${figure(seconds / 60)}m` : `${figure(seconds / 3600)}h`;
};

const memoryLimit = (limit: MemoryLimit): string =>
  "usedAtLeastPercent" in limit ? `memory used ≥ ${figure(limit.usedAtLeastPercent)}%` : `memory free < ${figure(limit.availableUnderPercent)}%`;

const listed = (words: ReadonlyArray<string>): string =>
  words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

const limitParts: { readonly [K in AlertRule]: (settings: AlertSettings) => ReadonlyArray<string> } = {
  "quota-pace": ({ quotaPace }) => ["a window runs ahead of pace past its first tenth and runs out before its reset", `read every ${duration(quotaPace.everySeconds)}`],
  "heavy-load": ({ heavyLoad }) => [
    ...(heavyLoad.machines.length === 0
      ? ["no machine listed"]
      : heavyLoad.machines.map((machine) => `${machine.name} load ≥ ${figure(machine.loadAtLeast)} or ${memoryLimit(machine.memory)}`)),
    `over for ${duration(heavyLoad.sustainedMinutes * 60)}`,
    `read every ${duration(heavyLoad.everySeconds)}`,
  ],
  "long-task": ({ longTask }) => [
    `quiet ${duration(longTask.quietMinutes * 60)}, then every ${duration(longTask.repeatMinutes * 60)}`,
    `past ${duration(longTask.totalHours * 3600)} in total`,
    longTask.states.length === 0 ? "watches no state" : `watches ${listed(longTask.states)}`,
    `read every ${duration(longTask.everySeconds)}`,
  ],
  nightly: ({ nightly }) => {
    const owned = Object.entries(nightly.homes).map(([repo, home]) => `${repo} in ${home}`);
    return [
      ...(owned.length === 0 ? ["no repository mapped to an owner home"] : owned),
      `read every ${duration(nightly.everySeconds)}`,
    ];
  },
};

const subjectOf = (event: AlertEvent): string => {
  switch (event.rule) {
    case "quota-pace":
      return `${event.account.title}'s ${event.windowLabel}`;
    case "heavy-load":
      return `${event.machine} over ${listed(event.crossed)}`;
    case "long-task":
      return event.reason === "quiet"
        ? `${event.task.title} on ${event.machine}, quiet ${countdown(event.quietMinutes * 60)}`
        : `${event.task.title} on ${event.machine}, ${countdown(event.totalMinutes * 60)} in total`;
    case "nightly":
      return `${event.workflow} on ${event.repo} red, fix in ${event.home}`;
  }
};

// A part wider than the room, such as a long task title, wraps by its words rather than running off the panel.
const wrapped = (parts: ReadonlyArray<string>, width: number): ReadonlyArray<string> =>
  wrapParts(parts, width).flatMap((line) => (widthOf(line) <= width ? [line] : wrapParts(line.split(" "), width, " ")));

const labelledRows = (label: string, texts: ReadonlyArray<string>, tone: Tone, width: number): Block =>
  texts.map((text, index): Line => truncate([span(padEnd(index === 0 ? label : "", labelWidth), "foreground"), span(text, tone)], width));

const ago = (at: DateTime.Utc, now: DateTime.Utc): string => agoWords(secondsBetween(at, now));

const firedRows = (fire: RuleFire | undefined, now: DateTime.Utc, width: number): Block =>
  fire === undefined
    ? labelledRows("fired", ["none recorded"], "muted", width)
    : labelledRows("fired", wrapped([ago(fire.at, now), ...fire.events.map(subjectOf)], width - labelWidth), "foreground", width);

const graphemes = new Intl.Segmenter();

const chunks = (word: string, width: number): ReadonlyArray<string> => {
  const rows: Array<string> = [];
  let row = "";
  let used = 0;
  for (const { segment } of graphemes.segment(word)) {
    const next = widthOf(segment);
    if (row !== "" && used + next > width) {
      rows.push(row);
      row = "";
      used = 0;
    }
    row += segment;
    used += next;
  }
  return [...rows, row];
};

// A path or a reason is what the reader acts on, so a word wider than the room breaks across rows rather than ending in an ellipsis.
const textRows = (text: string, width: number, rows: number): ReadonlyArray<string> => {
  const words = text.split(/\s+/u).flatMap((word) => (widthOf(word) <= width ? [word] : chunks(word, width)));
  const lines = wrapParts(words, width, " ");
  return lines.length > rows ? [...lines.slice(0, rows - 1), lines.slice(rows - 1).join(" ")] : lines;
};

const verdictLines = (verdict: RuleVerdict, width: number): ReadonlyArray<string> => textRows(verdict.verdict, width - labelWidth, verdictRows);

// The latest verdict can judge another task or machine than the last fire, so it names the fire it judged.
const earlierRows = (verdict: RuleVerdict, now: DateTime.Utc, width: number): Block => [
  ...labelledRows("verdict", ["none on this fire"], "muted", width),
  ...labelledRows("earlier", wrapped([ago(verdict.firedAt, now), subjectOf(verdict.event)], width - labelWidth), "muted", width),
  ...labelledRows("", verdictLines(verdict, width), "foreground", width),
];

const verdictRowsOf = (record: RuleRecord, now: DateTime.Utc, width: number): Block => {
  if (record.fire === undefined) return [];
  if (record.verdict === undefined) return labelledRows("verdict", ["none recorded"], "muted", width);
  return judgesFire(record.verdict, record.fire)
    ? labelledRows("verdict", verdictLines(record.verdict, width), "foreground", width)
    : earlierRows(record.verdict, now, width);
};

const limitRows = (rule: AlertRule, settings: AlertSettings, width: number): Block =>
  labelledRows("limits", wrapped(limitParts[rule](settings), width - labelWidth), "foreground", width);

const unknownRecord = (width: number): Block => labelledRows("fired", ["unknown until the verdict log reads"], "muted", width);

const ruleLines = (rule: AlertRule, record: RuleRecord | undefined, readings: AlertReadings, now: DateTime.Utc, width: number): Block => [
  [span(padEnd("alert", labelWidth), "foreground"), span(rule, "foreground", { bold: true })],
  ...limitRows(rule, readings.settings, width),
  ...(record === undefined ? unknownRecord(width) : [...firedRows(record.fire, now, width), ...verdictRowsOf(record, now, width)]),
];

const reasonRows = 4;

const toldRows = (label: string, text: string, tone: Tone, width: number): Block =>
  labelledRows(label, textRows(text, width - labelWidth, reasonRows), tone, width);

const unreadText = (verdicts: Exclude<LogReading, { readonly kind: "ok" }>): string =>
  verdicts.kind === "unreachable" ? `✗ unreachable: ${verdicts.reason}` : `✗ invalid: ${verdicts.issue}`;

const verdictLogLines = (verdicts: LogReading, width: number): Block => {
  if (verdicts.kind !== "ok") return toldRows("verdicts", unreadText(verdicts), "error", width);
  const { path, log } = verdicts.value;
  if (log.unreadable === 0) return [];
  const warning =
    log.unreadable === 1
      ? `! 1 line in ${path} is not a verdict record: ${log.lastIssue ?? ""}`
      : `! ${log.unreadable} lines in ${path} are not verdict records, the last: ${log.lastIssue ?? ""}`;
  return toldRows("verdicts", warning, "warning", width);
};

const recordsOf = (readings: AlertReadings): ReadonlyArray<RuleRecord> | undefined =>
  readings.verdicts.kind === "ok" ? ruleRecords(readings.verdicts.value.log.entries) : undefined;

const title = span("alerts", "foreground", { bold: true });

export const alertsSection = (readings: AlertReadings, now: DateTime.Utc, width: number): Block => {
  const records = recordsOf(readings);
  return [
    [title],
    ...verdictLogLines(readings.verdicts, width),
    ...alertRules.flatMap((rule) => ruleLines(rule, records?.find((record) => record.rule === rule), readings, now, width)),
  ];
};

const summaryRules = 4;

const ruleWidth = alertRules.reduce((widest, rule) => Math.max(widest, widthOf(rule)), 0) + 1;

const unreadableWords = (unreadable: number): string =>
  unreadable === 1 ? "1 unreadable verdict line" : `${unreadable} unreadable verdict lines`;

const troubleSpans = (readings: AlertReadings): Line => [
  ...(readings.verdicts.kind === "ok"
    ? readings.verdicts.value.log.unreadable === 0
      ? []
      : [span(` · ! ${unreadableWords(readings.verdicts.value.log.unreadable)}`, "warning")]
    : [span(" · ✗ verdict log unread", "error")]),
];

const summaryVerdict = (record: RuleRecord & { readonly fire: RuleFire }): Line => {
  if (record.verdict === undefined) return [span("no verdict yet", "muted")];
  return judgesFire(record.verdict, record.fire) ? [span(record.verdict.verdict, "foreground")] : [span("no verdict on this fire", "muted")];
};

const summaryState = (record: RuleRecord | undefined, now: DateTime.Utc): Line => {
  if (record === undefined) return [span("unknown", "muted")];
  if (record.fire === undefined) return [span("none recorded", "muted")];
  return [span(`${ago(record.fire.at, now)} · `, "foreground"), ...summaryVerdict({ ...record, fire: record.fire })];
};

export const alertsSummary = (readings: AlertReadings, now: DateTime.Utc, width: number): Block => {
  const records = recordsOf(readings);
  const hidden = alertRules.length - summaryRules;
  return [
    [title, ...troubleSpans(readings)],
    ...alertRules.slice(0, summaryRules).map((rule): Line => [
      span(padEnd(rule, ruleWidth), "foreground"),
      ...summaryState(records?.find((record) => record.rule === rule), now),
    ]),
    ...(hidden > 0 ? [[span(`+${hidden} more rules`, "muted")]] : []),
  ].map((line) => truncate(line, width));
};
