import { DateTime, Effect } from "effect";
import { type Freshness, freshOf, type QuotaBlock, QuotaFeed, type QuotaReadSources, readsCadence, type Shown, shownValue } from "@tui-dash/schema";
import {
  type Block,
  boxOf,
  boxRoom,
  countdownFrom,
  everyText,
  fittedRows,
  frameRows,
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
import { printQuotaFrame, runQuotaPanel } from "./app";
import { quotaSection, reserveQuotaSection } from "./sections";

export interface QuotaReading {
  readonly shown: Shown<ReadonlyArray<QuotaBlock>>;
  readonly now: DateTime.Utc;
  readonly refreshing: boolean;
}

const savedCount = (blocks: ReadonlyArray<QuotaBlock>): number => blocks.filter((block) => block.body.kind === "saved").length;

// The quota folds its saved profiles first, so under pressure it gives way while its live rows stay.
const leastRows = frameRows + 2;

const readingLines: Block = [[span("reading the quota\u2026", "muted")]];

export const quotaPlaced = (reading: () => QuotaReading): Placed => {
  const blocks = (): ReadonlyArray<QuotaBlock> => shownValue(reading().shown) ?? [];
  const firstReadInFlight = (): boolean => blocks().length === 0 && reading().shown.kind === "pending";
  const boxSections = (inner: number): ReadonlyArray<Block> =>
    countdownFrom(savedCount(blocks())).map((shown) => reserveQuotaSection(blocks(), inner, reading().now, shown));
  return {
    box: (size, look) => {
      const title = singleTitle("quota", everyText(readsCadence), size.columns, look.focused);
      const lines = firstReadInFlight() ? readingLines : fittedRows(boxSections(size.columns - panelChrome), boxRoom(size, look));
      return { block: boxOf(title, lines, size, look), targets: [] };
    },
    natural: (width) => (boxSections(width - panelChrome).at(0)?.length ?? 0) + frameRows,
    least: () => leastRows,
    glance: (width) => (firstReadInFlight() ? [readingLines] : countdownFrom(savedCount(blocks())).map((shown) => quotaSection(blocks(), width, reading().now, shown))),
  };
};

const readQuotaShown: Effect.Effect<QuotaReading, never, QuotaFeed> = Effect.gen(function* () {
  const feed = yield* QuotaFeed;
  const shown = yield* feed.blocks;
  const now = yield* DateTime.now;
  yield* Effect.yieldNow;
  return { shown, now, refreshing: yield* feed.refreshing };
});

export const quotaModule: PanelModule<QuotaReadSources | QuotaFeed> = panelModule<NoSettings, QuotaReadSources | QuotaFeed>({
  id: "quota",
  about: "quota left on each subscription and when it runs out",
  settings: noSettings,
  mount: () =>
    mountedOf({
      name: "quota",
      cadence: readsCadence,
      reach: "none",
      read: readQuotaShown,
      pending: (reading) => reading.shown.kind !== "live",
      refreshing: (reading) => reading.refreshing,
      freshness: (reading): ReadonlyArray<Freshness> => freshOf(reading.shown),
      placed: quotaPlaced,
    }),
  run: () => runQuotaPanel,
  print: (_, frame) => printQuotaFrame(frame.width, frame.height, frame.color),
});
