import { Effect, Option, type Scope } from "effect";
import { type AttentionQueue, AttentionSource, type Outcome, readsCadence } from "@avi2dg/orc-schema";
import {
  type Block,
  failureRows,
  type Label,
  labelledReadings,
  leastLabelWidth,
  listPlaced,
  type Mounted,
  mountPolled,
  noSettings,
  type NoSettings,
  panelModule,
  type PanelModule,
  type Placed,
  type PolledReading,
  printSolo,
  reading,
  runSolo,
  sentence,
} from "@avi2dg/orc-ui";
import { attentionLines, nothingOpen } from "./lines";

type AttentionReading = PolledReading<Outcome<AttentionQueue>>;

const label: Label = { text: "attention", width: leastLabelWidth };

const glanceOf = (queue: Outcome<AttentionQueue>, width: number): Block => {
  if (queue.kind !== "ok") return failureRows(label, queue, width);
  const { items } = queue.value;
  if (items.length === 0) return labelledReadings(label, [reading("muted", nothingOpen)], width);
  const overdue = items.filter((item) => item.overdue).length;
  return labelledReadings(label, [reading("foreground", items.length + " open"), ...(overdue === 0 ? [] : [reading("error", overdue + " overdue")])], width);
};

const attentionPlaced = (latest: () => AttentionReading): Placed =>
  listPlaced({
    name: "attention",
    key: "t",
    cadence: readsCadence,
    lines: (inner, room) =>
      Option.match(latest().latest, {
        onNone: () => sentence("reading the attention queue\u2026", "muted", inner),
        onSome: (stamped) => attentionLines(stamped.value, inner, room),
      }),
    glance: (width) => [
      Option.match(latest().latest, {
        onNone: () => labelledReadings(label, [reading("muted", "reading\u2026")], width),
        onSome: (stamped) => glanceOf(stamped.value, width),
      }),
    ],
  });

const mountAttention: Effect.Effect<Mounted, never, AttentionSource | Scope.Scope> = Effect.gen(function* () {
  const source = yield* AttentionSource;
  return yield* mountPolled({ name: "attention", key: "t", cadence: readsCadence, read: source.read, placed: attentionPlaced });
});

export const attentionModule: PanelModule<AttentionSource> = panelModule<NoSettings, AttentionSource>({
  id: "attention",
  about: "every open item of the orc attention queue, oldest first, with its owner, age and overdue mark",
  settings: noSettings,
  mount: () => mountAttention,
  run: () => runSolo(mountAttention),
  print: (_, frame) => printSolo(mountAttention, frame),
});
