import { Config, Context, Duration, Effect, Layer, Option, Schema } from "effect";
import { CommandRunner } from "../command";
import { type Decoded, decodeJson, decoded } from "../decode";
import { mapOutcome, type Outcome, type Reading, zipOutcomes } from "../reading";
import { runDecoded, stamped } from "../source";
import { selector } from "./environment";

// In the order a run moves through them, so a later status is the more advanced one.
export const activeRunStatuses = ["requested", "pending", "waiting", "queued", "in_progress"] as const;

export const ActionRun = Schema.Struct({
  databaseId: Schema.Int,
  displayTitle: Schema.String,
  status: Schema.Literals(activeRunStatuses),
  workflowName: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
});

const Runs = Schema.Array(ActionRun);

export type ActionRun = typeof ActionRun.Type;

export const decodeActions: (stdout: string) => Decoded<ReadonlyArray<ActionRun>> = decodeJson(Runs);

// gh filters on one status a call, and an unfiltered list lets newer finished runs push an active one past the limit.
const actionsCommand = (repo: Option.Option<string>, status: ActionRun["status"]) =>
  ({
    argv: [
      "gh",
      "run",
      "list",
      ...Option.match(repo, { onNone: () => [], onSome: (named) => ["--repo", named] }),
      "--status",
      status,
      "--limit",
      "20",
      "--json",
      "databaseId,displayTitle,status,workflowName,createdAt",
    ],
    timeout: Duration.seconds(20),
  }) as const;

const progressOf = (run: ActionRun): number => activeRunStatuses.indexOf(run.status);

// The status queries run at once, so a run that moves on between two of them answers to both.
const mostAdvancedEach = (runs: ReadonlyArray<ActionRun>): ReadonlyArray<ActionRun> => {
  const byId = new Map<number, ActionRun>();
  for (const run of runs) {
    const seen = byId.get(run.databaseId);
    if (seen === undefined || progressOf(run) > progressOf(seen)) byId.set(run.databaseId, run);
  }
  return [...byId.values()];
};

export const activeRuns = (outcomes: ReadonlyArray<Outcome<ReadonlyArray<ActionRun>>>): Outcome<ReadonlyArray<ActionRun>> =>
  mapOutcome(
    outcomes.reduce<Outcome<ReadonlyArray<ActionRun>>>(
      (all, runs) => zipOutcomes(all, runs, (earlier, later) => [...earlier, ...later]),
      decoded([]),
    ),
    mostAdvancedEach,
  );

export interface ActionsReading {
  readonly repo: string;
  readonly read: Effect.Effect<Reading<ReadonlyArray<ActionRun>>>;
}

export class ActionsSource extends Context.Service<ActionsSource, ActionsReading>()("tui-dash/ActionsSource") {}

// Without --repo, gh lists the runs of the repository its working directory belongs to.
const workingRepository = "this repository";

// Five calls a read against GitHub's hourly API limit, so a panel repainting every 10 seconds reuses a read this young.
const reuseFor = Duration.seconds(30);

export const actionsSourceLayer: Layer.Layer<ActionsSource, Config.ConfigError, CommandRunner> = Layer.effect(
  ActionsSource,
  Effect.gen(function* () {
    const named = Option.fromUndefinedOr(yield* selector("TUI_DASH_ACTIONS_REPO"));
    const runner = yield* CommandRunner;
    const read = stamped(
      Effect.forEach(activeRunStatuses, (status) => runDecoded(actionsCommand(named, status), decodeActions), {
        concurrency: "unbounded",
      }).pipe(Effect.map(activeRuns)),
    );
    const repo = Option.getOrElse(named, () => workingRepository);
    return { repo, read: yield* Effect.cachedWithTTL(Effect.provideService(read, CommandRunner, runner), reuseFor) };
  }),
);
