import { Config, Effect, type FileSystem, Option } from "effect";
import { decodeVerdictLine, type VerdictEntry } from "../contract/alert-verdicts";
import type { Decoded } from "../decode";
import { ok, type Outcome, unreachable } from "../reading";
import { decodedLines, type Grown, readGrown } from "./append-only";
import { selector } from "./environment";
import { nonEmptyLines } from "./lines";

export const alertVerdictsPath: Config.Config<string> = Config.all({
  home: Config.String("HOME"),
  verdicts: selector("TUI_DASH_ALERTS_VERDICTS"),
}).pipe(Config.map(({ home, verdicts }) => verdicts ?? `${home}/.local/state/tui-dash/alerts-verdicts.jsonl`));

export interface VerdictLog {
  readonly entries: ReadonlyArray<VerdictEntry>;
  readonly unreadable: number;
  readonly lastIssue: string | undefined;
}

const emptyLog: VerdictLog = { entries: [], unreadable: 0, lastIssue: undefined };

const logOf = (lines: ReadonlyArray<Decoded<VerdictEntry>>): VerdictLog => {
  const entries = lines.flatMap((line) => (line.kind === "ok" ? [line.value] : []));
  const issues = lines.flatMap((line) => (line.kind === "ok" ? [] : [line.issue]));
  return { entries, unreadable: issues.length, lastIssue: issues.at(-1) };
};

const parsed = (text: string): ReadonlyArray<Decoded<VerdictEntry>> => nonEmptyLines(text).map(decodeVerdictLine);

// A listener that never wrote leaves no file, which is no verdict rather than a failure.
export const verdictLogReaderAt = (fs: FileSystem.FileSystem, path: string): Effect.Effect<Outcome<VerdictLog>> => {
  let cached: Grown<Decoded<VerdictEntry>> | undefined;
  return Effect.gen(function* () {
    if (!(yield* fs.exists(path))) {
      cached = undefined;
      return ok(emptyLog);
    }
    const info = yield* fs.stat(path);
    const modifiedAt = Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() });
    const grown = yield* readGrown(fs, { path, size: Number(info.size), modifiedAt }, cached, decodedLines(parsed));
    cached = grown;
    return ok(logOf(grown.records));
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.succeed(unreachable(`${path} cannot be read: ${error.message}`))));
};
