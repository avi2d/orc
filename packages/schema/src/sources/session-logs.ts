import { Clock, Config, Context, Effect, FileSystem, Layer, Option } from "effect";
import type { ClaudeAccount } from "../contract/config";
import { type Captured, capturedOf } from "../sessions/capture";
import type { LogFile } from "../sessions/ledger";
import { type Harness, markedLogRecords, type SinceByHarness } from "../sessions/log-lines";
import { grownRecords, type Listed as ListedFile } from "./append-only";
import { ledgerReaderAt } from "./capture-ledger";
import { captureLedgerDirectory, claudeConfigDirectory, claudeLogged, selector, sessionLogsCacheDirectory } from "./environment";
import { fileLogKeeper, type LogKeeper, type LogRead } from "./log-keeper";

export type { SinceByHarness };

export type LogRoots = Readonly<Record<Harness, string>>;

export interface SessionLogs {
  readonly home: string;
  readonly roots: LogRoots;
  readonly files: ReadonlyArray<LogFile>;
  readonly captured: Captured;
}

const logFiles = {
  pi: /^[^/]+\/[^/]+\.jsonl$/,
  "claude-code": /^[^/]+\/(?:[^/]+\/subagents\/)?[^/]+\.jsonl$/,
  codex: /^\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/,
} satisfies Record<Harness, RegExp>;

export const homeLogRoots = (home: string): LogRoots => ({
  pi: `${home}/.pi/agent/sessions`,
  "claude-code": `${home}/.claude/projects`,
  codex: `${home}/.codex/sessions`,
});

const harnesses = ["pi", "claude-code", "codex"] as const satisfies ReadonlyArray<Harness>;

interface Listed extends ListedFile {
  readonly harness: Harness;
}

const listed = (fs: FileSystem.FileSystem, root: string, harness: Harness, since: number) =>
  fs.readDirectory(root, { recursive: true }).pipe(
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
    Effect.map((paths) => paths.filter((relative) => logFiles[harness].test(relative))),
    Effect.flatMap((paths) =>
      Effect.forEach(paths, (relative) =>
        fs.stat(`${root}/${relative}`).pipe(
          Effect.map((info): ReadonlyArray<Listed> => {
            const modifiedAt = Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() });
            return modifiedAt < since
              ? []
              : [{ path: `${root}/${relative}`, harness, size: Number(info.size), modifiedAt }];
          }),
          Effect.orElseSucceed((): ReadonlyArray<Listed> => []),
        ),
      ),
    ),
    Effect.map((entries) => entries.flat()),
  );

export class SessionLogSource extends Context.Service<
  SessionLogSource,
  { readonly read: (listing: SinceByHarness, captured?: SinceByHarness) => Effect.Effect<SessionLogs> }
>()("tui-dash/SessionLogSource") {}

// A restart within this re-reads only what the logs appended since, so keeping more often only rewrites the copy.
const keepWindowMillis = 300_000;

// Each file's progress is kept as soon as it is read, so an interrupted read loses at most the file in flight.
export const sessionLogSourceAt = (
  home: string,
  roots: LogRoots,
  ledger: string,
  accounts: ReadonlyArray<ClaudeAccount>,
  keeper: LogKeeper,
): Effect.Effect<SessionLogSource["Service"], never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const loaded = yield* Effect.cached(Effect.map(keeper.load, (kept) => new Map<string, LogRead>(kept)));
    let unkept = false;
    let keptAt = Number.NEGATIVE_INFINITY;
    const keep = (cache: ReadonlyMap<string, LogRead>): Effect.Effect<void> =>
      Effect.flatMap(Clock.currentTimeMillis, (now) => {
        if (!unkept || now - keptAt < keepWindowMillis) return Effect.void;
        unkept = false;
        keptAt = now;
        return keeper.keep(cache);
      });
    const readLedger = ledgerReaderAt(fs, ledger);
    const capturedSince = (since: SinceByHarness): Effect.Effect<Captured> =>
      Object.keys(since).length === 0
        ? Effect.succeed(capturedOf([], since, roots["claude-code"], accounts))
        : Effect.map(readLedger, (files) => capturedOf(files, since, roots["claude-code"], accounts));
    const read = (listing: SinceByHarness, captured: SinceByHarness = listing): Effect.Effect<SessionLogs> =>
      Effect.gen(function* () {
        const cache = yield* loaded;
        const entries = (
          yield* Effect.forEach(harnesses, (harness) => {
            const from = listing[harness];
            return from === undefined ? Effect.succeed([]) : listed(fs, roots[harness], harness, from);
          })
        ).flat();
        const files: Array<LogFile> = [];
        for (const entry of entries) {
          const before = cache.get(entry.path);
          const current = yield* grownRecords(fs, entry, before, (lines) => markedLogRecords(entry.harness, lines));
          if (current !== undefined && current !== before) {
            cache.set(entry.path, current);
            unkept = true;
          }
          files.push({ path: entry.path, harness: entry.harness, modifiedAt: entry.modifiedAt, records: current?.records ?? [] });
        }
        const listedPaths = new Set(entries.map((entry) => entry.path));
        for (const path of cache.keys()) {
          if (listedPaths.has(path)) continue;
          cache.delete(path);
          unkept = true;
        }
        yield* keep(cache);
        return { home, roots, files, captured: yield* capturedSince(captured) };
      });
    return { read };
  });

// quota-axi reads Codex's native login from CODEX_HOME and Claude's from CLAUDE_CONFIG_DIR, so every log read takes the logs those same homes keep.
const selectedRoots = Config.all({
  home: Config.String("HOME"),
  codexHome: selector("CODEX_HOME"),
  claudeConfig: claudeConfigDirectory,
  ledger: captureLedgerDirectory,
  kept: sessionLogsCacheDirectory,
}).pipe(
  Config.map(({ home, codexHome, claudeConfig, ledger, kept }) => ({
    home,
    ledger,
    kept,
    roots: {
      ...homeLogRoots(home),
      codex: `${codexHome ?? `${home}/.codex`}/sessions`,
      "claude-code": `${claudeConfig}/projects`,
    } satisfies LogRoots,
  })),
);

export const sessionLogSourceLayer: Layer.Layer<SessionLogSource, Config.ConfigError, FileSystem.FileSystem> = Layer.effect(
  SessionLogSource,
  Effect.gen(function* () {
    const { home, roots, ledger, kept } = yield* selectedRoots;
    return yield* sessionLogSourceAt(home, roots, ledger, [], fileLogKeeper(yield* FileSystem.FileSystem, kept, "session.json"));
  }),
);

// The harvest reads back an hour and the session read back a whole window, so sharing one cache would evict the other's files on every read.
export class HarvestLogSource extends Context.Service<HarvestLogSource, SessionLogSource["Service"]>()(
  "tui-dash/HarvestLogSource",
) {}

export const harvestLogSourceLayer = <E, R>(
  readAccounts: Effect.Effect<ReadonlyArray<ClaudeAccount>, E, R>,
): Layer.Layer<HarvestLogSource, Config.ConfigError | E, FileSystem.FileSystem | R> =>
  Layer.effect(
    HarvestLogSource,
    Effect.gen(function* () {
      const { home, roots, ledger, kept } = yield* selectedRoots;
      const logged = yield* claudeLogged;
      const keeper = fileLogKeeper(yield* FileSystem.FileSystem, kept, "harvest.json");
      const source = yield* sessionLogSourceAt(home, roots, ledger, yield* readAccounts, keeper);
      const harvested = (since: SinceByHarness): SinceByHarness => {
        if (logged) return since;
        const { "claude-code": _, ...others } = since;
        return others;
      };
      return {
        read: (since: SinceByHarness) =>
          Effect.map(source.read(harvested(since), since), (logs) => {
            if (logged) return logs;
            return { ...logs, captured: { ...logs.captured, readings: [] } };
          }),
      };
    }),
  );
