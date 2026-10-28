import { DateTime, Effect, Option } from "effect";
import { type Freshness, freshOf, readsCadence, type SessionQuotaSources, type SessionQuotaView, SessionsFeed, type Shown, shownValue } from "@tui-dash/schema";
import {
  type Block,
  boxOf,
  boxRoom,
  countdownFrom,
  ellipsize,
  everyText,
  fittedRows,
  frameRows,
  type Line,
  mountedOf,
  noSettings,
  type NoSettings,
  panelChrome,
  panelModule,
  type PanelModule,
  type Placed,
  singleTitle,
  span,
} from "@tui-dash/ui";
import { agentsSection, flagCount, flaggedProjects } from "./agents";
import { printSessionQuotaFrame, runSessionQuotaPanel } from "./app";

export interface SessionsReading {
  readonly shown: Shown<SessionQuotaView>;
  readonly now: DateTime.Utc;
  readonly refreshing: boolean;
}

const gluttonCount = (sessions: Option.Option<SessionQuotaView>, now: DateTime.Utc, inner: number): Line => {
  if (Option.isNone(sessions)) return [span("gluttons: reading…", "muted")];
  const count = flagCount(sessions, now);
  if (count === 0) return [span("gluttons: no flags", "muted")];
  const names = flaggedProjects(sessions, 2, now);
  const text = `gluttons: ${count} ${count === 1 ? "flag" : "flags"}${names.length === 0 ? "" : `, ${names.join(" and ")} over their share`}`;
  return [span(ellipsize(text, inner), "muted")];
};

export const sessionsPlaced = (reading: () => SessionsReading): Placed => {
  const sessions = (): Option.Option<SessionQuotaView> => Option.fromUndefinedOr(shownValue(reading().shown));
  const sections = (inner: number): ReadonlyArray<Block> => {
    const { now } = reading();
    return countdownFrom(flagCount(sessions(), now)).map((shown) => agentsSection(sessions(), shown, inner, now));
  };
  return {
    box: (size, look) => {
      const title = singleTitle("gluttons", everyText(readsCadence), size.columns, look.focused, "g");
      return { block: boxOf(title, fittedRows(sections(size.columns - panelChrome), boxRoom(size, look)), size, look), targets: [] };
    },
    natural: (width) => (sections(width - panelChrome).at(0)?.length ?? 0) + frameRows,
    // The box trims its last section to the room, so it gives way to the alerts sharing its tabs.
    least: () => frameRows + 1,
    glance: sections,
    badge: (width) => gluttonCount(sessions(), reading().now, width - panelChrome),
  };
};

const readSessionsShown: Effect.Effect<SessionsReading, never, SessionsFeed> = Effect.gen(function* () {
  const feed = yield* SessionsFeed;
  const shown = yield* feed.read;
  const now = yield* DateTime.now;
  yield* Effect.yieldNow;
  return { shown, now, refreshing: yield* feed.refreshing };
});

export const sessionQuotaModule: PanelModule<SessionQuotaSources | SessionsFeed> = panelModule<NoSettings, SessionQuotaSources | SessionsFeed>({
  id: "session-quota",
  about: "the sessions spending over their share of a quota window",
  settings: noSettings,
  mount: () =>
    mountedOf({
      name: "gluttons",
      key: "g",
      cadence: readsCadence,
      reach: "none",
      read: readSessionsShown,
      pending: (reading) => reading.shown.kind !== "live",
      refreshing: (reading) => reading.refreshing,
      freshness: (reading): ReadonlyArray<Freshness> => freshOf(reading.shown),
      placed: sessionsPlaced,
    }),
  run: () => runSessionQuotaPanel,
  print: (_, frame) => printSessionQuotaFrame(frame.width, frame.height, frame.color),
});
