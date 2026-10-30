import { BunFileSystem } from "@effect/platform-bun";
import { Duration, Layer } from "effect";
import {
  hostSourcesLayer,
  linuxTaskProcessesSourceLayer,
  localTasksLayerWithin,
  macTaskProcessesSourceLayer,
  noMistakesMachinesLayer,
  orcMachinesLayer,
  pueueMachinesLayer,
  remoteTaskHistoryLayer,
  remoteTaskLiveLayer,
  sessionQuotaSourcesLayer,
  taskSamplesSourceLayer,
  tasksMachinesLayer,
} from "@tui-dash/schema";
import { liveCommandRunner } from "@tui-dash/ui";

const taskProcessesSourceLayer = process.platform === "darwin" ? macTaskProcessesSourceLayer : linuxTaskProcessesSourceLayer;

// An orchestrator's report can take most of a minute on a loaded machine, and both the sampler and the screen read it in the background.
const tasksTimeout = Duration.minutes(2);

const commandSources = Layer.mergeAll(
  hostSourcesLayer,
  taskProcessesSourceLayer,
  localTasksLayerWithin(tasksTimeout),
  pueueMachinesLayer,
  noMistakesMachinesLayer,
  orcMachinesLayer,
  tasksMachinesLayer,
  remoteTaskHistoryLayer,
  remoteTaskLiveLayer,
).pipe(Layer.provide(liveCommandRunner));

export const tasksSourcesLive = Layer.mergeAll(
  commandSources,
  Layer.merge(taskSamplesSourceLayer, sessionQuotaSourcesLayer).pipe(Layer.provide(Layer.merge(liveCommandRunner, BunFileSystem.layer))),
);
