import { DateTime, Effect, type FileSystem, Option, type PlatformError, type Schema } from "effect";
import {
  type CaptureRecord,
  type ClaudeCodeReadingRecord,
  captureRecords,
  currentAndPreviousDayFiles,
  dayFileOf,
  dayFiles,
  encodeCaptureRecord,
  expiredDayFiles,
  type LedgerFile,
  lastReadingOf,
  sameReading,
} from "../sessions/capture";
import { bytesBetween, decodedLines, type Grown, grownRecords, wholeLines } from "./append-only";

const listedLedger = (fs: FileSystem.FileSystem, directory: string) =>
  fs.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

export interface DayFile<R> {
  readonly path: string;
  readonly records: ReadonlyArray<R>;
}

export const dayFileReaderAt = <R>(
  fs: FileSystem.FileSystem,
  directory: string,
  parse: (text: string) => ReadonlyArray<R>,
): ((select: (names: ReadonlyArray<string>) => ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<DayFile<R>>>) => {
  const cache = new Map<string, Grown<R>>();
  return (select) => Effect.gen(function* () {
    const names = yield* listedLedger(fs, directory);
    const files: Array<DayFile<R>> = [];
    for (const name of select(names)) {
      const path = `${directory}/${name}`;
      const info = yield* Effect.option(fs.stat(path));
      if (Option.isNone(info)) continue;
      const modifiedAt = Option.match(info.value.mtime, { onNone: () => 0, onSome: (date) => date.getTime() });
      const listed = { path, size: Number(info.value.size), modifiedAt };
      const current = yield* grownRecords(fs, listed, cache.get(path), decodedLines(parse));
      if (current === undefined) continue;
      cache.set(path, current);
      files.push({ path, records: current.records });
    }
    const present = new Set(names.map((name) => `${directory}/${name}`));
    for (const path of cache.keys()) if (!present.has(path)) cache.delete(path);
    return files;
  });
};

// A repeat is dated by its first sighting, which can sit in any day file the ledger keeps, so every read takes them all.
export const ledgerReaderAt = (fs: FileSystem.FileSystem, directory: string): Effect.Effect<ReadonlyArray<LedgerFile>> =>
  dayFileReaderAt(fs, directory, captureRecords)(dayFiles);

const tailBytes = 65_536;

const tailRecords = (fs: FileSystem.FileSystem, path: string) =>
  Effect.gen(function* () {
    const size = Number((yield* fs.stat(path)).size);
    const from = Math.max(0, size - tailBytes);
    const bytes = yield* bytesBetween(fs, path, from, size);
    const start = from === 0 ? 0 : bytes.indexOf(10) + 1;
    return captureRecords(wholeLines(bytes.subarray(start)));
  });

// The statusline reruns every 30 seconds, so the writer drops repeats from two day file tails only to keep the ledger small; the reader alone dates a repeat by its first sighting.
const lastSessionReading = (
  fs: FileSystem.FileSystem,
  directory: string,
  names: ReadonlyArray<string>,
  record: ClaudeCodeReadingRecord,
) =>
  Effect.gen(function* () {
    for (const name of currentAndPreviousDayFiles(names, DateTime.toEpochMillis(record.at))) {
      const last = lastReadingOf(yield* tailRecords(fs, `${directory}/${name}`), record);
      if (last !== undefined) return last;
    }
    return undefined;
  });

// Two writers can start the same day together, so the second finds the file the first already removed.
export const prunedDayFiles = (
  fs: FileSystem.FileSystem,
  directory: string,
  expired: ReadonlyArray<string>,
): Effect.Effect<void> =>
  Effect.forEach(
    expired,
    (name) => fs.remove(`${directory}/${name}`).pipe(Effect.catchTag("PlatformError", () => Effect.void)),
    { discard: true },
  );

// One write of one line under O_APPEND lands whole beside other writers, which a rewrite of the file would race.
export const appendCaptured = (
  fs: FileSystem.FileSystem,
  directory: string,
  record: CaptureRecord,
): Effect.Effect<void, PlatformError.PlatformError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const at = DateTime.toEpochMillis(record.at);
    const day = dayFileOf(at);
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const names = yield* fs.readDirectory(directory);
    // Claude Code reruns its statusline on a timer, so a reading that repeats the session's last one adds nothing.
    if (record.kind === "claude-code-reading") {
      const last = yield* lastSessionReading(fs, directory, names, record);
      if (last !== undefined && sameReading(last, record)) return;
    }
    yield* fs.writeFileString(`${directory}/${day}`, `${yield* encodeCaptureRecord(record)}\n`, { flag: "a", mode: 0o600 });
    if (!names.includes(day)) yield* prunedDayFiles(fs, directory, expiredDayFiles(names, at));
  });
