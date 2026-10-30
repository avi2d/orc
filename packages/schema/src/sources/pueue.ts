import { Config, Context, Duration, Effect, Layer, Schema } from "effect";
import { CommandRunner } from "../command";
import { type Decoded, decodeJson } from "../decode";
import type { Reading } from "../reading";
import { runDecoded, stamped } from "../source";
import { machineNames, selector } from "./environment";
import { localProjects, type MachineProjects, type ProjectResolver, remoteProjects } from "./project-names";

const Instant = Schema.DateTimeUtcFromString;

const TaskResult = Schema.Union([
  Schema.Literals(["Success", "Killed", "Errored", "DependencyFailed"]),
  Schema.Struct({ Failed: Schema.Int }),
  Schema.Struct({ FailedToSpawn: Schema.String }),
]);

const TaskStatus = Schema.Union([
  Schema.Struct({ Running: Schema.Struct({ start: Instant }) }),
  Schema.Struct({ Paused: Schema.Struct({}) }),
  Schema.Struct({ Queued: Schema.Struct({}) }),
  Schema.Struct({ Stashed: Schema.Struct({ enqueue_at: Schema.optionalKey(Schema.NullOr(Instant)) }) }),
  Schema.Struct({ Locked: Schema.Struct({}) }),
  Schema.Struct({ Done: Schema.Struct({ start: Instant, end: Instant, result: TaskResult }) }),
]);

const Task = Schema.Struct({
  id: Schema.Int,
  command: Schema.String,
  path: Schema.String,
  status: TaskStatus,
});

const GroupStatus = Schema.Literals(["Running", "Paused", "Reset"]);

const Group = Schema.Struct({
  status: GroupStatus,
  parallel_tasks: Schema.Int,
});

export const PueueStatus = Schema.Struct({
  tasks: Schema.Record(Schema.String, Task),
  groups: Schema.Record(Schema.String, Group),
});

export type PueueTask = typeof Task.Type;
export type PueueTaskResult = typeof TaskResult.Type;
export type PueueGroupStatus = typeof GroupStatus.Type;
export type PueueStatus = typeof PueueStatus.Type;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withoutEnvs = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => withoutEnvs(item));
  return isRecord(value) ? fieldsWithoutEnvs(value) : value;
};

const fieldsWithoutEnvs = (record: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).flatMap(([key, field]) => (key === "envs" ? [] : [[key, withoutEnvs(field)]])));

// A task's envs hold the environment it was added from, secrets included, so no schema or decode issue ever sees them.
// A group may be named envs, so the groups record is the one place that key stays.
const withoutTaskEnvs = (status: unknown): unknown =>
  isRecord(status) && "groups" in status ? { ...fieldsWithoutEnvs(status), groups: status.groups } : withoutEnvs(status);

export const decodePueue: (stdout: string) => Decoded<PueueStatus> = decodeJson(PueueStatus, withoutTaskEnvs);

export interface PueueMachine {
  readonly name: string;
  readonly read: Effect.Effect<Reading<PueueStatus>>;
  readonly projects: ProjectResolver;
}

export class PueueMachines extends Context.Service<PueueMachines, ReadonlyArray<PueueMachine>>()("tui-dash/PueueMachines") {}

export const knownProjects = (machines: ReadonlyArray<PueueMachine>): Effect.Effect<MachineProjects> =>
  Effect.map(Effect.forEach(machines, (machine) => Effect.map(machine.projects.known, (names) => [machine.name, names] as const)), (known) => new Map(known));

const localTimeout = Duration.seconds(10);

const remoteTimeout = Duration.seconds(20);

const machinesConfig = Config.all({ names: machineNames, command: selector("TUI_DASH_REMOTE_PUEUE") });

const machineOf = (name: string, argv: readonly [string, ...string[]], timeout: Duration.Duration, runner: CommandRunner["Service"], projects: ProjectResolver): PueueMachine => ({
  name,
  read: Effect.provideService(stamped(runDecoded({ argv, timeout }, decodePueue)), CommandRunner, runner),
  projects,
});

// The configured command is a shell line, such as an ssh call, so the shell parses its quoting.
export const pueueMachinesLayer: Layer.Layer<PueueMachines, Config.ConfigError, CommandRunner> = Layer.effect(
  PueueMachines,
  Effect.gen(function* () {
    const { names, command } = yield* machinesConfig;
    const runner = yield* CommandRunner;
    const local = machineOf(names.local, ["pueue", "status", "--json"], localTimeout, runner, localProjects(runner));
    return command === undefined ? [local] : [local, machineOf(names.remote, ["sh", "-c", command], remoteTimeout, runner, remoteProjects(runner, command))];
  }),
);
