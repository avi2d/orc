import { BunFileSystem } from "@effect/platform-bun";
import { type Config, Duration, Effect, Layer } from "effect";
import { alertSourcesLive } from "@tui-dash/alerts";
import { dispatchSourcesLive } from "@tui-dash/dispatch";
import { conversationSourceLive } from "@tui-dash/ledger";
import { queueFeedLayer, queueSourcesLive } from "@tui-dash/queues";
import {
  ciRunsLayer,
  savedProfilesSourceLayer,
  hostSourcesLayer,
  linuxTaskProcessesSourceLayer,
  macTaskProcessesSourceLayer,
  machineSchedulesLayer,
  noMistakesMachinesLayer,
  orcMachinesLayer,
  quotaFeedLayer,
  quotaSourceLayer,
  remoteTaskHistoryLayer,
  remoteTaskLiveLayer,
  resourceMachinesLayer,
  runnerReposLayer,
  type ConfigRefused,
  noSavedReadings,
  type ReadMode,
  ReadModeReference,
  savedReadingsLayer,
  sessionsFeedLayer,
  taskSamplesSourceLayer,
  tasksMachinesLayer,
  watchedLocalTasksLayerWithin,
} from "@tui-dash/schema";
import { harvestLogSourceLive, sessionSourcesLive } from "@tui-dash/session-quota";
import { taskBoardFeedLayer } from "@tui-dash/tasks";
import { liveCommandRunner } from "@tui-dash/ui";
import type { ModuleSources } from "../modules";

const onMac = process.platform === "darwin";

// The orchestrator's report can take most of a minute on a loaded machine, and the screen reads it in the background.
const tasksTimeout = Duration.minutes(2);

const runnerSources = Layer.mergeAll(ciRunsLayer, machineSchedulesLayer(onMac ? "mac" : "linux")).pipe(Layer.provideMerge(runnerReposLayer));

const commandSources = Layer.mergeAll(
  quotaSourceLayer,
  savedProfilesSourceLayer,
  hostSourcesLayer,
  resourceMachinesLayer,
  onMac ? macTaskProcessesSourceLayer : linuxTaskProcessesSourceLayer,
  watchedLocalTasksLayerWithin(tasksTimeout).pipe(Layer.provide(BunFileSystem.layer)),
  tasksMachinesLayer,
  noMistakesMachinesLayer,
  orcMachinesLayer,
  remoteTaskHistoryLayer,
  remoteTaskLiveLayer,
  runnerSources,
).pipe(Layer.provide(liveCommandRunner));

const sources = Layer.mergeAll(
  commandSources,
  taskSamplesSourceLayer.pipe(Layer.provide(BunFileSystem.layer)),
  harvestLogSourceLive,
  sessionSourcesLive,
  conversationSourceLive,
  queueSourcesLive,
  alertSourcesLive,
  dispatchSourcesLive,
);

export const moduleFeeds = Layer.mergeAll(taskBoardFeedLayer, queueFeedLayer).pipe(Layer.provideMerge(sessionsFeedLayer), Layer.provideMerge(quotaFeedLayer));

// A print reads every source once and waits for it, so no saved copy stands in and none is written.
const savedFor = (mode: ReadMode) => (mode === "live" ? savedReadingsLayer.pipe(Layer.provide(BunFileSystem.layer)) : noSavedReadings);

// Feeds choose live or print reads as they are built, so the read mode is provided outside the layer that builds them.
export const withModules =
  (mode: ReadMode) =>
  <A, E>(effect: Effect.Effect<A, E, ModuleSources>): Effect.Effect<A, E | Config.ConfigError | ConfigRefused> =>
    effect.pipe(Effect.provide(moduleFeeds.pipe(Layer.provideMerge(Layer.merge(sources, savedFor(mode))))), Effect.provideService(ReadModeReference, mode));
