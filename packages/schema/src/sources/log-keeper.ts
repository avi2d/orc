import { Effect, type FileSystem, Option, Result, Schema } from "effect";
import { LogRecord } from "../sessions/log-lines";
import type { Grown } from "./append-only";

export type LogRead = Grown<LogRecord>;

// Bump it whenever markedLogRecords would read the same bytes into other records, or a kept copy goes on serving the old reading.
const formatVersion = 1;

const KeptLogs = Schema.toCodecJson(
  Schema.Struct({
    version: Schema.Literal(formatVersion),
    files: Schema.Record(
      Schema.String,
      Schema.Struct({ size: Schema.Finite, modifiedAt: Schema.Finite, consumed: Schema.Finite, records: Schema.Array(LogRecord) }),
    ),
  }),
);

export interface LogKeeper {
  readonly load: Effect.Effect<ReadonlyMap<string, LogRead>>;
  readonly keep: (reads: ReadonlyMap<string, LogRead>) => Effect.Effect<void>;
}

// A torn copy, another version's or none at all reads as no copy, so the read starts cold and its keep replaces the file.
const keptReads = (raw: string): ReadonlyMap<string, LogRead> => {
  const parsed = Result.try((): unknown => JSON.parse(raw));
  if (Result.isFailure(parsed)) return new Map();
  return Option.match(Schema.decodeUnknownOption(KeptLogs)(parsed.success), {
    onNone: () => new Map(),
    onSome: (kept) => new Map(Object.entries(kept.files)),
  });
};

// The copy is written beside the file and renamed over it, so a reader sees the whole old copy or the whole new one.
export const fileLogKeeper = (fs: FileSystem.FileSystem, directory: string, name: string): LogKeeper => {
  const file = `${directory}/${name}`;
  return {
    load: fs.readFileString(file).pipe(Effect.map(keptReads), Effect.orElseSucceed((): ReadonlyMap<string, LogRead> => new Map())),
    keep: (reads) =>
      Effect.gen(function* () {
        const encoded = yield* Schema.encodeEffect(KeptLogs)({ version: formatVersion, files: Object.fromEntries(reads) });
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
        const staged = `${file}.${crypto.randomUUID()}`;
        yield* fs.writeFileString(staged, JSON.stringify(encoded), { mode: 0o600 }).pipe(
          Effect.andThen(fs.rename(staged, file)),
          Effect.onError(() => fs.remove(staged).pipe(Effect.catchTag("PlatformError", () => Effect.void))),
        );
      }).pipe(Effect.catchTags({ PlatformError: () => Effect.void, SchemaError: () => Effect.void })),
  };
};
