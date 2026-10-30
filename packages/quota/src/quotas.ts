import type { DateTime } from "effect";
import { savedAgeSeconds, staleSavedAgeSeconds, staleSourceAgeSeconds, type AccountJoin, type QuotaAvailability, type QuotaWindow, type SourcedWindow } from "@tui-dash/schema";
import type { QuotaBlock, QuotaBlockBody, SavedAge, SavedWindow } from "@tui-dash/schema";
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
} from "@tui-dash/ui";

const labelWidth = 8;
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

const ageWords = (age: SavedAge, now: DateTime.Utc): string => {
  if (age.kind === "undated") return "read time unknown";
  const ageSeconds = savedAgeSeconds(age.fetchedAt, now);
  return ageSeconds > 0 ? `read ${countdown(ageSeconds)} ago` : "read just now";
};

const savedVerdict = (age: SavedAge, now: DateTime.Utc): Line => [span(ageWords(age, now), "muted")];

interface RowShape {
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
const rowShape = (width: number, reset: boolean, verdicts: ReadonlyArray<Line>): RowShape => {
  const others = labelWidth + 1 + 4 + (reset ? 1 + resetWidth : 0);
  const longestVerdict = Math.max(0, ...verdicts.map(lineWidth));
  const fitted = Math.min(Math.max(verdictMinimum, longestVerdict + 1), width - others - minimumBar - verdictGap);
  const verdict = verdicts.every((line) => holdsAWord(line, fitted)) ? fitted : 0;
  return { bar: Math.max(minimumBar, width - others - verdictColumn(verdict)), verdict, reset };
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

const meteredRow = (
  label: string,
  percentLeft: number,
  bar: Line,
  verdict: Line,
  verdictWidth: number,
  reset: Line,
): Line => [
  span(padEnd(label, labelWidth), "foreground"),
  ...bar,
  span(" ", "muted"),
  span(padStart(`${Math.round(percentLeft)}%`, 4), leftHealth(percentLeft)),
  ...verdictCell(verdict, verdictWidth),
  ...reset,
];

// The window may have reset since a stale reading, so its row leaves the reset column blank.
const staleCell = (label: string, text: string, shape: RowShape): Line => [
  span(padEnd(label, labelWidth), "foreground"),
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
      span(padEnd(shortLabel(window), labelWidth), "foreground"),
      span(padEnd(ellipsize(caption, shape.bar + 5), shape.bar + 5 + verdictColumn(shape.verdict)), "muted"),
      ...reset,
    ];
  }
  return meteredRow(
    shortLabel(window),
    window.percentRemaining,
    quotaBar(window.percentRemaining, window.pace?.timeRemainingPercent, shape.bar),
    liveVerdict(window, body.exhaustion),
    shape.verdict,
    reset,
  );
};

const savedRow = (window: SavedWindow, age: SavedAge, stale: boolean, shape: RowShape, now: DateTime.Utc): Line => {
  const staleAge = staleSavedAgeSeconds(age, stale, now);
  if (staleAge !== undefined) {
    return staleCell(shortLabel({ label: window.label, id: "" }), `read ${countdown(staleAge)} ago`, shape);
  }
  return meteredRow(
    shortLabel({ label: window.label, id: "" }),
    window.percentLeft,
    quotaBar(window.percentLeft, undefined, shape.bar),
    savedVerdict(age, now),
    shape.verdict,
    resetCell(shape, now, window.resetsAt),
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
  ...windows.filter((window) => window.source.kind === "quota-axi"),
];

const sourceGroups = (windows: ReadonlyArray<SourcedWindow>, now: DateTime.Utc): ReadonlyArray<SourceGroup> =>
  harvestedFirst(windows).reduce<ReadonlyArray<SourceGroup>>((groups, window) => {
    const source = sourceWords(window.source, now);
    const join = joinWords(joinOf(window));
    const known = groups.find((group) => group.source === source && group.join === join);
    if (known === undefined) return [...groups, { labels: [shortLabel(window)], source, join }];
    return groups.map((group) => (group === known ? { ...group, labels: [...group.labels, shortLabel(window)] } : group));
  }, []);

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
  return phrases.reduce<ReadonlyArray<string>>((lines, { joiner, text }) => {
    const last = lines.at(-1);
    if (last === undefined) return [text];
    const joined = last + joiner + text;
    return widthOf(joined) <= room ? [...lines.slice(0, -1), joined] : [...lines, text];
  }, []);
};

// A block read wholly by quota-axi keeps quota-axi's own layout, so only a block holding a harvested window names its sources.
const sourceLines = (windows: ReadonlyArray<SourcedWindow>, width: number, now: DateTime.Utc): Block => {
  if (windows.every((window) => window.source.kind === "quota-axi")) return [];
  const room = width - sourceIndent.length;
  const texts = sourceGroups(windows, now).reduce<ReadonlyArray<string>>((lines, group) => {
    const own = groupTexts(group, room);
    const last = lines.at(-1);
    const shared = last === undefined || own.length !== 1 ? undefined : `${last} · ${own.join("")}`;
    return shared !== undefined && widthOf(shared) <= room ? [...lines.slice(0, -1), shared] : [...lines, ...own];
  }, []);
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
    case "saved":
      return body.windows.length === 0
        ? [[span("no saved windows", "muted")]]
        : body.windows.map((window) => savedRow(window, body.age, body.stale, shape, now));
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
  if (body.kind === "saved")
    return staleSavedAgeSeconds(body.age, body.stale, now) === undefined ? body.windows.map(() => savedVerdict(body.age, now)) : [];
  return [];
};

const slug = (text: string) => text.toLowerCase().replaceAll(/[\s-]/g, "");

const planOf = (block: QuotaBlock): string | undefined => {
  const plan = block.body.kind === "live" || block.body.kind === "saved" ? block.body.plan : undefined;
  return plan === undefined || plan === null || slug(plan) === slug(block.provider) ? undefined : plan.toLowerCase();
};

const header = (block: QuotaBlock, tint: QuotaTint): Line => {
  const plan = planOf(block);
  return [span(`● ${block.title}`, tint, { bold: true }), ...(plan === undefined ? [] : [span(` · ${plan}`, "muted")])];
};

const tintOf = (provider: QuotaBlock["provider"]): QuotaTint => {
  if (provider === "codex") return "codex";
  if (provider === "opencode-go") return "opencodeGo";
  return "claude";
};

export const quotaLines = (blocks: ReadonlyArray<QuotaBlock>, width: number, showReset: boolean, now: DateTime.Utc): Block => {
  const shape = rowShape(width, showReset, blocks.flatMap((block) => verdictsOf(block.body, now)));
  return blocks
    .flatMap((block): Block => [header(block, tintOf(block.provider)), ...bodyLines(block.body, width, shape, now)])
    .map((line) => truncate(line, width));
};
