#!/usr/bin/env bun
import { Config, Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { freemem, totalmem } from "node:os";
import { changedPaths, collect, defaultBranch, git, pathsOf, rangeEnds, workingTreeFiles } from "@avi2dg/checks/core/git.ts";
import { runMain, Usage } from "@avi2dg/checks/core/main.ts";
import { parseReport, reporterArgs, ReportError } from "@avi2dg/checks/testing/test-report.ts";
import { judgeSkips, passes, report, SkipGateError } from "@avi2dg/checks/testing/test.ts";
import { readSkipDeclarations, type Environment } from "@avi2dg/checks/scripts/test-skips.ts";
import { narrowTests, type Narrowing, type Repository } from "./affected-tests.ts";
import { decodeBunfig, preloadPaths, resolved } from "./affected-tests.ts";

const NAME = "test-fast";
const USAGE = "usage: test-fast, which runs the unit and e2e test files the change touches, and it takes no arguments";

const UNIT_PREFIX = "tests/unit/";
const E2E_PREFIX = "tests/e2e/";
const TEST_SUFFIXES = [".test.ts", ".test.tsx"] as const;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|astro|svelte|vue|sh)$/;

export function touchedTestFiles(paths: readonly string[]): readonly string[] {
  const picked = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(UNIT_PREFIX) && !path.startsWith(E2E_PREFIX)) continue;
    if (!TEST_SUFFIXES.some((suffix) => path.endsWith(suffix))) continue;
    picked.add(path);
  }
  return [...picked].sort();
}

export function selectFiles(narrowing: Narrowing, changedTests: readonly string[]): readonly string[] {
  return narrowing.kind === "files" ? narrowing.files : changedTests;
}

class BaseUnresolved extends Schema.TaggedError<BaseUnresolved>()("BaseUnresolved", {
  message: Schema.String,
}) {}

const splitZero = (output: string): readonly string[] => output.split("\0").filter((line) => line !== "");

const FIRST_WORKER_BYTES = 1074 * 1024 * 1024;
const EXTRA_WORKER_BYTES = 100 * 1024 * 1024;
const MEMORY_RESERVE_FRACTION = 0.1;

export function workerCountFor(freeBytes: number, totalBytes: number, cpus: number): number {
  const usable = freeBytes - MEMORY_RESERVE_FRACTION * totalBytes - FIRST_WORKER_BYTES;
  return Math.max(1, Math.min(cpus, Math.floor(usable / EXTRA_WORKER_BYTES) + 1));
}

const MAX_WORKERS = 3;

export function cappedWorkerCount(computed: number): number {
  return Math.min(MAX_WORKERS, computed);
}

// os.freemem() reports only free pages on macOS, so the reclaimable inactive and speculative pages come from vm_stat.
export function reclaimableBytes(vmStat: string): number | undefined {
  const pageSize = /page size of (\d+) bytes/.exec(vmStat)?.[1];
  if (pageSize === undefined) return undefined;
  let pages = 0;
  for (const label of ["free", "inactive", "speculative"]) {
    const count = new RegExp(`Pages ${label}:\\s+(\\d+)\\.`).exec(vmStat)?.[1];
    if (count === undefined) return undefined;
    pages += Number(count);
  }
  return pages * Number(pageSize);
}

class WorkerOverride extends Schema.TaggedError<WorkerOverride>()("WorkerOverride", {
  message: Schema.String,
}) {}

const availableBytes = Effect.fn("availableBytes")(function* () {
  if (process.platform !== "darwin") return freemem();
  const vmStat = yield* collect("vm_stat", []).pipe(
    Effect.map(({ stdout }) => stdout),
    Effect.orElseSucceed(() => ""),
  );
  return reclaimableBytes(vmStat) ?? freemem();
});

const workerCount = Effect.fn("workerCount")(function* () {
  const override = yield* Config.option(Config.Int("TEST_FAST_WORKERS"));
  if (Option.isNone(override)) return cappedWorkerCount(workerCountFor(yield* availableBytes(), totalmem(), navigator.hardwareConcurrency));
  if (override.value < 1) return yield* new WorkerOverride({ message: "TEST_FAST_WORKERS must be at least 1, not " + override.value });
  return override.value;
});

const Manifest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  exports: Schema.optionalKey(Schema.Unknown),
  bin: Schema.optionalKey(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])),
});
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

const basenameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function binsOf(manifest: typeof Manifest.Type): ReadonlyMap<string, string> {
  const { bin, name } = manifest;
  if (bin === undefined) return new Map();
  if (typeof bin === "string") return name === undefined ? new Map() : new Map([[basenameOf(name), resolved("", bin)]]);
  return new Map(Object.entries(bin).map(([command, file]) => [command, resolved("", file)]));
}

function exportsMap(exports: unknown): ReadonlyMap<string, string> {
  if (typeof exports === "string") return new Map([[".", resolved("", exports)]]);
  if (typeof exports !== "object" || exports === null) return new Map();
  const entries: Readonly<Record<string, unknown>> = { ...exports };
  return new Map(Object.entries(entries).flatMap(([key, target]) => {
    if (typeof target !== "string") return [];
    return [[key, resolved("", target)] as const];
  }));
}

class NarrowingError extends Schema.TaggedError<NarrowingError>()("NarrowingError", {
  message: Schema.String,
}) {}

const readRepository = Effect.fn("readRepository")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = yield* workingTreeFiles(root);
  const read = (file: string) => fs.readFileString(path.join(root, file)).pipe(Effect.orElseSucceed(() => ""));
  const sources = new Map(yield* Effect.forEach(files.filter((file) => SOURCE_FILE.test(file)), (file) =>
    read(file).pipe(Effect.map((text) => [file, text] as const)), { concurrency: 16 }));
  const manifest = files.includes("package.json") ? yield* read("package.json").pipe(Effect.flatMap(decodeManifest)) : {};
  const bunfig = files.includes("bunfig.toml")
    ? yield* read("bunfig.toml").pipe(
        Effect.flatMap((text) => Effect.try({ try: (): unknown => Bun.TOML.parse(text), catch: (cause) => new NarrowingError({ message: "cannot parse bunfig.toml: " + String(cause) }) })),
        Effect.flatMap(decodeBunfig),
      )
    : {};
  return {
    files,
    sources,
    bins: binsOf(manifest),
    self: manifest.name === undefined ? undefined : { name: manifest.name, exports: exportsMap(manifest.exports) },
    preloads: preloadPaths(bunfig),
  } satisfies Repository;
});

const changedFiles = Effect.fn("changedFiles")(function* (root: string) {
  const target = "origin/" + (yield* defaultBranch(root));
  const range = yield* rangeEnds(target, "HEAD", root).pipe(
    Effect.mapError((cause) => new BaseUnresolved({
      message: "cannot find where HEAD branched from " + target + ", so the test files the change touches are unknown; fetch " + target + " and run again: " + cause.message,
    })),
  );
  const committed = (yield* changedPaths(range.base, range.head, [], root)).flatMap(pathsOf);
  const working = splitZero(yield* git(["diff", "--name-only", "-z", "HEAD", "--"], root));
  const untracked = splitZero(yield* git(["ls-files", "--others", "--exclude-standard", "-z"], root));
  return [...new Set([...committed, ...working, ...untracked])];
});

const environmentOf = Config.Boolean("CI").pipe(
  Config.withDefault(false),
  Config.map((ci): Environment => (ci ? "ci" : "local")),
  Effect.mapError((cause) => new SkipGateError({ message: "cannot tell a ci run from a local one: " + cause.message })),
);

const runFiles = Effect.fn("runFiles")(function* (
  root: string,
  files: readonly string[],
  keep: (file: string) => boolean,
  workers: number,
  environment: Environment,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const outfile = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "orc-dash-test-fast-" }), "junit.xml");
  const suitePassed = (yield* spawner.exitCode(
    ChildProcess.make(process.execPath, ["test", "--randomize", `--parallel=${workers}`, ...reporterArgs(outfile), ...files], {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      cwd: root,
      env: { CI: "true" },
      extendEnv: true,
    }),
  )) === ChildProcessSpawner.ExitCode(0);
  const written = yield* fs.exists(outfile);
  if (!written) {
    if (!suitePassed) {
      yield* Console.error(NAME + ": bun test failed before it wrote a report, so no skip was judged");
      return false;
    }
    return yield* new ReportError({ message: "bun test passed but wrote no report to " + outfile });
  }
  const { results, crashedFiles } = yield* parseReport(yield* fs.readFileString(outfile));
  for (const file of crashedFiles) yield* Console.error(NAME + ": the worker running " + file + " crashed, so its skips were not judged");
  const judged = (yield* readSkipDeclarations(root, undefined)).filter((declaration) => keep(declaration.file) && !crashedFiles.includes(declaration.file));
  const verdict = judgeSkips(results, judged, environment);
  yield* passes(verdict) ? Console.log(report(verdict)) : Console.error(report(verdict));
  return suitePassed && crashedFiles.length === 0 && passes(verdict);
});

const fastEntry = Effect.gen(function* () {
  if (process.argv.slice(2).length > 0) return yield* new Usage({ message: USAGE });
  const root = (yield* git(["rev-parse", "--show-toplevel"])).trim();
  const changed = yield* changedFiles(root);
  const repository = yield* readRepository(root);
  const tests = repository.files.filter((file) => touchedTestFiles([file]).length > 0).sort();
  const narrowing = narrowTests(changed, repository, tests);
  const known = new Set(repository.files);
  const selected = selectFiles(narrowing, touchedTestFiles(changed).filter((file) => known.has(file)));
  const workers = yield* workerCount();
  yield* Console.log(NAME + ": running " + workers + " worker(s)");
  const environment = yield* environmentOf;
  if (selected.length === 0) {
    yield* Console.log(NAME + ": the change touches no test files, so nothing ran and the whole run stays on PR CI");
    return true;
  }
  if (narrowing.kind === "full") {
    yield* Console.log(NAME + ": " + narrowing.because + ", so only the directly changed test file(s) run and the whole run stays on PR CI");
  }
  yield* Console.log(NAME + ": the change touches " + selected.length + " test file(s): " + selected.join(" "));
  return yield* runFiles(root, selected.map((file) => "./" + file), (file) => selected.includes(file), workers, environment);
}).pipe(Effect.scoped);

if (import.meta.main) runMain(NAME, fastEntry);
