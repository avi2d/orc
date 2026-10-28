import type { CliRenderer } from "@opentui/core";
import { Console, DateTime, Effect, Option, Ref, Schedule } from "effect";
import {
  composedSessionQuotaOf,
  type ComposedSessionQuotaReport,
  composedSessionQuotaReport,
  localSessionQuotaOf,
  readQuotas,
  SessionMachines,
  type SessionQuotaFlag,
  sessionQuotaAlerts,
  sessionQuotaFlags,
  sessionQuotaOf,
  sessionQuotaReport,
  type SessionQuotaSources,
  type SessionQuotaView,
  inBackground,
} from "@tui-dash/schema";
import {
  type Block,
  livePanel as liveUiPanel,
  type Panel,
  panelWidth,
  printFrame,
  runPanel,
  withinRows,
} from "@tui-dash/ui";
import { printedSessions, scanningLines, sessionLines, sessionLinesWithin } from "./sessions";

const refresh = "30 seconds";

const patience = "2 seconds";

const readSessionQuota: Effect.Effect<SessionQuotaView, never, SessionQuotaSources> = sessionQuotaOf(readQuotas);

const readLocalSessionQuota: Effect.Effect<SessionQuotaView, never, SessionQuotaSources> = localSessionQuotaOf(readQuotas);

export const sessionPanelLines = (view: Option.Option<SessionQuotaView>, width: number, now?: DateTime.Utc): Block =>
  Option.match(view, { onNone: () => scanningLines(width), onSome: (found) => sessionLines(found, width, Number.POSITIVE_INFINITY, now ?? found.now) });

export const sessionPanelWithin = (view: Option.Option<SessionQuotaView>, width: number, rows: number, most: number, now?: DateTime.Utc): Block =>
  Option.match(view, {
    onNone: () => withinRows(scanningLines(width), rows),
    onSome: (found) => sessionLinesWithin(found, width, rows, most, now ?? found.now),
  });

// The first read of a week of logs takes seconds, so the live panel paints the scanning state rather than a blank screen.
const backgroundSessionQuota = inBackground(() => readSessionQuota, patience);

const livePanelOf = (
  background: (input: undefined) => Effect.Effect<Option.Option<SessionQuotaView>, never, SessionQuotaSources>,
): Panel<Option.Option<SessionQuotaView>, SessionQuotaSources> => ({
  read: background(undefined),
  lines: (view, columns, rows) => sessionPanelWithin(view, panelWidth(columns), rows, Number.POSITIVE_INFINITY, DateTime.makeUnsafe(Date.now())),
  pending: Option.isNone,
});

export const livePanel = (renderer: CliRenderer): Effect.Effect<void, never, SessionQuotaSources> =>
  Effect.scoped(Effect.flatMap(backgroundSessionQuota, (background) => liveUiPanel(renderer, livePanelOf(background), refresh)));

export const runSessionQuotaPanel: Effect.Effect<void, never, SessionQuotaSources> = Effect.scoped(
  Effect.flatMap(backgroundSessionQuota, (background) => runPanel(livePanelOf(background), refresh)),
);

const printedPanel: Panel<SessionQuotaView, SessionQuotaSources> = {
  read: readSessionQuota,
  lines: (view, columns, rows) => withinRows(sessionLines(view, panelWidth(columns), printedSessions), rows),
};

export const printSessionQuotaFrame = (width: number, height: number = Number.POSITIVE_INFINITY, color = false): Effect.Effect<void, never, SessionQuotaSources> =>
  printFrame(printedPanel, width, height, color);

export const printSessionQuotaJson: Effect.Effect<void, never, SessionQuotaSources> = Effect.flatMap(
  readLocalSessionQuota,
  (view) => Console.log(JSON.stringify(sessionQuotaReport(view))),
);

export const readComposedSessionQuotaReport: Effect.Effect<ComposedSessionQuotaReport, never, SessionQuotaSources> = Effect.gen(
  function* () {
    const machines = yield* SessionMachines;
    const view = yield* composedSessionQuotaOf(readQuotas);
    return composedSessionQuotaReport(view, machines.local);
  },
);

export const printComposedSessionQuotaJson: Effect.Effect<void, never, SessionQuotaSources> = Effect.flatMap(
  readComposedSessionQuotaReport,
  (report) => Console.log(JSON.stringify(report)),
);

const alertRound = (shown: Ref.Ref<ReadonlyArray<SessionQuotaFlag>>) =>
  Effect.gen(function* () {
    const view = yield* readLocalSessionQuota;
    const flags = sessionQuotaFlags(view);
    const before = yield* Ref.getAndSet(shown, flags);
    yield* Effect.forEach(sessionQuotaAlerts(before, flags, view.now), (alert) => Console.log(JSON.stringify(alert)), {
      discard: true,
    });
  });

export const streamSessionQuotaAlerts: Effect.Effect<void, never, SessionQuotaSources> = Effect.gen(function* () {
  const shown = yield* Ref.make<ReadonlyArray<SessionQuotaFlag>>([]);
  yield* alertRound(shown).pipe(Effect.repeat(Schedule.spaced(refresh)));
});
