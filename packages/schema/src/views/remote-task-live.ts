import { Config, Context, Duration, Effect, Layer, Option } from "effect";
import { CommandRunner } from "../shared/lib";
import type { Outcome } from "../shared/lib";
import { decodeLiveTasksReport, type LiveTasks } from "./task-levels";
import { configuredMachines } from "../shared/config";

export interface TaskLiveMachine {
  readonly name: string;
  readonly read: Effect.Effect<Outcome<LiveTasks>>;
}

export class RemoteTaskLive extends Context.Service<RemoteTaskLive, Option.Option<TaskLiveMachine>>()("orc-dash/RemoteTaskLive") {}

export const remoteTaskLiveLayer: Layer.Layer<RemoteTaskLive, Config.ConfigError, CommandRunner> = Layer.effect(
  RemoteTaskLive,
  Effect.map(
    configuredMachines("ORC_DASH_REMOTE_TASK_LIVE", Duration.seconds(15), () => decodeLiveTasksReport),
    (machines) => Option.fromUndefinedOr(machines.remotes[0]),
  ),
);
