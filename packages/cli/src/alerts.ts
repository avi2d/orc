import { Console, DateTime, Duration, Effect, Fiber, Option, Ref, Schedule } from "effect";
import {
  type AlertEvent,
  type AlertSettings,
  type ComposedSessionQuotaReport,
  heavyLoadStart,
  heavyLoadStep,
  longTaskStart,
  longTaskStep,
  type MachineResources,
  type MachineTasks,
  type NightlyInputs,
  nightlyStart,
  nightlyStep,
  type Outcome,
  quotaPaceStart,
  quotaPaceStep,
} from "@tui-dash/schema";
import { awaitedWithin, type SnapshotLimits, snapshotLimits } from "./snapshot";

export interface AlertReaders<R> {
  readonly quota: Effect.Effect<ComposedSessionQuotaReport, never, R>;
  readonly resources: Effect.Effect<ReadonlyArray<MachineResources>, never, R>;
  readonly tasks: Effect.Effect<ReadonlyArray<MachineTasks>, never, R>;
  readonly nightly: Effect.Effect<NightlyInputs, never, R>;
}

export interface AlertLimits extends SnapshotLimits {
  readonly nightly: Duration.Duration;
}

export const alertLimits: AlertLimits = { ...snapshotLimits, nightly: Duration.minutes(5) };

interface Rule<A, S> {
  readonly source: keyof AlertReaders<never>;
  readonly everySeconds: number;
  readonly initial: S;
  readonly step: (state: S, sample: Outcome<A>, now: DateTime.Utc) => { readonly state: S; readonly events: ReadonlyArray<AlertEvent> };
}

const ruleStream = <A, S, R>(rule: Rule<A, S>, read: Effect.Effect<A, never, R>, limit: Duration.Duration): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const state = yield* Ref.make(rule.initial);
    const outstanding = yield* Ref.make<Option.Option<Fiber.Fiber<A>>>(Option.none());
    const sampleOf: Effect.Effect<Outcome<A>, never, R> = Effect.gen(function* () {
      const previous = yield* Ref.get(outstanding);
      if (Option.isSome(previous) && Option.isNone(yield* Effect.timeoutOption(Fiber.await(previous.value), limit)))
        return { kind: "unreachable", reason: `${rule.source} is still on a read that gave no answer` };
      const reading = yield* Effect.forkDetach(read);
      yield* Ref.set(outstanding, Option.some(reading));
      return yield* awaitedWithin(rule.source, reading, limit);
    });
    const round = Effect.gen(function* () {
      const sample = yield* sampleOf;
      const now = yield* DateTime.now;
      const stepped = rule.step(yield* Ref.get(state), sample, now);
      yield* Ref.set(state, stepped.state);
      yield* Effect.forEach(stepped.events, (event) => Console.log(JSON.stringify(event)), { discard: true });
    });
    yield* round.pipe(Effect.repeat(Schedule.spaced(Duration.seconds(rule.everySeconds))));
  });

export const streamAlerts = <R>(readers: AlertReaders<R>, settings: AlertSettings, limits: AlertLimits = alertLimits): Effect.Effect<void, never, R> =>
  Effect.all(
    [
      ruleStream(
        { source: "quota", everySeconds: settings.quotaPace.everySeconds, initial: quotaPaceStart, step: quotaPaceStep },
        readers.quota,
        limits.quota,
      ),
      ruleStream(
        {
          source: "resources",
          everySeconds: settings.heavyLoad.everySeconds,
          initial: heavyLoadStart,
          step: (state, sample, now) => heavyLoadStep(state, sample, now, settings.heavyLoad),
        },
        readers.resources,
        limits.resources,
      ),
      ruleStream(
        {
          source: "tasks",
          everySeconds: settings.longTask.everySeconds,
          initial: longTaskStart,
          step: (state, sample, now) => longTaskStep(state, sample, now, settings.longTask),
        },
        readers.tasks,
        limits.tasks,
      ),
      ruleStream(
        {
          source: "nightly",
          everySeconds: settings.nightly.everySeconds,
          initial: nightlyStart,
          step: (state, sample, now) => nightlyStep(state, sample, now, settings.nightly),
        },
        readers.nightly,
        limits.nightly,
      ),
    ],
    { concurrency: "unbounded", discard: true },
  );
