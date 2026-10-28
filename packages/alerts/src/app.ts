import { DateTime, Effect, FileSystem } from "effect";
import { type AlertSettings, alertVerdictsPath, mapOutcome, unreachable, verdictLogReaderAt } from "@tui-dash/schema";
import { printFrame, withinRows } from "@tui-dash/ui";
import { type AlertReadings, alertsSection, type LogReading } from "./panels";

const readerOfLog: Effect.Effect<Effect.Effect<LogReading>, never, FileSystem.FileSystem> = Effect.all([FileSystem.FileSystem, alertVerdictsPath]).pipe(
  Effect.map(([fs, path]) => Effect.map(verdictLogReaderAt(fs, path), (log) => mapOutcome(log, (read) => ({ path, log: read })))),
  Effect.catchTag("ConfigError", (error) => Effect.succeed(Effect.succeed(unreachable(`the verdict log cannot be found: ${error.message}`)))),
);

export const alertsReader = (settings: AlertSettings): Effect.Effect<Effect.Effect<AlertReadings>, never, FileSystem.FileSystem> =>
  Effect.map(readerOfLog, (readLog) => Effect.map(readLog, (verdicts) => ({ settings, verdicts })));

export const printAlertsFrame = (settings: AlertSettings, width: number, height: number = Number.POSITIVE_INFINITY, color = false): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.flatMap(alertsReader(settings), (readAlerts) =>
    printFrame({ read: Effect.all({ alerts: readAlerts, now: DateTime.now }), lines: ({ alerts, now }, columns, rows) => withinRows(alertsSection(alerts, now, columns), rows) }, width, height, color),
  );
