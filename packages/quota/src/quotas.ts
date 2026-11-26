import type { DateTime } from "effect";
import { staleSourceAgeSeconds, type AccountJoin, type QuotaAvailability, type QuotaWindow, type SourcedWindow } from "@avi2dg/orc-schema";
import type { QuotaBlock, QuotaBlockBody } from "@avi2dg/orc-schema";
import {
  type Block,
  countdown,
  ellipsize,
  failureLines,
  fit,
  joinWords,
  leftHealth,
  type Line,
  lineWidth,
  padEnd,
  padStart,
  plain,
  quotaBar,
  type QuotaTint,
  secondsBetween,
  shortLabel,
  sourceWords,
  span,
  truncate,
  widthOf,
} from "@avi2dg/orc-ui";
import { accountDetail, accountReasonLines, accountRowName } from "./accounts";
import { noProviderLines } from "./sections";

const minimumLabel = 8;
const verdictMinimum = 16;
const resetWidth = 6;
const minimumBar = 6;

type Runway = NonNullable<QuotaAvailability["runway"]>;

const runwayVerdict = (runway: Runway): Line => {
  if (runway.status === "through_reset") return [span("on pace ", "muted"), span("✓", "success", { bold: true })];
  if (runway.status === "exhausted_now") return [span("✗ exhausted now", "error", { bold: true })];
  if (runway.status === "unknown") return [span("runway unknown", "muted")];
  const words =
    runway.usableRunwaySeconds === undefined
      ? "exhaustion projected"
      : `empty in ${countdown(runway.usableRunwaySeconds)}`;
  if (runway.projectionConfidence === "early") return [span(`${words} · early`, "muted")];
  return [span(words, "warning", { bold: true })];
};

const paceWords = {
  ahead: [span("ahead of pace", "warning")],
  on_pace: [span("on pace", "muted")],
  behind: [span("behind pace", "muted")],
  unknown: [span("pace unknown", "muted")],
} satisfies Record<NonNullable<QuotaWindow["pace"]>["status"], Line>;

// quota-axi's runway rests on its own reading, so a harvested window speaks with its own pace, or quota-axi's words for nothing left.
const harvestedVerdict = (window: SourcedWindow): Line => {
  if ("percentRemaining" in window && window.percentRemaining === 0) return runwayVerdict({ status: "exhausted_now" });
  return window.pace === undefined ? [] : paceWords[window.pace.status];
};

// A window that bounds a scope speaks with that scope's runway, the wording quota-axi prints under its headline.
const liveVerdict = (window: SourcedWindow, exhaustion: ReadonlyArray<QuotaAvailability>): Line => {
  if (window.source.kind === "harvested") return harvestedVerdict(window);
  const runway = exhaustion.find((scope) => scope.runway?.limitingWindowId === window.id)?.runway;
  if (runway !== undefined) return runwayVerdict(runway);
  return window.pace === undefined ? [] : paceWords[window.pace.status];
};

type AccountBody = Extract<QuotaBlockBody, { readonly kind: "account" }>;

const accountVerdict = (body: AccountBody): Line => (body.percentLeft <= 0 ? [span("used up", "error", { bold: true })] : []);

const accountRow = (body: AccountBody, shape: RowShape, now: DateTime.Utc): Line =>
  meteredRow(
    accountRowName,
    shape,
    body.percentLeft,
    quotaBar(body.percentLeft, undefined, shape.bar),
    accountVerdict(body),
    resetCell(shape, now, body.resetsAt),
  );

interface RowShape {
  readonly label: number;
  readonly bar: number;
  readonly verdict: number;
  readonly reset: boolean;
}

const verdictGap = 2;

const verdictColumn = (verdict: number): number => (verdict === 0 ? 0 : verdictGap + verdict);

// A cut verdict spends one cell on its ellipsis and keeps one blank cell after it.
const holdsAWord = (verdict: Line, width: number): boolean => {
  const words = plain(verdict);
  const firstWord = /^\P{L}*\p{L}+/u.exec(words)?.[0] ?? words;
  return widthOf(words) <= width - 1 || widthOf(firstWord) <= width - 2;
};

// Every row of the panel shares one verdict column, wide enough for its longest verdict while the bar keeps its minimum, and absent when it cannot hold a whole word of every verdict.
// The label column holds the panel's longest label and one blank cell after it, while the bar keeps its minimum.
const rowShape = (width: number, reset: boolean, verdicts: ReadonlyArray<Line>, labels: ReadonlyArray<string>): RowShape => {
  const resetColumns = reset ? 1 + resetWidth : 0;
  const longestLabel = Math.max(0, ...labels.map(widthOf));
  const label = Math.max(minimumLabel, Math.min(longestLabel + 1, width - 1 - 4 - resetColumns - minimumBar));
  const others = label + 1 + 4 + resetColumns;
  const longestVerdict = Math.max(0, ...verdicts.map(lineWidth));
  const fitted = Math.min(Math.max(verdictMinimum, longestVerdict + 1), width - others - minimumBar - verdictGap);
  const verdict = verdicts.every((line) => holdsAWord(line, fitted)) ? fitted : 0;
  return { label, bar: Math.max(minimumBar, width - others - verdictColumn(verdict)), verdict, reset };
};

const verdictText = (verdict: Line, width: number): Line =>
  lineWidth(verdict) < width
    ? fit(verdict, width)
    : fit(
        verdict.slice(0, 1).map((first) => ({ text: ellipsize(plain(verdict), width - 1), style: first.style })),
        width,
      );

const verdictCell = (verdict: Line, width: number): Line => {
  if (width === 0) return [];
  return [span(" ".repeat(verdictGap), "muted"), ...verdictText(verdict, width)];
};

const resetColumn = (shape: RowShape, text: string): Line => (shape.reset ? [span(` ${text}`, "muted")] : []);

const resetCell = (shape: RowShape, from: DateTime.Utc, resetsAt: DateTime.Utc | null | undefined): Line =>
  resetColumn(shape, resetsAt === null || resetsAt === undefined ? "" : countdown(secondsBetween(from, resetsAt)));

const labelCell = (label: string, shape: RowShape): Line[number] => span(padEnd(ellipsize(label, shape.label - 1), shape.label), "foreground");

const meteredRow = (
  label: string,
  shape: RowShape,
  percentLeft: number,
  bar: Line,
  verdict: Line,
  reset: Line,
): Line => [
  labelCell(label, shape),
  ...bar,
  span(" ", "muted"),
  span(padStart(`${Math.round(percentLeft)}%`, 4), leftHealth(percentLeft)),
  ...verdictCell(verdict, shape.verdict),
  ...reset,
];

// The window may have reset since a stale reading, so its row leaves the reset column blank.
const staleCell = (label: string, text: string, shape: RowShape): Line => [
  labelCell(label, shape),
  span(padEnd(ellipsize(text, shape.bar + 5 + verdictColumn(shape.verdict)), shape.bar + 5 + verdictColumn(shape.verdict)), "warning"),
  ...resetColumn(shape, ""),
];

const liveRow = (
  window: SourcedWindow,
  body: Extract<QuotaBlockBody, { readonly kind: "live" }>,
  shape: RowShape,
  now: DateTime.Utc,
): Line => {
  const stale = staleSourceAgeSeconds(window.source, now);
  if (stale !== undefined) {
    const text = `read ${countdown(stale)} ago`;
    return staleCell(shortLabel(window), text, shape);
  }
  // Each countdown runs on the clock its verdict was read at: quota-axi's report, or now for a harvested reading.
  const reset = resetCell(shape, window.source.kind === "harvested" ? now : body.reportedAt, window.resetsAt);
  if (!("percentRemaining" in window)) {
    const parent = body.windows.find((candidate) => candidate.id === window.shareOf);
    const caption = `share of ${parent === undefined ? window.shareOf : shortLabel(parent)}`;
    return [
      labelCell(shortLabel(window), shape),
      span(padEnd(ellipsize(caption, shape.bar + 5), shape.bar + 5 + verdictColumn(shape.verdict)), "muted"),
      ...reset,
    ];
  }
  return meteredRow(
    shortLabel(window),
    shape,
    window.percentRemaining,
    quotaBar(window.percentRemaining, window.pace?.timeRemainingPercent, shape.bar),
    liveVerdict(window, body.exhaustion),
    reset,
  );
};

const stateNote = (state: Extract<QuotaBlockBody, { readonly kind: "live" }>["state"], width: number): Block => {
  if (state.status === "fresh") return [];
  const words = state.status.replaceAll("_", " ");
  const text = state.error === undefined ? words : `${words}: ${state.error}`;
  return [[span(ellipsize(`! ${text}`, width), state.status === "stale" ? "warning" : "error")]];
};

const sourceIndent = "  ";

interface SourceGroup {
  readonly labels: ReadonlyArray<string>;
  readonly source: string;
  readonly join: string | undefined;
}

const joinOf = (window: SourcedWindow): ReadonlyArray<AccountJoin> => {
  if (window.source.kind !== "harvested") return [];
  if (
    window.source.harness === "claude-code" &&
    (window.source.via === "statusline" || window.source.via === "headless") &&
    window.source.join.kind === "credential-key"
  )
    return [];
  return [window.source.join];
};

const harvestedFirst = (windows: ReadonlyArray<SourcedWindow>): ReadonlyArray<SourcedWindow> => [
  ...windows.filter((window) => window.source.kind === "harvested"),
  ...windows.filter((window) => window.source.kind !== "harvested"),
];

const sourceGroups = (windows: ReadonlyArray<SourcedWindow>, now: DateTime.Utc): ReadonlyArray<SourceGroup> => {
  const groups: Array<SourceGroup & { readonly labels: Array<string> }> = [];
  for (const window of harvestedFirst(windows)) {
    const source = sourceWords(window.source, now);
    const join = joinWords(joinOf(window));
    const known = groups.find((group) => group.source === source && group.join === join);
    if (known === undefined) groups.push({ labels: [shortLabel(window)], source, join });
    else known.labels.push(shortLabel(window));
  }
  return groups;
};

interface Phrase {
  readonly joiner: string;
  readonly text: string;
}

// A group breaks only between its labels, where they came from and how they joined, so no line ends on a stray word.
const groupTexts = (group: SourceGroup, room: number): ReadonlyArray<string> => {
  const phrases: ReadonlyArray<Phrase> = [
    { joiner: "", text: group.labels.join(", ") },
    { joiner: " ", text: `from ${group.source}` },
    ...(group.join === undefined ? [] : [{ joiner: " · ", text: group.join }]),
  ];
  const lines: Array<string> = [];
  for (const { joiner, text } of phrases) {
    const last = lines.at(-1);
    const joined = last === undefined ? undefined : last + joiner + text;
    if (joined !== undefined && widthOf(joined) <= room) lines[lines.length - 1] = joined;
    else lines.push(text);
  }
  return lines;
};

// A block read wholly by quota-axi keeps quota-axi's own layout, so only a block holding a harvested window names its sources.
const sourceLines = (windows: ReadonlyArray<SourcedWindow>, width: number, now: DateTime.Utc): Block => {
  if (windows.every((window) => window.source.kind === "quota-axi")) return [];
  const room = width - sourceIndent.length;
  const texts: Array<string> = [];
  for (const group of sourceGroups(windows, now)) {
    const own = groupTexts(group, room);
    const last = texts.at(-1);
    const shared = last === undefined || own.length !== 1 ? undefined : `${last} · ${own.join("")}`;
    if (shared !== undefined && widthOf(shared) <= room) texts[texts.length - 1] = shared;
    else texts.push(...own);
  }
  return texts.map((text) => [span(`${sourceIndent}${ellipsize(text, room)}`, "muted")]);
};

const bodyLines = (body: QuotaBlockBody, width: number, shape: RowShape, now: DateTime.Utc): Block => {
  switch (body.kind) {
    case "live":
      return [
        ...stateNote(body.state, width),
        ...sourceLines(body.windows, width, now),
        ...(body.windows.length === 0
          ? [[span("no windows reported", "muted")]]
          : body.windows.map((window) => liveRow(window, body, shape, now))),
      ];
    case "account":
      return [accountRow(body, shape, now)];
    case "unusable":
    case "accounts-unread":
      return accountReasonLines(body, width);
    case "absent":
      return [[span("✗ missing from quota-axi's report", "error")]];
    case "unread":
      return [[span("no statusline reading in the last hour", "muted")]];
    case "unreachable":
    case "invalid":
      return failureLines(body, width);
  }
};

const verdictsOf = (body: QuotaBlockBody, now: DateTime.Utc): ReadonlyArray<Line> => {
  if (body.kind === "live")
    return body.windows.flatMap((window) =>
      staleSourceAgeSeconds(window.source, now) === undefined ? [liveVerdict(window, body.exhaustion)] : [],
    );
  if (body.kind === "account") return [accountVerdict(body)];
  return [];
};

const labelsOf = (body: QuotaBlockBody): ReadonlyArray<string> => {
  if (body.kind === "live") return body.windows.map(shortLabel);
  if (body.kind === "account") return [accountRowName];
  return [];
};

const slug = (text: string) => text.toLowerCase().replaceAll(/[\s-]/g, "");

const planOf = (block: QuotaBlock): string | undefined => {
  const plan = block.body.kind === "live" ? block.body.plan : undefined;
  return plan === undefined || slug(plan) === slug(block.provider) ? undefined : plan.toLowerCase();
};

const headerDetail = (block: QuotaBlock): Line => {
  const plan = planOf(block);
  if (plan !== undefined) return [span(` · ${plan}`, "muted")];
  const detail = accountDetail(block.body);
  return detail === undefined ? [] : [span(` · ${detail.text}`, detail.tone)];
};

const header = (block: QuotaBlock, tint: QuotaTint): Line => [span(`● ${block.title}`, tint, { bold: true }), ...headerDetail(block)];

const tintOf = (provider: QuotaBlock["provider"]): QuotaTint => {
  if (provider === "codex") return "codex";
  if (provider === "opencode-go") return "opencodeGo";
  return "claude";
};

export const quotaLines = (blocks: ReadonlyArray<QuotaBlock>, width: number, showReset: boolean, now: DateTime.Utc): Block => {
  if (blocks.length === 0) return noProviderLines;
  const shape = rowShape(
    width,
    showReset,
    blocks.flatMap((block) => verdictsOf(block.body, now)),
    blocks.flatMap((block) => labelsOf(block.body)),
  );
  return blocks
    .flatMap((block): Block => [header(block, tintOf(block.provider)), ...bodyLines(block.body, width, shape, now)])
    .map((line) => truncate(line, width));
};
