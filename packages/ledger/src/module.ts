import { DateTime, Effect, type FileSystem, Option } from "effect";
import { type Freshness, polled, readsCadence } from "@tui-dash/schema";
import {
  type Drawn,
  frameRows,
  mountedOf,
  noSettings,
  type NoSettings,
  panelModule,
  type PanelModule,
  type Placed,
  printSolo,
  runSolo,
} from "@tui-dash/ui";
import { ConversationSource } from "./conversation";
import { closedPick, type LedgerColumn, ledgerColumn, ledgerFullColumn, ledgerNatural, type LedgerPick, type LedgerReadings } from "./ledger-column";
import { ledgerMoved, ledgerSettled, ledgerToggled } from "./ledger-moves";

export const ledgerPlaced = (reading: () => LedgerReadings, pick: LedgerPick = closedPick, badges = 0): Placed => {
  let below = badges;
  const drawn = (column: LedgerColumn, width: number): Drawn<Placed> => ({
    block: column.block,
    targets: column.targets.map((target) => ({ row: target.row, from: 2, to: width - 2, state: ledgerPlaced(reading, target.open) })),
  });
  return {
    box: (size, look) => {
      below = look.below.length;
      return drawn(ledgerColumn(reading(), pick, look, size.columns, size.rows), size.columns);
    },
    natural: () => ledgerNatural(reading()),
    least: () => frameRows + 1,
    glance: () => [],
    move: (move, size) => {
      const moved = ledgerMoved(reading(), pick, move, size, below);
      return moved === undefined ? undefined : ledgerPlaced(reading, moved, below);
    },
    press: (key) => (key === "l" ? ledgerPlaced(reading, ledgerToggled(pick), below) : ledgerPlaced(reading, pick, below)),
    blur: () => ledgerPlaced(reading, ledgerSettled(pick), below),
    whole: (size) => (pick.full ? drawn(ledgerFullColumn(reading(), pick, size.columns, size.rows), size.columns) : undefined),
  };
};

type LedgerSources = ConversationSource | FileSystem.FileSystem;

const readFeed = (zone: DateTime.TimeZone) =>
  Effect.gen(function* () {
    const conversation = yield* ConversationSource;
    return yield* conversation.read(yield* DateTime.now, zone);
  });

const mountLedger = Effect.gen(function* () {
  const zone = DateTime.zoneMakeLocal();
  const feed = yield* polled(readFeed(zone), readsCadence);
  const readLedger = Effect.gen(function* () {
    const latest = yield* feed.latest;
    const now = yield* DateTime.now;
    yield* Effect.yieldNow;
    const refreshing = yield* feed.refreshing;
    if (Option.isNone(latest)) return { readings: { sessions: "pending", ledger: [], now, zone } satisfies LedgerReadings, shown: undefined, refreshing };
    const { value: read, at } = latest.value;
    const readings: LedgerReadings = { sessions: read.sessions, ledger: read.sessions === "set" ? read.said : [], now, zone };
    return { readings, shown: { kind: "live" as const, at }, refreshing };
  });
  return yield* mountedOf({
    name: "ledger",
    key: "l",
    cadence: readsCadence,
    reach: "key",
    read: readLedger,
    pending: (reading) => reading.readings.sessions === "pending",
    refreshing: (reading) => reading.refreshing,
    freshness: (reading): ReadonlyArray<Freshness> => (reading.shown === undefined ? [] : [{ at: reading.shown.at, kind: reading.shown.kind }]),
    placed: (reading) => ledgerPlaced(() => reading().readings),
  });
});

export const ledgerModule: PanelModule<LedgerSources> = panelModule<NoSettings, LedgerSources>({
  id: "ledger",
  about: "today's conversation with one agent, read from its session files",
  settings: noSettings,
  mount: () => mountLedger,
  run: () => runSolo(mountLedger),
  print: (_, frame) => printSolo(mountLedger, frame),
});
