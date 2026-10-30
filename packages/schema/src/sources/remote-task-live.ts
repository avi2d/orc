import { Config, Context, Duration, Effect, Layer, Option } from "effect";
import { CommandRunner } from "../command";
import { decodeLiveTasksReport } from "../contract/task-live";
import type { Outcome } from "../reading";
import type { LiveTasks } from "../views/task-levels";
import { configuredMachines } from "./machines";

export interface TaskLiveMachine {
  readonly name: string;
  readonly read: Effect.Effect<Outcome<LiveTasks>>;
}

export class RemoteTaskLive extends Context.Service<RemoteTaskLive, Option.Option<TaskLiveMachine>>()("tui-dash/RemoteTaskLive") {}

export const remoteTaskLiveLayer: Layer.Layer<RemoteTaskLive, Config.ConfigError, CommandRunner> = Layer.effect(
  RemoteTaskLive,
  Effect.map(
    configuredMachines("TUI_DASH_REMOTE_TASK_LIVE", Duration.seconds(15), () => decodeLiveTasksReport),
    (machines) => Option.fromUndefinedOr(machines.remotes[0]),
  ),
);
