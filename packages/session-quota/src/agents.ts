import { type DateTime, Option } from "effect";
import { type AccountView, type Session, type SessionQuotaView, staleSourceAgeSeconds, type WindowView } from "@tui-dash/schema";
import { type Block, countdown, type Line, type Span, span, widthOf, windowName, wrapParts } from "@tui-dash/ui";
import { listed } from "./notes";

const pipelineWorktrees = "/.no-mistakes/worktrees/";

// A pooled worktree's folder ends in the repository's own name, so the last folder names the project without its pool hash.
const projectOf = (session: Session): string => {
  const cwd = session.cwd;
  if (cwd === undefined) return "an agent";
  if (cwd.includes(pipelineWorktrees)) return "a no-mistakes run";
  const trimmed = cwd.replace(/\/+$/u, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
};

interface Flag {
  readonly account: AccountView;
  readonly window: WindowView;
  readonly session: Session;
}

const windowsOf = (account: AccountView): ReadonlyArray<WindowView> =>
  account.body.kind === "windows" ? account.body.windows : [];

const isStale = (window: WindowView, now: DateTime.Utc): boolean => staleSourceAgeSeconds(window.source, now) !== undefined;

// A window past its reset has an unknown pace, so its gate is shut and it holds no flag, and a stale reading's pace flags nobody.
const flagsOf = (view: SessionQuotaView, now: DateTime.Utc): ReadonlyArray<Flag> =>
  view.accounts.flatMap((account) =>
    windowsOf(account).flatMap((window) =>
      window.fairPointsPerHour === null || isStale(window, now)
        ? []
        : window.sessions.filter((row) => row.flagged).map((row) => ({ account, window, session: row.session })),
    ),
  );

const markedLines = (mark: Span, sentence: string, styled: (text: string) => Span, width: number): Block =>
  wrapParts(sentence.split(" "), width - widthOf(mark.text), " ").map((text, index): Line => [
    index === 0 ? mark : span(" ".repeat(widthOf(mark.text)), "muted"),
    styled(text),
  ]);

const mutedLines = (sentence: string, width: number): Block =>
  wrapParts(sentence.split(" "), width, " ").map((text): Line => [span(text, "muted")]);

// The flag names who to stop, so it wraps rather than losing the account to an ellipsis.
const flagLines = (flag: Flag, composed: boolean, width: number): Block => {
  const who = composed && flag.session.machine !== undefined ? `${projectOf(flag.session)} on ${flag.session.machine}` : projectOf(flag.session);
  const limit = `${flag.account.title}'s ${windowName(flag.window, flag.window.cycleSeconds)}`;
  return markedLines(span("⚑ ", "error", { bold: true }), `${who} is spending over its share of ${limit}`, (text) => span(text, "foreground", { bold: true }), width);
};

// A stale limit holds no flags, so without this line its silence would read as its agents being fine.
const staleLines = (view: SessionQuotaView, width: number, now: DateTime.Utc): Block =>
  view.accounts.flatMap((account) => {
    const aged = windowsOf(account).flatMap((window) => {
      const ageSeconds = staleSourceAgeSeconds(window.source, now);
      return ageSeconds === undefined ? [] : [{ name: windowName(window, window.cycleSeconds), age: countdown(ageSeconds) }];
    });
    return [...Map.groupBy(aged, ({ age }) => age).entries()].flatMap(([age, limits]) =>
      markedLines(
        span("! ", "warning", { bold: true }),
        `${account.title}'s ${listed(limits.map(({ name }) => name), "and")} read ${age} ago, too old to flag its agents`,
        (text) => span(text, "warning"),
        width,
      ),
    );
  });

// A machine that was not read holds no flags, so without this line its silence would read as its agents being fine.
const uncheckedLines = (view: SessionQuotaView, width: number): Block =>
  (view.composition?.remotes ?? []).flatMap(({ name, state }) =>
    state.kind === "ok"
      ? []
      : markedLines(span("! ", "warning", { bold: true }), `${name} not checked, so its agents are not flagged`, (text) => span(text, "warning"), width),
  );

const flagSection = (view: SessionQuotaView, flagsShown: number, width: number, now: DateTime.Utc): Block => {
  if (view.accounts.length === 0) return mutedLines("no quota reading to check agents against", width);
  const flags = flagsOf(view, now);
  if (flags.length === 0) return mutedLines("no agent flagged for spending a limit too fast", width);
  const kept = flags.slice(0, flagsShown);
  const shown = kept.flatMap((flag) => flagLines(flag, view.composition !== undefined, width));
  const hidden = flags.length - kept.length;
  return hidden === 0 ? shown : [...shown, [span(`+${hidden} more ${hidden === 1 ? "flag" : "flags"}`, "warning")]];
};

export const agentsSection = (sessions: Option.Option<SessionQuotaView>, flagsShown: number, width: number, now: DateTime.Utc): Block =>
  Option.match(sessions, {
    onNone: () => mutedLines("reading the agents…", width),
    onSome: (view): Block => [...flagSection(view, flagsShown, width, now), ...staleLines(view, width, now), ...uncheckedLines(view, width)],
  });

export const flagCount = (sessions: Option.Option<SessionQuotaView>, now: DateTime.Utc): number =>
  Option.match(sessions, { onNone: () => 0, onSome: (view) => flagsOf(view, now).length });

export const flaggedProjects = (sessions: Option.Option<SessionQuotaView>, count: number, now: DateTime.Utc): ReadonlyArray<string> =>
  Option.match(sessions, { onNone: () => [], onSome: (view) => flagsOf(view, now).slice(0, count).map((flag) => projectOf(flag.session)) });
