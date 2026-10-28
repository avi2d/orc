import type { DateTime } from "effect";
import { savedAgeSeconds, staleSavedAgeSeconds, staleSourceAgeSeconds, type QuotaAvailability, type QuotaBlock, type QuotaBlockBody, type SourcedWindow } from "@tui-dash/schema";
import {
  type Block,
  countdown,
  failureLine,
  fit,
  leftHealth,
  type Line,
  lineWidth,
  padEnd,
  padStart,
  percent,
  secondsBetween,
  span,
  tintOfProvider,
  widthOf,
  quotaBar,
  savedName,
  windowName,
} from "@tui-dash/ui";

type Outlook =
  | { readonly kind: "fine" }
  | { readonly kind: "used-up" }
  | { readonly kind: "stale"; readonly ageSeconds: number }
  | { readonly kind: "fast" }
  | { readonly kind: "runs-out"; readonly seconds: number | undefined; readonly early: boolean };

const fine: Outlook = { kind: "fine" };

// quota-axi projects a runway only from its own reading, so a window read from a harness log speaks only by its pace.
const outlookOf = (window: SourcedWindow, exhaustion: ReadonlyArray<QuotaAvailability>, now: DateTime.Utc): Outlook => {
  const stale = staleSourceAgeSeconds(window.source, now);
  if (stale !== undefined) return { kind: "stale", ageSeconds: stale };
  if (!("percentRemaining" in window)) return fine;
  if (window.percentRemaining <= 0) return { kind: "used-up" };
  const runway =
    window.source.kind === "quota-axi"
      ? exhaustion.find((scope) => scope.runway?.limitingWindowId === window.id)?.runway
      : undefined;
  if (runway?.status === "exhausted_now") return { kind: "used-up" };
  if (runway?.status === "projected_exhaustion") {
    return { kind: "runs-out", seconds: runway.usableRunwaySeconds, early: runway.projectionConfidence === "early" };
  }
  return window.pace?.status === "ahead" ? { kind: "fast" } : fine;
};

type Wording = "long" | "short";

const runsOutWords = (outlook: Extract<Outlook, { readonly kind: "runs-out" }>, wording: Wording): string => {
  const when = outlook.seconds === undefined ? "before reset" : `in ${countdown(outlook.seconds)}`;
  if (wording === "short") return outlook.early ? `maybe out ${when}` : `out ${when}`;
  return outlook.early ? `may run out ${when}` : `runs out ${when}`;
};

const outlookLine = (outlook: Outlook, wording: Wording): Line => {
  switch (outlook.kind) {
    case "fine":
      return [];
    case "used-up":
      return [span("used up", "error", { bold: true })];
    case "stale":
      return [span(`read ${countdown(outlook.ageSeconds)} ago`, "warning")];
    case "fast":
      return [span(wording === "long" ? "spending fast" : "fast", "warning")];
    case "runs-out":
      return outlook.early
        ? [span(runsOutWords(outlook, wording), "muted")]
        : [span(runsOutWords(outlook, wording), "warning", { bold: true })];
  }
};

interface QuotaRow {
  readonly name: string;
  readonly percentLeft: number;
  readonly timeRemainingPercent: number | undefined;
  readonly outlook: Outlook;
  readonly resetSeconds: number | undefined;
  readonly reserve: number | undefined;
}

const secondsUntil = (from: DateTime.Utc, resetsAt: DateTime.Utc | null | undefined): number | undefined =>
  resetsAt === null || resetsAt === undefined ? undefined : secondsBetween(from, resetsAt);

// The window may have reset since a stale reading, so its row shows no countdown.
const resetOf = (outlook: Outlook, seconds: number | undefined): number | undefined => (outlook.kind === "stale" ? undefined : seconds);

const liveRows = (body: Extract<QuotaBlockBody, { readonly kind: "live" }>, now: DateTime.Utc): ReadonlyArray<QuotaRow> =>
  body.windows.flatMap((window) => {
    if (!("percentRemaining" in window)) return [];
    const outlook = outlookOf(window, body.exhaustion, now);
    return [
      {
        name: windowName(window, window.pace?.cycleSeconds),
        percentLeft: window.percentRemaining,
        timeRemainingPercent: window.pace?.timeRemainingPercent,
        outlook,
        // A countdown runs on the clock its reading was taken at: quota-axi's report, or now for a log reading.
        resetSeconds: resetOf(outlook, secondsUntil(window.source.kind === "harvested" ? now : body.reportedAt, window.resetsAt)),
        reserve: window.pace?.reservePercentPoints,
      },
    ];
  });

const rowsOf = (body: QuotaBlockBody, now: DateTime.Utc): ReadonlyArray<QuotaRow> => {
  if (body.kind === "live") return liveRows(body, now);
  if (body.kind === "saved") {
    const stale = staleSavedAgeSeconds(body.age, body.stale, now);
    return body.windows.map((window) => {
      const outlook: Outlook = stale === undefined ? (window.percentLeft <= 0 ? { kind: "used-up" } : fine) : { kind: "stale", ageSeconds: stale };
      return {
        name: savedName(window.label),
        percentLeft: window.percentLeft,
        timeRemainingPercent: undefined,
        outlook,
        resetSeconds: resetOf(outlook, secondsUntil(now, window.resetsAt)),
        reserve: undefined,
      };
    });
  }
  return [];
};

const flatName = (text: string): string => text.toLowerCase().replaceAll(/[\s-]/g, "");

const planWords = (block: QuotaBlock): ReadonlyArray<string> => {
  const plan = block.body.kind === "live" || block.body.kind === "saved" ? block.body.plan : undefined;
  return plan === undefined || plan === null || flatName(plan) === flatName(block.provider) ? [] : [plan.toLowerCase()];
};

const stateWords = {
  fresh: undefined,
  stale: { text: "reading out of date", tone: "warning" },
  unavailable: { text: "unavailable", tone: "warning" },
  auth_required: { text: "needs sign-in", tone: "error" },
  rate_limited: { text: "check rate limited", tone: "warning" },
  error: { text: "read failed", tone: "error" },
} as const satisfies Record<
  Extract<QuotaBlockBody, { readonly kind: "live" }>["state"]["status"],
  { readonly text: string; readonly tone: "warning" | "error" } | undefined
>;

const checkedAgo = (checkedAt: DateTime.Utc, now: DateTime.Utc): string => {
  const ageSeconds = savedAgeSeconds(checkedAt, now);
  return `checked ${ageSeconds > 0 ? countdown(ageSeconds) : "<1m"} ago`;
};

// Each stale row already shows the profile's age, so the header leaves it out.
const checkedWords = (body: Extract<QuotaBlockBody, { readonly kind: "saved" }>, now: DateTime.Utc): ReadonlyArray<string> => {
  if (body.age.kind === "undated") return ["not checked yet"];
  if (body.windows.length > 0 && staleSavedAgeSeconds(body.age, body.stale, now) !== undefined) return [];
  return [checkedAgo(body.age.fetchedAt, now)];
};

// quota-axi answers a refused check with its last reading marked stale, so that reading's age is all there is to say.
const liveStateWords = (block: QuotaBlock, now: DateTime.Utc) =>
  block.body.kind === "live" &&
  block.provider === "claude" &&
  block.body.state.status === "stale" &&
  block.body.state.refreshedAt !== undefined
    ? { text: checkedAgo(block.body.state.refreshedAt, now), tone: "muted" as const }
    : block.body.kind === "live"
      ? stateWords[block.body.state.status]
      : undefined;

const indent = "  ";

const headerLines = (block: QuotaBlock, width: number, now: DateTime.Utc): Block => {
  const state = liveStateWords(block, now);
  const details: ReadonlyArray<{ readonly text: string; readonly tone: "muted" | "warning" | "error" }> = [
    ...planWords(block).map((text) => ({ text, tone: "muted" as const })),
    ...(block.body.kind === "saved" ? checkedWords(block.body, now).map((text) => ({ text, tone: "muted" as const })) : []),
    ...(state === undefined ? [] : [state]),
  ];
  return details.reduce<Block>(
    (lines, { text, tone }) => {
      const last = lines.at(-1) ?? [];
      const joined = [...last, span(` · ${text}`, tone)];
      return lineWidth(joined) <= width ? [...lines.slice(0, -1), joined] : [...lines, [span(`${indent}${text}`, tone)]];
    },
    [[span(`● ${block.title}`, tintOfProvider(block.provider), { bold: true })]],
  );
};

const emptyBody = (body: QuotaBlockBody, width: number): Block => {
  switch (body.kind) {
    case "live":
    case "saved":
      return body.windows.length === 0 ? [[span(`${indent}no limits reported`, "muted")]] : [];
    case "absent":
      return [[span(`${indent}no reading`, "muted")]];
    case "unread":
      return [[span(`${indent}no statusline reading in the last hour`, "muted")]];
    case "unreachable":
    case "invalid":
      return [[span(indent, "muted"), ...failureLine(body, width - indent.length)]];
  }
};

interface Layout {
  readonly bar: number;
  readonly left: boolean;
  readonly wording: Wording;
  readonly reset: boolean;
  readonly outlookBelow: boolean;
}

interface RowShape extends Layout {
  readonly name: number;
  readonly outlook: number;
}

const longestBar = 40;
const shortestBar = 8;

// A bare countdown beside a run-out time cannot say which of the two it is, so the reset keeps its words.
const resetText = (seconds: number | undefined): string => (seconds === undefined ? "" : `resets in ${countdown(seconds)}`);

const percentText = (percentLeft: number, left: boolean): string => `${padStart(percent(percentLeft), 4)}${left ? " left" : ""}`;

const widest = (texts: ReadonlyArray<number>): number => Math.max(0, ...texts);

const outlookIndent = indent.repeat(2);

const widestLayout: Layout = { bar: 0, left: true, wording: "long", reset: true, outlookBelow: false };

// A warning is what a glance is for, so the reset countdown goes before it, and a run-out figure moves to its own row
// rather than being cut.
const narrowerLayouts: ReadonlyArray<Layout> = [
  widestLayout,
  { ...widestLayout, left: false },
  { ...widestLayout, left: false, wording: "short" },
  { ...widestLayout, left: false, wording: "short", reset: false },
  { ...widestLayout, reset: false, outlookBelow: true },
  { ...widestLayout, left: false, wording: "short", reset: false, outlookBelow: true },
];

// Every row on the screen shares one set of columns, so the bar gives way first, then the words around the numbers.
const rowShape = (rows: ReadonlyArray<QuotaRow>, width: number): RowShape => {
  const name = widest(rows.map((row) => widthOf(row.name)));
  const resets = widest(rows.map((row) => widthOf(resetText(row.resetSeconds))));
  const shape = (layout: Layout): RowShape => ({
    ...layout,
    name,
    outlook: widest(rows.map((row) => lineWidth(outlookLine(row.outlook, layout.wording)))),
  });
  const widthOfShape = ({ bar, left, reset, outlookBelow, outlook }: RowShape): number => {
    const main =
      indent.length + name + 1 + (bar === 0 ? 0 : bar + 1) + widthOf(percentText(100, left)) + (reset && resets > 0 ? 2 + resets : 0);
    if (outlook === 0) return main;
    return outlookBelow ? Math.max(main, outlookIndent.length + outlook) : main + 2 + outlook;
  };
  const bar = Math.min(longestBar, width - widthOfShape(shape(widestLayout)) - 1);
  if (bar >= shortestBar) return shape({ ...widestLayout, bar });
  const shapes = narrowerLayouts.map(shape);
  return shapes.find((candidate) => widthOfShape(candidate) <= width) ?? shapes.at(-1) ?? shape(widestLayout);
};

// Padding a row's last cell would only feed the ellipsis of a cut row.
const outlookCell = (outlook: Line, width: number, last: boolean): Line => {
  if (width === 0 || (last && outlook.length === 0)) return [];
  return [span("  ", "muted"), ...(last ? outlook : fit(outlook, width))];
};

const quotaRowLines = (row: QuotaRow, shape: RowShape): Block => {
  const reset = shape.reset ? resetText(row.resetSeconds) : "";
  const outlook = outlookLine(row.outlook, shape.wording);
  const middle: Line = row.outlook.kind === "stale"
    ? [span(" ".repeat((shape.bar === 0 ? 0 : shape.bar + 1) + widthOf(percentText(100, shape.left))), "muted")]
    : [
      ...(shape.bar === 0 ? [] : [...quotaBar(row.percentLeft, row.timeRemainingPercent, shape.bar), span(" ", "muted")]),
      span(percentText(row.percentLeft, shape.left), leftHealth(row.percentLeft)),
    ];
  const main: Line = [
    span(`${indent}${padEnd(row.name, shape.name)} `, "foreground"),
    ...middle,
    ...(shape.outlookBelow ? [] : outlookCell(outlook, shape.outlook, reset === "")),
    ...(reset === "" ? [] : [span(`  ${reset}`, "muted")]),
  ];
  return shape.outlookBelow && outlook.length > 0 ? [main, [span(outlookIndent, "muted"), ...outlook]] : [main];
};

const limitingOutlook = (rows: ReadonlyArray<QuotaRow>): Outlook => {
  if (rows.some((row) => row.outlook.kind === "used-up")) return { kind: "used-up" };
  const runways = rows.flatMap((row) => (row.outlook.kind === "runs-out" ? [row.outlook] : []));
  const byRunway = [...runways].sort((left, right) => (left.seconds ?? Number.POSITIVE_INFINITY) - (right.seconds ?? Number.POSITIVE_INFINITY));
  const runway = byRunway.at(0);
  if (runway !== undefined) return runway;
  if (rows.some((row) => row.outlook.kind === "fast")) return { kind: "fast" };
  return fine;
};

const outlookWords = (outlook: Outlook): { readonly text: string; readonly tone: "muted" | "warning" | "error"; readonly bold?: true } | undefined => {
  switch (outlook.kind) {
    case "fine":
      return undefined;
    case "used-up":
      return { text: "used up", tone: "error", bold: true };
    case "fast":
      return { text: "spending fast", tone: "warning" };
    case "runs-out":
      return outlook.early
        ? { text: runsOutWords(outlook, "long"), tone: "muted" }
        : { text: runsOutWords(outlook, "long"), tone: "warning", bold: true };
    case "stale":
      return undefined;
  }
};

const compactHeader = (block: QuotaBlock, width: number, now: DateTime.Utc): Block => {
  const lines = headerLines(block, width, now);
  const outlook = outlookWords(limitingOutlook(rowsOf(block.body, now)));
  if (outlook === undefined) return lines;
  const last = lines.at(-1) ?? [];
  const joined: Line = [...last, span(` \u00b7 ${outlook.text}`, outlook.tone, outlook.bold === true ? { bold: true } : {})];
  return lineWidth(joined) <= width ? [...lines.slice(0, -1), joined] : [...lines, [span(`${indent}${outlook.text}`, outlook.tone)]];
};

const reserveWidth = 11;

const reserveCell = (row: QuotaRow): Line => {
  if (row.percentLeft <= 0) return [span(padEnd("used up", reserveWidth), "error", { bold: true })];
  if (row.reserve === undefined) return [span(padEnd(row.timeRemainingPercent === undefined ? "no pace" : "", reserveWidth), "muted")];
  const points = Math.round(row.reserve);
  if (Math.abs(row.reserve) <= 1) return [span(padEnd("on pace", reserveWidth), "muted")];
  return points > 0
    ? [span(padEnd(`+${points} spare`, reserveWidth), "success")]
    : [span(padEnd(`${-points} over`, reserveWidth), "warning", { bold: true })];
};

const splitShown = (blocks: ReadonlyArray<QuotaBlock>, savedShown: number): { readonly hidden: ReadonlyArray<QuotaBlock>; readonly shown: ReadonlyArray<QuotaBlock> } => {
  const hidden = blocks.filter((block) => block.body.kind === "saved").slice(savedShown);
  return { hidden, shown: blocks.filter((block) => !hidden.includes(block)) };
};

const hiddenLine = (block: QuotaBlock, hidden: ReadonlyArray<QuotaBlock>): Block | undefined => {
  if (block === hidden[0]) return [[span(`+${hidden.length} more claude profiles`, "muted")]];
  return hidden.includes(block) ? [] : undefined;
};

export const reserveQuotaSection = (blocks: ReadonlyArray<QuotaBlock>, width: number, now: DateTime.Utc, savedShown: number): Block => {
  const { hidden, shown } = splitShown(blocks, savedShown);
  const rows = shown.flatMap((block) => rowsOf(block.body, now));
  const name = widest(rows.map((row) => widthOf(row.name)));
  const reset = widest(rows.map((row) => (row.resetSeconds === undefined ? 0 : widthOf(countdown(row.resetSeconds)))));
  const bar = Math.max(shortestBar, width - (indent.length + name + 1 + 1 + 4 + 2 + reserveWidth + 2 + reset));
  return blocks.flatMap((block): Block => hiddenLine(block, hidden) ?? [
    ...compactHeader(block, width, now),
    ...rowsOf(block.body, now).map((row): Line => {
      if (row.outlook.kind === "stale")
        return [
        span(`${indent}${padEnd(row.name, name)} `, "foreground"),
        span(" ".repeat(bar), "muted"),
        span(" ", "muted"),
        ...fit(outlookLine(row.outlook, "long"), 4 + 2 + reserveWidth),
        span(`  ${padStart(row.resetSeconds === undefined ? "" : countdown(row.resetSeconds), reset)}`, "muted"),
      ];
      return [
        span(`${indent}${padEnd(row.name, name)} `, "foreground"),
        ...quotaBar(row.percentLeft, row.timeRemainingPercent, bar),
        span(" ", "muted"),
        span(padStart(percent(row.percentLeft), 4), leftHealth(row.percentLeft)),
        span("  ", "muted"),
        ...reserveCell(row),
        span(`  ${padStart(row.resetSeconds === undefined ? "" : countdown(row.resetSeconds), reset)}`, "muted"),
      ];
    }),
    ...emptyBody(block.body, width),
  ]);
};

export const quotaSection = (blocks: ReadonlyArray<QuotaBlock>, width: number, now: DateTime.Utc, savedShown: number): Block => {
  const { hidden, shown } = splitShown(blocks, savedShown);
  const shape = rowShape(
    shown.flatMap((block) => rowsOf(block.body, now)),
    width,
  );
  return blocks.flatMap((block): Block => hiddenLine(block, hidden) ?? [
    ...headerLines(block, width, now),
    ...rowsOf(block.body, now).flatMap((row) => quotaRowLines(row, shape)),
    ...emptyBody(block.body, width),
  ]);
};
