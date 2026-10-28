import { Duration, Effect, Layer } from "effect";
import { type Freshness, freshOf, QueueFeed, QueuesCodec, ReadModeReference, readsCadence, type SavedReadings, savedStandIn } from "@tui-dash/schema";
import { backgroundQueueReadings, type QueueSources, readQueueReadings } from "./app";

export const queueFeedLayer: Layer.Layer<QueueFeed, never, QueueSources | SavedReadings> = Layer.effect(
  QueueFeed,
  Effect.gen(function* () {
    const live = (yield* ReadModeReference) === "live";
    const services = yield* Effect.context<QueueSources>();
    const readings = live
      ? yield* backgroundQueueReadings({ patience: Duration.zero, revalidate: readsCadence })
      : { read: yield* Effect.cached(Effect.provideContext(readQueueReadings, services)), refreshing: Effect.succeed(false) };
    const standIn = yield* savedStandIn("queues", QueuesCodec);
    return {
      read: Effect.gen(function* () {
        const { fresh, answered, freshness } = yield* readings.read;
        const shown = yield* standIn(answered);
        const held: ReadonlyArray<Freshness> = shown.kind !== "saved" && freshness.length > 0 ? freshness : freshOf(shown);
        return { shown, fresh, freshness: held };
      }),
      refreshing: readings.refreshing,
    };
  }),
);
