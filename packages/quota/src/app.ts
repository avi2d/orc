import type { CliRenderer } from "@opentui/core";
import { DateTime, Effect } from "effect";
import { type QuotaBlock, type QuotaReadSources, quotaBlocks, readQuotas } from "@tui-dash/schema";
import {
  type Block,
  livePanel as liveUiPanel,
  type Panel,
  panelWidth,
  printFrame,
  runPanel,
  withinRows,
} from "@tui-dash/ui";
import { quotaLines } from "./quotas";

interface Readings {
  readonly blocks: ReadonlyArray<QuotaBlock>;
  readonly now: DateTime.Utc;
}

const readBlocks: Effect.Effect<Readings, never, QuotaReadSources> = Effect.gen(function* () {
  const { quota, savedProfiles } = yield* readQuotas;
  const now = yield* DateTime.now;
  return { blocks: quotaBlocks(quota, savedProfiles, now), now };
});

const panelLines = (readings: Readings, columns: number, rows: number): Block =>
  withinRows(quotaLines(readings.blocks, panelWidth(columns), true, readings.now), rows);

const quotaPanel: Panel<Readings, QuotaReadSources> = { read: readBlocks, lines: panelLines };

export const livePanel = (renderer: CliRenderer): Effect.Effect<void, never, QuotaReadSources> =>
  liveUiPanel(renderer, quotaPanel, "30 seconds");

export const runQuotaPanel: Effect.Effect<void, never, QuotaReadSources> = runPanel(quotaPanel, "30 seconds");

export const printQuotaFrame = (width: number, height: number = Number.POSITIVE_INFINITY, color = false): Effect.Effect<void, never, QuotaReadSources> =>
  printFrame(quotaPanel, width, height, color);
