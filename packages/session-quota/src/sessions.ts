import type { DateTime } from "effect";
import {
  type AccountView,
  type SessionQuotaView,
  type SessionShare,
  staleSourceAgeSeconds,
  type WindowView,
} from "@tui-dash/schema";
import {
  type Block,
  countdown,
  cycleName,
  ellipsize,
  failureLines,
  joinWords,
  type Line,
  padEnd,
  padStart,
  type QuotaTint,
  sourceWords,
  span,
  type Tone,
  truncate,
  widthOf,
  withinRows,
  wrapParts,
} from "@tui-dash/ui";
import { labelWithin, machinesOf } from "./labels";
import { combinedNames, listed, panelFailure, sourceNotes } from "./notes";

const markWidth = 2;
const shareWidth = 5;
const pointsWidth = 5;
const rateWidth = 5;
const numbersWidth = shareWidth * 2 + pointsWidth + rateWidth;
const minimumLabel = 8;

const captionParts = ["estimates from local logs", "upper bounds", "never quota"];

export const caption = captionParts.join(", ");

const captionPartsOf = (view: SessionQuotaView | undefined): ReadonlyArray<string> =>
  view?.composition === undefined
    ? captionParts
    : [`estimates from ${listed(combinedNames(view.composition), "and")} logs`, ...captionParts.slice(1)];

// The panel promises every number is an estimate, so the caption wraps rather than losing a phrase to an ellipsis.
const captionLines = (width: number, view?: SessionQuotaView): Block =>
  wrapParts(captionPartsOf(view), width, ", ")
    .flatMap((text) => (widthOf(text) <= width ? [text] : wrapParts(text.split(" "), width, " ")))
    .map((text) => [span(ellipsize(text, width), "muted")]);

const shareText = (share: number): string => {
  if (share === 0) return "0%";
  return share < 0.005 ? "<1%" : `${Math.round(share * 100)}%`;
};

// A bound printed by rounding to nearest can fall under the estimate it bounds, so it rounds up past float noise.
const roundedUp = (value: number, step: number): number => Math.ceil(value / step - 1e-9) * step;

const pointsText = (points: number): string => {
  const tenths = roundedUp(points, 0.1);
  return tenths >= 10 ? roundedUp(points, 1).toFixed(0) : tenths.toFixed(1);
};

// Four characters at most, so the pp/h column keeps its gap from the ≤pp column.
const rateText = (rate: number): string => {
  if (rate < 9.995) return rate.toFixed(2);
  if (rate < 99.95) return rate.toFixed(1);
  return rate < 999.5 ? rate.toFixed(0) : ">999";
};

const markOf = (row: SessionShare, flagged: boolean): Line => {
  if (flagged) return [span("⚑ ", "error", { bold: true })];
  return row.session.identity.kind === "ended" ? [span("○ ", "muted")] : [span("● ", "success")];
};

// Points and rates scale the window's used points, which a stale reading no longer vouches for, while shares come from the logs alone.
const sessionRow = (row: SessionShare, window: WindowView, width: number, machines: ReadonlyArray<string>, stale: boolean): Line => {
  const label = Math.max(minimumLabel, width - markWidth - numbersWidth);
  const fast = window.fairPointsPerHour !== null && row.priced.pointsPerHour > window.fairPointsPerHour;
  const flagged = row.flagged && !stale;
  return [
    ...markOf(row, flagged),
    span(padEnd(labelWithin(row, label, machines), label), row.session.identity.kind === "ended" ? "muted" : "foreground", flagged ? { bold: true } : {}),
    span(padStart(shareText(row.priced.share), shareWidth), "foreground"),
    span(padStart(shareText(row.raw.share), shareWidth), "muted"),
    ...(stale
      ? []
      : [
          span(padStart(`≤${pointsText(row.priced.contributionPoints)}`, pointsWidth), "muted"),
          span(padStart(rateText(row.priced.pointsPerHour), rateWidth), fast ? "warning" : "muted"),
        ]),
  ];
};

const columnHeads = (width: number): Line => {
  const label = Math.max(minimumLabel, width - markWidth - numbersWidth);
  return [
    span(padEnd("  session", markWidth + label), "muted"),
    span(padStart("price", shareWidth), "muted"),
    span(padStart("raw", shareWidth), "muted"),
    span(padStart("≤pp", pointsWidth), "muted"),
    span(padStart("pp/h", rateWidth), "muted"),
  ];
};

const gateWords = (window: WindowView): { readonly text: string; readonly tone: Tone } => {
  if (window.sessions.some((row) => row.flagged)) return { text: "ahead of pace, over fair share flagged", tone: "warning" };
  if (window.aheadOfPace && window.pastFirstTenth && !window.exhaustsBeforeReset)
    return { text: "ahead of pace, lasts to reset", tone: "muted" };
  if (window.aheadOfPace && window.pastFirstTenth) return { text: "ahead of pace, none over fair share", tone: "warning" };
  if (window.aheadOfPace) return { text: "ahead but early, no flag", tone: "muted" };
  return { text: window.pace === "on_pace" ? "on pace" : `${window.pace.replace("_", " ")} pace`, tone: "muted" };
};

const windowName = (window: Pick<WindowView, "cycleSeconds">): string => `${cycleName(window)} window`;

interface HeadContext {
  readonly now: DateTime.Utc;
  readonly accountJoin: string | undefined;
}

// A window quota-axi read reads as the quota panel above it, so only a harvested window names where its used points came from.
const sourceParts = (window: WindowView, { now, accountJoin }: HeadContext): ReadonlyArray<string> => {
  if (window.source.kind === "quota-axi") return [];
  const join = joinWords([window.source.join]);
  return [`from ${sourceWords(window.source, now)}`, ...(join === undefined || join === accountJoin ? [] : [join])];
};

const noneLogged = (view: SessionQuotaView): string =>
  view.composition === undefined ? "none logged here" : `none logged on ${listed(combinedNames(view.composition), "or")}`;

const otherCycleWords = (window: WindowView): ReadonlyArray<string> =>
  window.otherCycle.length === 0 ? [] : [`${listed(window.otherCycle, "and")} read another cycle`];

const staleHead = (window: WindowView, view: SessionQuotaView, width: number, context: HeadContext, ageSeconds: number): Block => {
  const age = `${windowName(window)} read ${countdown(ageSeconds)} ago`;
  const parts = [age, ...sourceParts(window, context), ...(window.observedCalls === 0 ? [noneLogged(view)] : []), ...otherCycleWords(window)];
  return wrapParts(parts, width).map((text, index) => {
    const line = ellipsize(text, width);
    return index === 0 && line.startsWith(age)
      ? [span(age, "warning"), span(line.slice(age.length), "subtle")]
      : [span(line, "subtle")];
  });
};

const windowHead = (window: WindowView, view: SessionQuotaView, width: number, context: HeadContext): Block => {
  const used = `${windowName(window)} ${Math.round(window.usedPoints)}pp used`;
  const source = sourceParts(window, context);
  if (window.observedCalls === 0) {
    const unattributed = window.unattributedPoints > 0 ? ["all unattributed"] : [];
    const parts = [used, ...source, noneLogged(view), ...unattributed, ...otherCycleWords(window)];
    return wrapParts(parts, width).map((text) => [span(ellipsize(text, width), "muted")]);
  }
  const gate = gateWords(window);
  const fair = window.fairPointsPerHour === null ? [] : [`fair ${rateText(window.fairPointsPerHour)}pp/h each`];
  const parts = [used, ...source, ...fair, ...otherCycleWords(window), gate.text];
  return wrapParts(parts, width).map((text, index, lines) => {
    const last = index === lines.length - 1 && text.endsWith(gate.text);
    return last
      ? [span(text.slice(0, text.length - gate.text.length), "subtle"), span(gate.text, gate.tone)]
      : [span(text, "subtle")];
  });
};

// The flags are the reason to read the panel, so every flagged row stays in view and the rest fill what the cap leaves.
const shownRows = (rows: ReadonlyArray<SessionShare>, shown: number, stale: boolean): ReadonlyArray<SessionShare> => {
  const flagged = (row: SessionShare): boolean => row.flagged && !stale;
  const room = Math.max(0, shown - rows.filter(flagged).length);
  const kept = new Set(rows.filter((row) => !flagged(row)).slice(0, room));
  return rows.filter((row) => flagged(row) || kept.has(row));
};

// A flag rests on the window's pace, so a stale reading's window shows its age and flags nobody.
const windowLines = (window: WindowView, view: SessionQuotaView, width: number, shown: number, context: HeadContext): Block => {
  const staleAge = staleSourceAgeSeconds(window.source, context.now);
  const stale = staleAge !== undefined;
  const rows = shownRows(window.sessions, shown, stale).map((row) => sessionRow(row, window, width, machinesOf(view), stale));
  const hidden = window.sessions.length - rows.length;
  return [
    ...(staleAge === undefined ? windowHead(window, view, width, context) : staleHead(window, view, width, context, staleAge)),
    ...rows,
    ...(hidden > 0 ? [[span(`  +${hidden} more sessions`, "muted")]] : []),
  ];
};

const tintOf = (provider: AccountView["provider"]): QuotaTint => {
  if (provider === "codex") return "codex";
  if (provider === "opencode-go") return "opencodeGo";
  return "claude";
};

const accountLines = (account: AccountView, view: SessionQuotaView, width: number, shown: number, now: DateTime.Utc = view.now): Block => {
  const join = joinWords(account.joins);
  const title = span(`● ${account.title}`, tintOf(account.provider), { bold: true });
  // The join is the assumption every share on the account rests on, so it moves to its own line rather than losing words.
  const header: Block =
    join === undefined
      ? [[title]]
      : widthOf(`● ${account.title} · ${join}`) <= width
        ? [[title, span(` · ${join}`, "muted")]]
        : [[title], [span(`  ${ellipsize(join, width - 2)}`, "muted")]];
  if (account.body.kind !== "windows") return [...header, ...failureLines(account.body, width)];
  if (account.body.windows.length === 0) return [...header, [span("no windows reported", "muted")]];
  const context = { now, accountJoin: join };
  return [...header, ...account.body.windows.flatMap((window) => windowLines(window, view, width, shown, context))];
};

const callCount = (calls: number): string => (calls === 1 ? "1 call" : `${calls} calls`);

const footer = (view: SessionQuotaView, width: number): Block => {
  const unmetered = view.unmetered.map((entry) => `${entry.route} ${callCount(entry.calls)}`);
  return [
    ...(unmetered.length === 0
      ? []
      : wrapParts(["off subscription", ...unmetered], width).map((text) => [span(ellipsize(text, width), "muted")])),
    ...(view.unjoinedCalls === 0
      ? []
      : wrapParts([callCount(view.unjoinedCalls), "on no account quota-axi reports"], width, " ").map((text) => [
          span(ellipsize(text, width), "muted"),
        ])),
  ];
};

export const scanningLines = (width: number): Block => [
  ...captionLines(width),
  [span(ellipsize("reading local session logs…", width), "muted")],
];

type FlagForm = "wrapped" | "one-line";

const oneLineFlag = (named: string, rate: string, room: number): string => {
  const rated = `${named} · ${rate}`;
  return ellipsize(widthOf(rated) <= room ? rated : named, room);
};

const staleSummary = (view: SessionQuotaView, width: number, now: DateTime.Utc): Block =>
  view.accounts.flatMap((account) =>
    account.body.kind === "windows"
      ? account.body.windows.flatMap((window) => {
          const ageSeconds = staleSourceAgeSeconds(window.source, now);
          if (ageSeconds === undefined) return [];
          const text = `${account.title} ${windowName(window)} read ${countdown(ageSeconds)} ago`;
          return wrapParts(text.split(" "), width, " ").map((row) => [span(ellipsize(row, width), "warning")]);
        })
      : [],
  );

const freshFlagCount = (view: SessionQuotaView, now: DateTime.Utc): number =>
  view.accounts.reduce(
    (total, account) =>
      total +
      (account.body.kind === "windows"
        ? account.body.windows
            .filter((window) => staleSourceAgeSeconds(window.source, now) === undefined)
            .reduce((sum, window) => sum + window.sessions.filter((row) => row.flagged).length, 0)
        : 0),
    0,
  );

const flagSummary = (view: SessionQuotaView, width: number, form: FlagForm, now: DateTime.Utc = view.now): Block => {
  const flags = view.accounts.flatMap((account) =>
    account.body.kind === "windows"
      ? account.body.windows
          .filter((window) => staleSourceAgeSeconds(window.source, now) === undefined)
          .flatMap((window) => window.sessions.filter((row) => row.flagged).map((row) => ({ account, window, row })))
      : [],
  );
  if (flags.length === 0) return [[span(ellipsize("no session flagged", width), "muted")]];
  const room = width - markWidth;
  const machines = machinesOf(view);
  return flags.flatMap(({ account, window, row }) => {
    const fair = window.fairPointsPerHour === null ? "" : `, fair ${rateText(window.fairPointsPerHour)}`;
    const rate = `${rateText(row.priced.pointsPerHour)}pp/h${fair}`;
    const tag = `${cycleName(window)} ${account.title}`;
    const texts =
      form === "wrapped"
        ? wrapParts([labelWithin(row, room, machines), `${account.title} ${windowName(window)}`, rate], room)
        : [oneLineFlag(`${labelWithin(row, Math.max(minimumLabel, room - widthOf(tag) - 1), machines)} ${tag}`, rate, room)];
    return texts.map((text, index): Line =>
      index === 0
        ? [span("⚑ ", "error", { bold: true }), span(text, "foreground", { bold: true })]
        : [span(`  ${text}`, "muted")],
    );
  });
};

export const printedSessions = 8;

export const sessionLines = (view: SessionQuotaView, width: number, shown = Number.POSITIVE_INFINITY, now: DateTime.Utc = view.now): Block => {
  const head: Block = [...captionLines(width, view), ...sourceNotes(view, width)];
  const failure = panelFailure(view);
  if (failure !== undefined) return [...head, ...failureLines(failure, width)];
  const body = view.accounts.flatMap((account) => accountLines(account, view, width, shown, now));
  const anyRows = view.accounts.some(
    (account) => account.body.kind === "windows" && account.body.windows.some((window) => window.sessions.length > 0),
  );
  return [...head, ...(anyRows ? [columnHeads(width)] : []), ...body, ...footer(view, width)].map((line) =>
    truncate(line, width),
  );
};

const jsonCommandOf = (view: SessionQuotaView): string =>
  view.composition === undefined ? "bun run session-quota-json" : "bun run session-quota-composed-json";

// The command is what a reader acts on, so a pointer too wide for one row wraps rather than cutting it.
const moreFlags = (hidden: number, view: SessionQuotaView, width: number): Block => {
  const jsonCommand = jsonCommandOf(view);
  const forms = [
    `+${hidden} more flags, see ${jsonCommand}`,
    `+${hidden} flags: ${jsonCommand}`,
    `+${hidden} ${jsonCommand}`,
  ];
  const oneRow = forms.find((form) => widthOf(form) <= width);
  const texts = oneRow === undefined ? wrapParts([`+${hidden}`, "flags:", ...jsonCommand.split(" ")], width, " ") : [oneRow];
  return texts.map((text) => [span(text, "warning", { bold: true })]);
};

// A flag that does not fit is still counted, and the line that counts it names where every flag can be read.
const flagsWithin = (view: SessionQuotaView, width: number, room: number, now: DateTime.Utc = view.now): Block => {
  const stale = staleSummary(view, width, now);
  if (stale.length > 0 && freshFlagCount(view, now) === 0) return stale.slice(0, Math.max(0, room)).map((line) => truncate(line, width));
  const reserve = stale.length > 0 ? Math.min(stale.length, Math.max(0, room)) : 0;
  const flagsRoom = Math.max(0, room - reserve);
  const wrapped = flagSummary(view, width, "wrapped", now);
  if (wrapped.length <= flagsRoom) return [...wrapped, ...stale].slice(0, Math.max(0, room)).map((line) => truncate(line, width));
  const oneLine = flagSummary(view, width, "one-line", now);
  if (oneLine.length <= flagsRoom) return [...oneLine, ...stale].slice(0, Math.max(0, room)).map((line) => truncate(line, width));
  const fittedRoom = stale.length > 0 ? flagsRoom : room;
  const shown =
    Array.from({ length: Math.max(0, fittedRoom) }, (_, index) => fittedRoom - 1 - index).find(
      (count) => count + moreFlags(oneLine.length - count, view, width).length <= fittedRoom,
    ) ?? 0;
  const flags = [...oneLine.slice(0, shown), ...moreFlags(oneLine.length - shown, view, width)];
  return [...flags, ...stale].slice(0, Math.max(0, room)).map((line) => truncate(line, width));
};

// The flags are the reason to read the panel, so the notes give up their rows to them first.
export const flagLines = (view: SessionQuotaView, width: number, rows: number, now: DateTime.Utc = view.now): Block => {
  const captioned = captionLines(width, view);
  const failure = panelFailure(view);
  const flags = failure === undefined ? flagsWithin(view, width, rows - captioned.length, now) : failureLines(failure, width);
  const kept = [...captioned, ...flags];
  return [...kept, ...withinRows(sourceNotes(view, width), rows - kept.length)]
    .slice(0, Math.max(0, rows))
    .map((line) => truncate(line, width));
};

const rowCaps = Array.from({ length: printedSessions }, (_, index) => printedSessions - index);

export const sessionLinesWithin = (view: SessionQuotaView, width: number, rows: number, most: number, now: DateTime.Utc = view.now): Block => {
  const shown = [most, ...rowCaps].find((cap) => sessionLines(view, width, cap, now).length <= rows);
  return shown === undefined ? flagLines(view, width, rows, now) : sessionLines(view, width, shown, now);
};
