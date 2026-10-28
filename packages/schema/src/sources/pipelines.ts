import { Config, Context, Duration, Effect, Layer } from "effect";
import { CommandRunner } from "../command";
import { mapOutcome, ok, type Outcome, type Reading } from "../reading";
import { runDecoded, stamped } from "../source";
import { decodeNoMistakes, type NoMistakesRun, type NoMistakesSnapshot } from "../contract/no-mistakes";
import { decodeOrcRuns, decodeOrcShow, type OrcSnapshot } from "../contract/orc";
import type { PipelineFolder } from "../views/task-pipeline";
import { machineNames, selector } from "./environment";

export interface NoMistakesMachine {
  readonly name: string;
  readonly read: (folders: ReadonlyArray<PipelineFolder>) => Effect.Effect<Reading<NoMistakesSnapshot>>;
}

export class NoMistakesMachines extends Context.Service<NoMistakesMachines, ReadonlyArray<NoMistakesMachine>>()("tui-dash/NoMistakesMachines") {}

export interface OrcMachine {
  readonly name: string;
  readonly read: (folders: ReadonlyArray<PipelineFolder>) => Effect.Effect<Reading<OrcSnapshot>>;
}

export class OrcMachines extends Context.Service<OrcMachines, ReadonlyArray<OrcMachine>>()("tui-dash/OrcMachines") {}

const timeout = Duration.seconds(15);

// A running pipeline's own worktree is no repository to the tool, so one folder failing leaves the others standing.
const merged = <A>(outcomes: ReadonlyArray<Outcome<ReadonlyArray<A>>>): Outcome<ReadonlyArray<A>> => {
  const read = outcomes.flatMap((outcome) => (outcome.kind === "ok" ? [outcome.value] : []));
  const failed = outcomes.find((outcome) => outcome.kind !== "ok");
  return read.length === 0 && failed !== undefined ? failed : ok(read.flat());
};

// Folders list each other's runs, and only a run read in detail holds its steps.
const detailedById = <A extends { readonly id: string }>(runs: ReadonlyArray<A>, held: (run: A) => number): ReadonlyArray<A> => {
  const byId = new Map<string, A>();
  for (const run of runs) {
    const kept = byId.get(run.id);
    if (kept === undefined || held(kept) < held(run)) byId.set(run.id, run);
  }
  return [...byId.values()];
};

const noMistakesRunsOf = (
  listed: Outcome<ReadonlyArray<NoMistakesRun>>,
  branches: ReadonlyArray<string>,
  detail: (id: string) => Effect.Effect<Outcome<ReadonlyArray<NoMistakesRun>>, never, CommandRunner>,
) =>
  Effect.gen(function* () {
    if (listed.kind !== "ok") return listed;
    const bare = branches.flatMap((branch) => {
      const newest = listed.value.find((run) => run.branch === branch);
      return newest === undefined || newest.steps.length > 0 ? [] : [newest.id];
    });
    const detailed = yield* Effect.forEach(bare, detail, { concurrency: "unbounded" });
    return merged<NoMistakesRun>([listed, ...detailed]);
  });

const noMistakesIn = ({ folder, branches }: PipelineFolder) =>
  Effect.gen(function* () {
    const listed = yield* runDecoded({ argv: ["no-mistakes", "axi", "status"], cwd: folder, timeout }, decodeNoMistakes);
    return yield* noMistakesRunsOf(listed, branches, (id) =>
      runDecoded({ argv: ["no-mistakes", "axi", "status", "--run", id], timeout }, decodeNoMistakes),
    );
  });

const noMistakesOf = (
  name: string,
  runner: CommandRunner["Service"],
  readFolder: (
    folder: PipelineFolder,
  ) => Effect.Effect<Outcome<ReadonlyArray<NoMistakesRun>>, never, CommandRunner>,
): NoMistakesMachine => ({
  name,
  read: (folders) =>
    Effect.provideService(
      stamped(
        Effect.map(Effect.forEach(folders, readFolder, { concurrency: "unbounded" }), (outcomes) =>
          mapOutcome(merged(outcomes), (runs) => detailedById(runs, (run) => run.steps.length)),
        ),
      ),
      CommandRunner,
      runner,
    ),
});

const orcRunsOf = (outcomes: ReadonlyArray<Outcome<OrcSnapshot>>) =>
  mapOutcome(merged(outcomes.map((outcome) => mapOutcome(outcome, (snapshot) => snapshot.runs))), (runs) => ({
    runs: detailedById(runs, (run) => run.stages.length),
  }));

const orcDetailOf = (
  listed: Outcome<OrcSnapshot>,
  branches: ReadonlyArray<string>,
  detail: (id: string) => Effect.Effect<Outcome<OrcSnapshot>, never, CommandRunner>,
) =>
  Effect.gen(function* () {
    if (listed.kind !== "ok") return listed;
    const bare = branches.flatMap((branch) => {
      const newest = listed.value.runs.find((run) => run.branch === branch);
      return newest === undefined || newest.stages.length > 0 ? [] : [newest.id];
    });
    const detailed = yield* Effect.forEach(bare, detail, { concurrency: "unbounded" });
    return orcRunsOf([listed, ...detailed]);
  });

const orcIn = ({ folder, branches }: PipelineFolder) =>
  Effect.gen(function* () {
    const listed = yield* runDecoded({ argv: ["orc", "runs", "--json"], cwd: folder, timeout }, decodeOrcRuns);
    return yield* orcDetailOf(listed, branches, (id) =>
      runDecoded({ argv: ["orc", "show", id, "--json"], cwd: folder, timeout }, decodeOrcShow),
    );
  });

const shellQuoted = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

// The other machine's report comes over the words before its tasks command, so its pipelines ride that same route.
const tasksCall = /^((?:[^\s'"`;&|()<>\\]+\s+)+)['"]?[^\s'"`;&|()<>\\]*tasks[^\s'"`;&|()<>\\]*\s+--json['"]?\s*$/iu;

const sshPrefixOf = (command: string): string | undefined => tasksCall.exec(command.trim())?.[1]?.trim();

const remoteScript = (folder: string, tool: string): string => `cd ${shellQuoted(folder)} && ${tool}`;

const remoteArgv = (prefix: string, script: string): readonly [string, ...string[]] => ["sh", "-c", `${prefix} ${shellQuoted(script)}`];

const remoteNoMistakesIn = (prefix: string) => ({ folder, branches }: PipelineFolder) =>
  Effect.gen(function* () {
    const listed = yield* runDecoded({ argv: remoteArgv(prefix, remoteScript(folder, "no-mistakes axi status")), timeout }, decodeNoMistakes);
    return yield* noMistakesRunsOf(listed, branches, (id) =>
      runDecoded({ argv: remoteArgv(prefix, `no-mistakes axi status --run ${shellQuoted(id)}`), timeout }, decodeNoMistakes),
    );
  });

const remoteOrcIn = (prefix: string) => ({ folder, branches }: PipelineFolder) =>
  Effect.gen(function* () {
    const listed = yield* runDecoded({ argv: remoteArgv(prefix, remoteScript(folder, "orc runs --json")), timeout }, decodeOrcRuns);
    return yield* orcDetailOf(listed, branches, (id) =>
      runDecoded({ argv: remoteArgv(prefix, remoteScript(folder, `orc show ${shellQuoted(id)} --json`)), timeout }, decodeOrcShow),
    );
  });

const pipelinesConfig = Config.all({ names: machineNames, remote: selector("TUI_DASH_REMOTE_TASKS") });

const orcOf = (
  name: string,
  runner: CommandRunner["Service"],
  readFolder: (folder: PipelineFolder) => Effect.Effect<Outcome<OrcSnapshot>, never, CommandRunner>,
): OrcMachine => ({
  name,
  read: (folders) =>
    Effect.provideService(
      stamped(Effect.map(Effect.forEach(folders, readFolder, { concurrency: "unbounded" }), orcRunsOf)),
      CommandRunner,
      runner,
    ),
});

export const noMistakesMachinesLayer: Layer.Layer<NoMistakesMachines, Config.ConfigError, CommandRunner> = Layer.effect(
  NoMistakesMachines,
  Effect.gen(function* () {
    const { names, remote } = yield* pipelinesConfig;
    const runner = yield* CommandRunner;
    const prefix = remote === undefined ? undefined : sshPrefixOf(remote);
    return [noMistakesOf(names.local, runner, noMistakesIn), ...(prefix === undefined ? [] : [noMistakesOf(names.remote, runner, remoteNoMistakesIn(prefix))])];
  }),
);

export const orcMachinesLayer: Layer.Layer<OrcMachines, Config.ConfigError, CommandRunner> = Layer.effect(
  OrcMachines,
  Effect.gen(function* () {
    const { names, remote } = yield* pipelinesConfig;
    const runner = yield* CommandRunner;
    const prefix = remote === undefined ? undefined : sshPrefixOf(remote);
    return [orcOf(names.local, runner, orcIn), ...(prefix === undefined ? [] : [orcOf(names.remote, runner, remoteOrcIn(prefix))])];
  }),
);
