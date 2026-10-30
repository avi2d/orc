import { Effect, type FileSystem, type PlatformError, Stream } from "effect";

export interface Listed {
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: number;
}

export interface Grown<R> {
  readonly size: number;
  readonly modifiedAt: number;
  readonly consumed: number;
  readonly records: ReadonlyArray<R>;
}

const newline = 10;

export const bytesBetween = (
  fs: FileSystem.FileSystem,
  path: string,
  from: number,
  to: number,
): Effect.Effect<Uint8Array, PlatformError.PlatformError> =>
  // The stream's default 64 KiB chunks cost an effect step per chunk, which over a window of session logs is most of a paint.
  fs.stream(path, { offset: from, bytesToRead: to - from, chunkSize: Math.max(to - from, 1) }).pipe(
    Stream.runCollect,
    Effect.map((chunks) => {
      if (chunks.length === 1) return chunks[0];
      const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
      let at = 0;
      for (const chunk of chunks) {
        joined.set(chunk, at);
        at += chunk.length;
      }
      return joined;
    }),
  );

const wholeLineBytes = (bytes: Uint8Array): Uint8Array => bytes.subarray(0, bytes.lastIndexOf(newline) + 1);

export const wholeLines = (bytes: Uint8Array): string => new TextDecoder().decode(wholeLineBytes(bytes));

export const decodedLines =
  <R>(parse: (text: string) => ReadonlyArray<R>) =>
  (lines: Uint8Array): ReadonlyArray<R> =>
    parse(new TextDecoder().decode(lines));

// The file is append-only, so one that grew is read from where the last read stopped, and one that shrank was replaced.
export const readGrown = <R>(
  fs: FileSystem.FileSystem,
  entry: Listed,
  cached: Grown<R> | undefined,
  parse: (lines: Uint8Array) => ReadonlyArray<R>,
): Effect.Effect<Grown<R>, PlatformError.PlatformError> => {
  if (cached !== undefined && cached.size === entry.size && cached.modifiedAt === entry.modifiedAt) {
    return Effect.succeed(cached);
  }
  const resumed = cached !== undefined && entry.size >= cached.size ? cached : undefined;
  const from = resumed?.consumed ?? 0;
  return bytesBetween(fs, entry.path, from, entry.size).pipe(
    Effect.map((bytes): Grown<R> => {
      const lines = wholeLineBytes(bytes);
      return {
        size: entry.size,
        modifiedAt: entry.modifiedAt,
        consumed: from + lines.length,
        records: [...(resumed?.records ?? []), ...parse(lines)],
      };
    }),
  );
};

// A failed read keeps the last good reading, whose size and time differ from the entry's, so the next poll reads again.
export const grownRecords = <R>(
  fs: FileSystem.FileSystem,
  entry: Listed,
  cached: Grown<R> | undefined,
  parse: (lines: Uint8Array) => ReadonlyArray<R>,
): Effect.Effect<Grown<R> | undefined> => readGrown(fs, entry, cached, parse).pipe(Effect.orElseSucceed(() => cached));
