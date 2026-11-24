import type { CliRenderer } from "@opentui/core";
import { DateTime, Effect } from "effect";
import { type HarvestLogSource, OrcQuotaSource, type QuotaBlock, type QuotaSource, quotaBlocks, readQuota } from "@avi2dg/orc-schema";
import {
  type Block,
  livePanel as liveUiPanel,
  type Panel,
  panelWidth,
  printFrame,
  runPanel,
  withinRows,
} from "@avi2dg/orc-ui";
import { quotaLines } from "./quotas";

type QuotaPanelSources = QuotaSource | HarvestLogSource | OrcQuotaSource;

interface Readings {
  readonly blocks: ReadonlyArray<QuotaBlock>;
  readonly now: DateTime.Utc;
}

const readBlocks: Effect.Effect<Readings, never, QuotaPanelSources> = Effect.gen(function* () {
  const orcQuotaSource = yield* OrcQuotaSource;
  const [quota, orcQuota] = yield* Effect.all([readQuota, orcQuotaSource.read], { concurrency: "unbounded" });
  const now = yield* DateTime.now;
  return { blocks: quotaBlocks(quota, orcQuota, now), now };
});

const panelLines = (readings: Readings, columns: number, rows: number): Block =>
  withinRows(quotaLines(readings.blocks, panelWidth(columns), true, readings.now), rows);

const quotaPanel: Panel<Readings, QuotaPanelSources> = { read: readBlocks, lines: panelLines };

export const livePanel = (renderer: CliRenderer): Effect.Effect<void, never, QuotaPanelSources> =>
  liveUiPanel(renderer, quotaPanel, "30 seconds");

export const runQuotaPanel: Effect.Effect<void, never, QuotaPanelSources> = runPanel(quotaPanel, "30 seconds");

export const printQuotaFrame = (width: number, height: number = Number.POSITIVE_INFINITY, color = false): Effect.Effect<void, never, QuotaPanelSources> =>
  printFrame(quotaPanel, width, height, color);
