import { Effect, Result, Schema } from "effect";
import { type Decoded, decoded, rejected } from "../decode";
import { strictly } from "./config";
import { ProcessJson } from "./resources";
import { AccountRef, FlagJson } from "./session-quota";
import { TaskStateJson } from "./tasks";

const Positive = Schema.Finite.check(Schema.isGreaterThan(0));

const Percent = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100));

const WholePositive = Schema.Int.check(Schema.isGreaterThan(0));

const MemoryLimitJson = Schema.Union([
  Schema.Struct({ usedAtLeastPercent: Percent }),
  Schema.Struct({ availableUnderPercent: Percent }),
]);

export type MemoryLimit = typeof MemoryLimitJson.Type;

const MachineLimitsJson = Schema.Struct({ name: Schema.String, loadAtLeast: Positive, memory: MemoryLimitJson });

export type MachineLimits = typeof MachineLimitsJson.Type;

const defaults = {
  quotaPace: { everySeconds: 60 },
  heavyLoad: {
    everySeconds: 30,
    sustainedMinutes: 5,
    topProcesses: 5,
    machines: [
      { name: "local", loadAtLeast: 10, memory: { usedAtLeastPercent: 90 } },
      { name: "remote", loadAtLeast: 16, memory: { availableUnderPercent: 15 } },
    ],
  },
  longTask: { everySeconds: 30, quietMinutes: 15, repeatMinutes: 15, totalHours: 2, states: ["working", "waiting", "blocked"] },
  nightly: { everySeconds: 300, homes: {} },
} as const;

const QuotaPaceSettings = Schema.Struct({
  everySeconds: Positive.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaults.quotaPace.everySeconds))),
});

const HeavyLoadSettings = Schema.Struct({
  everySeconds: Positive.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaults.heavyLoad.everySeconds))),
  sustainedMinutes: Positive.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaults.heavyLoad.sustainedMinutes))),
  topProcesses: WholePositive.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaults.heavyLoad.topProcesses))),
  machines: Schema.Array(MachineLimitsJson).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaults.heavyLoad.machines))),
});

const LongTaskSettings = Schema.Struct({
  everySeconds: Positive.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaults.longTask.everySeconds))),
  quietMinutes: Positive.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaults.longTask.quietMinutes))),
  repeatMinutes: Positive.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaults.longTask.repeatMinutes))),
  totalHours: Positive.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaults.longTask.totalHours))),
  states: Schema.Array(TaskStateJson).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaults.longTask.states))),
});

const NightlySettings = Schema.Struct({
  everySeconds: Positive.pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaults.nightly.everySeconds))),
  homes: Schema.Record(Schema.String, Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaults.nightly.homes))),
});

export const AlertSettings = Schema.Struct({
  quotaPace: QuotaPaceSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  heavyLoad: HeavyLoadSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  longTask: LongTaskSettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  nightly: NightlySettings.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
});

export type AlertSettings = typeof AlertSettings.Type;

export type HeavyLoadSettings = AlertSettings["heavyLoad"];

export type LongTaskSettings = AlertSettings["longTask"];

export type NightlySettings = AlertSettings["nightly"];

export const defaultAlertSettings: AlertSettings = defaults;

export const decodeAlertSettings = (raw: unknown): Decoded<AlertSettings> => {
  const input: unknown = raw === undefined ? {} : raw;
  const settings = Schema.decodeUnknownResult(AlertSettings)(input, strictly);
  return Result.isSuccess(settings) ? decoded(settings.success) : rejected(settings.failure.message);
};

export type AlertProcess = typeof ProcessJson.Type;

const QuotaPaceEvent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  rule: Schema.Literal("quota-pace"),
  at: Schema.String,
  account: AccountRef,
  window: Schema.String,
  windowLabel: Schema.String,
  leftPoints: Schema.Finite,
  elapsedFraction: Schema.Finite,
  resetsAt: Schema.String,
  flags: Schema.Array(Schema.Struct({ ...FlagJson.fields, machine: Schema.String })),
});

const HeavyLoadEvent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  rule: Schema.Literal("heavy-load"),
  at: Schema.String,
  machine: Schema.String,
  since: Schema.String,
  crossed: Schema.Array(Schema.Literals(["load", "memory"])),
  limits: MachineLimitsJson,
  load: Schema.NullOr(Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite])),
  memory: Schema.NullOr(Schema.Struct({ usedBytes: Schema.Finite, totalBytes: Schema.Finite, usedPercent: Schema.Finite })),
  topProcesses: Schema.Struct({ byCpu: Schema.Array(ProcessJson), byMemory: Schema.Array(ProcessJson) }),
});

const LongTaskEvent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  rule: Schema.Literal("long-task"),
  reason: Schema.Literals(["quiet", "total"]),
  at: Schema.String,
  machine: Schema.String,
  task: Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    project: Schema.String,
    state: TaskStateJson,
    detail: Schema.String,
    firstStartedAt: Schema.String,
  }),
  quietSince: Schema.String,
  quietMinutes: Schema.Finite,
  totalMinutes: Schema.Finite,
});

const NightlyEvent = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  rule: Schema.Literal("nightly"),
  at: Schema.String,
  repo: Schema.String,
  workflow: Schema.String,
  runId: Schema.Int,
  conclusion: Schema.String,
  home: Schema.String,
  recheckAt: Schema.String,
});

export const AlertEvent = Schema.Union([QuotaPaceEvent, HeavyLoadEvent, LongTaskEvent, NightlyEvent]);

export type AlertEvent = typeof AlertEvent.Type;

export type QuotaPaceEvent = typeof QuotaPaceEvent.Type;

export type HeavyLoadEvent = typeof HeavyLoadEvent.Type;

export type LongTaskEvent = typeof LongTaskEvent.Type;

export type NightlyEvent = typeof NightlyEvent.Type;
