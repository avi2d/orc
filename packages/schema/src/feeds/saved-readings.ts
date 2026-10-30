import { Clock, type Config, Effect, FileSystem, Layer, Option, type PlatformError, Result, Schema } from "effect";
import { dashboardCacheDirectory } from "../sources/environment";
import { type SavedSlot, SavedReadings, type Stamped } from "./feed";

// A copy written more often than this only wears the disk, since a restart within it loses little.
const keepWindowMillis = 10_000;

const StampedOf = <A>(codec: Schema.Codec<A, unknown>) => Schema.toCodecJson(Schema.Struct({ value: codec, at: Schema.Finite }));

// A copy from another shape or a torn write is no copy, so it reads as a cold start.
const decodedOf = <A>(raw: string, codec: Schema.Codec<Stamped<A>, unknown>): Option.Option<Stamped<A>> => {
  const parsed = Result.try((): unknown => JSON.parse(raw));
  return Result.isSuccess(parsed) ? Schema.decodeUnknownOption(codec)(parsed.success) : Option.none();
};

const fileSlot = <A>(fs: FileSystem.FileSystem, directory: string, key: string, codec: Schema.Codec<A, unknown>): SavedSlot<A> => {
  const file = `${directory}/${key}.json`;
  const json = StampedOf(codec);
  let keptAt = Number.NEGATIVE_INFINITY;
  const read: Effect.Effect<Option.Option<Stamped<A>>, PlatformError.PlatformError> = Effect.map(fs.readFileString(file), (raw) => decodedOf(raw, json));
  const write = (stamped: Stamped<A>): Effect.Effect<void, PlatformError.PlatformError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(json)(stamped);
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      yield* fs.writeFileString(file, JSON.stringify(encoded), { mode: 0o600 });
    });
  return {
    last: Effect.catchTag(read, "PlatformError", () => Effect.succeedNone),
    keep: (value, at) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now - keptAt < keepWindowMillis) return;
        keptAt = now;
        yield* Effect.catchTags(write({ value, at }), { PlatformError: () => Effect.void, SchemaError: () => Effect.void });
      }),
  };
};

export const savedReadingsLayer: Layer.Layer<SavedReadings, Config.ConfigError, FileSystem.FileSystem> = Layer.effect(
  SavedReadings,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* dashboardCacheDirectory;
    return { slot: (key, codec) => fileSlot(fs, directory, key, codec) };
  }),
);

export const noSavedReadings: Layer.Layer<SavedReadings> = Layer.succeed(SavedReadings, {
  slot: () => ({ last: Effect.succeedNone, keep: () => Effect.void }),
});
