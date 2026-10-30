import { Config, Context, Duration, Effect, Layer, Option, Result, Schema } from "effect";
import { CommandRunner } from "../command";
import { type Decoded, decoded, decodeValue, rejected } from "../decode";
import type { Reading } from "../reading";
import { runDecoded, stamped } from "../source";
import { selector } from "./environment";

const RunnerFile = Schema.Struct({ agentName: Schema.String, gitHubUrl: Schema.String });

const RunnerFiles = Schema.Array(RunnerFile);

const byteOrderMark = "\uFEFF";

interface Scan {
  readonly depth: number;
  readonly quoted: boolean;
  readonly escaped: boolean;
}

const inString = (scan: Scan, char: string): Scan => {
  if (scan.escaped) return { ...scan, escaped: false };
  if (char === "\\") return { ...scan, escaped: true };
  return char === '"' ? { ...scan, quoted: false } : scan;
};

const scanned = (scan: Scan, char: string): Scan => {
  if (scan.quoted) return inString(scan, char);
  if (char === '"') return { ...scan, quoted: true };
  if (char === "{") return { ...scan, depth: scan.depth + 1 };
  return char === "}" ? { ...scan, depth: scan.depth - 1 } : scan;
};

const between = (char: string): boolean => char === byteOrderMark || char.trim() === "";

const objectTexts = (text: string): Result.Result<ReadonlyArray<string>, string> => {
  const texts: Array<string> = [];
  let scan: Scan = { depth: 0, quoted: false, escaped: false };
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (scan.depth === 0 && char !== "{") {
      if (between(char)) continue;
      return Result.fail(char === "}" ? "a runner file closes an object it never opened" : "a runner file has text outside an object");
    }
    if (scan.depth === 0) start = index;
    scan = scanned(scan, char);
    if (scan.depth === 0) texts.push(text.slice(start, index + 1));
  }
  return scan.depth === 0 ? Result.succeed(texts) : Result.fail("a runner file ends inside an object");
};

// Each runner's .runner file is one pretty printed object and a cat of several runs them together, so the objects are split by their braces.
export const jsonObjects = (text: string): Result.Result<ReadonlyArray<unknown>, string> =>
  Result.flatMap(objectTexts(text), (texts) => {
    const objects: Array<unknown> = [];
    for (const each of texts) {
      const parsed = Result.try((): unknown => JSON.parse(each));
      if (Result.isFailure(parsed)) return Result.fail("a runner file is not JSON");
      objects.push(parsed.success);
    }
    return Result.succeed(objects);
  });

// An organisation's runner names no repository, so only a runner registered to one repository adds it.
const repositoryOf = (gitHubUrl: string): string | undefined => {
  const url = Result.try(() => new URL(gitHubUrl));
  if (Result.isFailure(url)) return undefined;
  const segments = url.success.pathname.split("/").filter((segment) => segment !== "");
  return segments.length === 2 ? segments.join("/") : undefined;
};

export const decodeRunnerRepos = (stdout: string): Decoded<ReadonlyArray<string>> => {
  const objects = jsonObjects(stdout);
  if (Result.isFailure(objects)) return rejected(objects.failure);
  const files = decodeValue(RunnerFiles)(objects.success);
  if (files.kind !== "ok") return files;
  const repos = files.value.flatMap((file) => {
    const repo = repositoryOf(file.gitHubUrl);
    return repo === undefined ? [] : [repo];
  });
  return decoded([...new Set(repos)].toSorted());
};

export interface RunnerReposReading {
  readonly read: Effect.Effect<Reading<ReadonlyArray<string>>>;
}

export class RunnerRepos extends Context.Service<RunnerRepos, Option.Option<RunnerReposReading>>()("tui-dash/RunnerRepos") {}

const runnersTimeout = Duration.seconds(15);

// The configured command is a shell line, such as one entering the runners' own machine, so the shell parses its quoting.
export const runnerReposLayer: Layer.Layer<RunnerRepos, Config.ConfigError, CommandRunner> = Layer.effect(
  RunnerRepos,
  Effect.gen(function* () {
    const command = yield* selector("TUI_DASH_RUNNERS");
    if (command === undefined) return Option.none();
    const runner = yield* CommandRunner;
    const read = stamped(runDecoded({ argv: ["sh", "-c", command], timeout: runnersTimeout }, decodeRunnerRepos));
    return Option.some({ read: Effect.provideService(read, CommandRunner, runner) });
  }),
);
