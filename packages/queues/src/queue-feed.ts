import { Duration, Effect, Layer, Option } from "effect";
import { type Freshness, freshOf, QueueFeed, QueuesCodec, type QueueReadings, ReadModeReference, readsCadence, SavedReadings, shownOf } from "@avi2dg/orc-schema";
import { backgroundQueueReadings, type QueueSources, readQueueReadings } from "./app";

type SavedQueues = typeof QueuesCodec.Type;

const toSaved = (readings: QueueReadings): SavedQueues => ({
  machines: readings.machines.map(({ name, status }) => ({ name, status })),
  actions: readings.actions,
});

const fromSaved = (saved: SavedQueues): QueueReadings => ({
  machines: saved.machines.map((machine) => ({ ...machine, heavy: Option.none() })),
  actions: saved.actions,
});

export const queueFeedLayer: Layer.Layer<QueueFeed, never, QueueSources | SavedReadings> = Layer.effect(
  QueueFeed,
  Effect.gen(function* () {
    const live = (yield* ReadModeReference) === "live";
    const services = yield* Effect.context<QueueSources>();
    const readings = live
      ? yield* backgroundQueueReadings({ patience: Duration.zero, revalidate: readsCadence })
      : { read: yield* Effect.cached(Effect.provideContext(readQueueReadings, services)), refreshing: Effect.succeed(false) };
    const slot = (yield* SavedReadings).slot("queues", QueuesCodec);
    const last = yield* Effect.cached(slot.last);
    return {
      read: Effect.gen(function* () {
        const { fresh, answered, freshness } = yield* readings.read;
        if (Option.isSome(answered)) yield* slot.keep(toSaved(answered.value.value), answered.value.at);
        const saved = Option.map(yield* last, (stamped) => ({ value: fromSaved(stamped.value), at: stamped.at }));
        const shown = shownOf(answered, saved);
        const held: ReadonlyArray<Freshness> = shown.kind !== "saved" && freshness.length > 0 ? freshness : freshOf(shown);
        return { shown, fresh, freshness: held };
      }),
      refreshing: readings.refreshing,
    };
  }),
);
