import { Config, Context, Duration, Effect, Layer, Option } from "effect";
import { CommandRunner } from "../command";
import { type TaskSampleRecord, taskSampleRecords } from "../contract/task-samples";
import { decoded, type Decoded } from "../decode";
import type { Outcome } from "../reading";
import { runDecoded } from "../source";
import { machineNames, selector } from "./environment";

export interface TaskHistoryMachine {
  readonly name: string;
  readonly read: Effect.Effect<Outcome<ReadonlyArray<TaskSampleRecord>>>;
}

export class RemoteTaskHistory extends Context.Service<RemoteTaskHistory, Option.Option<TaskHistoryMachine>>()(
  "tui-dash/RemoteTaskHistory",
) {}

// A torn or foreign line carries nothing to count, so the day files skip it, and a history printed over ssh reads the same way.
const decodeHistory = (stdout: string): Decoded<ReadonlyArray<TaskSampleRecord>> => decoded(taskSampleRecords(stdout));

const historyTimeout = Duration.seconds(15);

const historyConfig = Config.all({ names: machineNames, command: selector("TUI_DASH_REMOTE_TASK_HISTORY") });

// The configured command is a shell line, such as an ssh call printing the other machine's day files, so the shell parses its quoting.
export const remoteTaskHistoryLayer: Layer.Layer<RemoteTaskHistory, Config.ConfigError, CommandRunner> = Layer.effect(
  RemoteTaskHistory,
  Effect.gen(function* () {
    const { names, command } = yield* historyConfig;
    const runner = yield* CommandRunner;
    if (command === undefined) return Option.none();
    return Option.some({
      name: names.remote,
      read: Effect.provideService(runDecoded({ argv: ["sh", "-c", command], timeout: historyTimeout }, decodeHistory), CommandRunner, runner),
    });
  }),
);
