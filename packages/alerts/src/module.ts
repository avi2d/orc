import { DateTime, Effect, type FileSystem } from "effect";
import { AlertSettings, loopTick } from "@tui-dash/schema";
import {
  type Block,
  boxOf,
  boxRoom,
  everyText,
  frameRows,
  mountedOf,
  panelChrome,
  panelModule,
  type PanelModule,
  type Placed,
  runSolo,
  singleTitle,
  truncate,
} from "@tui-dash/ui";
import { alertsReader, printAlertsFrame } from "./app";
import { type AlertReadings, alertsSection, alertsSummary } from "./panels";

export interface AlertsReading {
  readonly alerts: AlertReadings;
  readonly now: DateTime.Utc;
}

// The box's title already says alerts, so the section's own first line gives way, keeping any trouble it reports.
const withoutTitle = (block: Block): Block => {
  const [head = [], ...rest] = block;
  const trouble = head.slice(1).map((part, index) => (index === 0 ? { ...part, text: part.text.replace(/^ \u00b7 /u, "") } : part));
  return trouble.length === 0 ? rest : [trouble, ...rest];
};

// The alerts keep a row per rule whatever the room, so the summary is the least the box gives way to.
export const alertsPlaced = (reading: () => AlertsReading): Placed => {
  const whole = (inner: number): Block => withoutTitle(alertsSection(reading().alerts, reading().now, inner));
  const summary = (inner: number): Block => withoutTitle(alertsSummary(reading().alerts, reading().now, inner));
  return {
    box: (size, look) => {
      const inner = size.columns - panelChrome;
      const full = whole(inner);
      const lines = full.length <= boxRoom(size, look) ? full : summary(inner);
      return { block: boxOf(singleTitle("alerts", everyText(loopTick), size.columns, look.focused, "a"), lines, size, look), targets: [] };
    },
    natural: (width) => whole(width - panelChrome).length + frameRows,
    least: (width) => summary(width - panelChrome).length + frameRows,
    glance: (width) => [
      alertsSection(reading().alerts, reading().now, width).map((line) => truncate(line, width)),
      alertsSummary(reading().alerts, reading().now, width),
    ],
  };
};

const mountAlerts = (settings: AlertSettings) =>
  Effect.flatMap(alertsReader(settings), (readAlerts) =>
    mountedOf({
      name: "alerts",
      key: "a",
      cadence: loopTick,
      reach: "none",
      read: Effect.all({ alerts: readAlerts, now: DateTime.now }),
      pending: () => false,
      refreshing: () => false,
      freshness: () => [],
      placed: alertsPlaced,
    }),
  );

export const alertsModule: PanelModule<FileSystem.FileSystem> = panelModule<AlertSettings, FileSystem.FileSystem>({
  id: "alerts",
  about: "the alert rules and the last time each one fired",
  settings: AlertSettings,
  mount: mountAlerts,
  run: (settings) => runSolo(mountAlerts(settings)),
  print: (settings, frame) => printAlertsFrame(settings, frame.width, frame.height, frame.color),
});
