import { Cause, DateTime, Duration, Effect, Exit, Fiber, Option } from "effect";
import { type Outcome, type SnapshotFields, type SnapshotReport, type SnapshotSource, snapshotSources } from "@tui-dash/schema";

export type SnapshotReaders<R> = { readonly [K in SnapshotSource]: Effect.Effect<SnapshotFields<K>, never, R> };

export type SnapshotLimits = { readonly [K in SnapshotSource]: Duration.Duration };

// A source's longest chain of commands times out inside its limit, so their reason lands in its readings; the limit catches a read that hangs outside any command.
export const snapshotLimits: SnapshotLimits = {
  quota: Duration.minutes(3),
  resources: Duration.seconds(30),
  queues: Duration.seconds(30),
  tasks: Duration.seconds(30),
};

const isSource = (name: string): name is SnapshotSource => snapshotSources.some((source) => source === name);

export const sourcesNamed = (list: string): Option.Option<ReadonlySet<SnapshotSource>> => {
  const names = list.split(",").map((name) => name.trim());
  const sources = names.filter(isSource);
  return sources.length === names.length ? Option.some(new Set(sources)) : Option.none();
};

export const unknownSources = (list: string): string => {
  const unknown = list
    .split(",")
    .map((name) => name.trim())
    .filter((name) => !isSource(name))
    .map((name) => (name === "" ? "an empty name" : `"${name}"`));
  return `names out of ${snapshotSources.join(", ")}, separated by commas, and ${unknown.join(" and ")} ${unknown.length === 1 ? "is" : "are"} not one of them`;
};

type Answer<A> = ({ readonly status: "ok" } & A) | { readonly status: "failed"; readonly error: string };

const messageOf = (cause: Cause.Cause<never>): string => {
  const squashed = Cause.squash(cause);
  return squashed instanceof Error ? squashed.message : String(squashed);
};

type Settled<A> = Exclude<Outcome<A>, { readonly kind: "invalid" }>;

// Timing out the read itself would wait for its interruption, and a read stuck opening a file cannot be interrupted.
export const awaitedWithin = <A>(source: string, reading: Fiber.Fiber<A>, limit: Duration.Duration): Effect.Effect<Settled<A>> =>
  Effect.gen(function* () {
    const exit = yield* Effect.timeoutOption(Fiber.await(reading), limit);
    if (Option.isNone(exit)) {
      yield* Effect.forkDetach(Fiber.interrupt(reading));
      return { kind: "unreachable", reason: `${source} gave no answer within ${Duration.format(limit)}` };
    }
    return Exit.match(exit.value, {
      onFailure: (cause): Settled<A> => ({ kind: "unreachable", reason: `${source} failed: ${messageOf(cause)}` }),
      onSuccess: (value): Settled<A> => ({ kind: "ok", value }),
    });
  });

const settledWithin = <A, R>(source: string, read: Effect.Effect<A, never, R>, limit: Duration.Duration): Effect.Effect<Settled<A>, never, R> =>
  Effect.flatMap(Effect.forkDetach(read), (reading) => awaitedWithin(source, reading, limit));

const answerOf = <A extends object, R>(
  source: SnapshotSource,
  read: Effect.Effect<A, never, R>,
  limit: Duration.Duration,
): Effect.Effect<Answer<A>, never, R> =>
  Effect.map(
    settledWithin(source, read, limit),
    (settled): Answer<A> =>
      settled.kind === "ok" ? { status: "ok", ...settled.value } : { status: "failed", error: settled.reason },
  );

const chosen = <A extends object, R>(
  source: SnapshotSource,
  selected: ReadonlySet<SnapshotSource>,
  read: Effect.Effect<A, never, R>,
  limit: Duration.Duration,
): Effect.Effect<Option.Option<Answer<A>>, never, R> => (selected.has(source) ? Effect.asSome(answerOf(source, read, limit)) : Effect.succeedNone);

export const snapshotReport = <R>(
  machine: string,
  readers: SnapshotReaders<R>,
  selected: ReadonlySet<SnapshotSource>,
  limits: SnapshotLimits = snapshotLimits,
): Effect.Effect<SnapshotReport, never, R> =>
  Effect.gen(function* () {
    const answers = yield* Effect.all(
      {
        quota: chosen("quota", selected, readers.quota, limits.quota),
        resources: chosen("resources", selected, readers.resources, limits.resources),
        queues: chosen("queues", selected, readers.queues, limits.queues),
        tasks: chosen("tasks", selected, readers.tasks, limits.tasks),
      },
      { concurrency: "unbounded" },
    );
    const generatedAt = yield* DateTime.now;
    return {
      schemaVersion: 1,
      generatedAt: DateTime.formatIso(generatedAt),
      machine,
      sources: {
        ...Option.match(answers.quota, { onNone: () => ({}), onSome: (quota) => ({ quota }) }),
        ...Option.match(answers.resources, { onNone: () => ({}), onSome: (resources) => ({ resources }) }),
        ...Option.match(answers.queues, { onNone: () => ({}), onSome: (queues) => ({ queues }) }),
        ...Option.match(answers.tasks, { onNone: () => ({}), onSome: (tasks) => ({ tasks }) }),
      },
    };
  });
