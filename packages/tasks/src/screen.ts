import type { CliRenderer } from "@opentui/core";
import { type Config, DateTime, Effect, Option, type Scope } from "effect";
import {
  type HostSources,
  inBackground,
  type LocalTasks,
  machineNames,
  mergedTaskLevels,
  type NoMistakesMachines,
  type OrcMachines,
  type PueueMachines,
  readQuotas,
  type RemoteTaskHistory,
  type RemoteTaskLive,
  sessionQuotaOf,
  type SessionQuotaSources,
  type SessionQuotaView,
  type TaskProcessesSource,
  type TaskSamplesSource,
  type TasksMachines,
  unsetTaskLevels,
} from "@tui-dash/schema";
import { liveScreen, printScreen, runScreen, type Screen } from "@tui-dash/ui";
import {
  backgroundRemoteTaskPolls,
  backgroundTaskPolls,
  finishedRemoteTaskPolls,
  finishedTaskPolls,
  patience,
  readRemoteTaskLevels,
  readTaskLevels,
  type RemotePolls,
  type TaskPolls,
} from "./app";
import { drawTasks, type TasksReadings } from "./layout";
import { moved, type Navigation, startNavigation } from "./navigation";

export type TasksSources =
  | LocalTasks
  | TaskProcessesSource
  | HostSources
  | PueueMachines
  | NoMistakesMachines
  | OrcMachines
  | TaskSamplesSource
  | TasksMachines
  | RemoteTaskHistory
  | RemoteTaskLive
  | SessionQuotaSources;

interface Polls extends TaskPolls {
  readonly sessions: Effect.Effect<SessionQuotaView | undefined>;
  readonly remoteName: string;
  readonly remote: RemotePolls | undefined;
  readonly showRemote: boolean;
}

const backgroundPolls = (showRemote: boolean): Effect.Effect<Polls, Config.ConfigError, TasksSources | Scope.Scope> =>
  Effect.gen(function* () {
    const polls = yield* backgroundTaskPolls;
    const names = yield* machineNames;
    const remote = yield* backgroundRemoteTaskPolls;
    const quotaServices = yield* Effect.context<SessionQuotaSources>();
    const sessions = yield* inBackground(() => sessionQuotaOf(readQuotas), patience);
    return {
      ...polls,
      sessions: Effect.provideContext(Effect.map(sessions(undefined), Option.getOrUndefined), quotaServices),
      remoteName: names.remote,
      remote,
      showRemote,
    };
  });

// A remote screen with no remote command shows the remote reason, not this machine's tasks.
const unsetRemoteLevels = (machine: string, now: DateTime.Utc): TasksReadings => ({
  levels: unsetTaskLevels(machine, now, DateTime.zoneMakeLocal()),
  zone: DateTime.zoneMakeLocal(),
});

const everyMachine = (polls: TaskPolls, remote: RemotePolls, readSessions: Effect.Effect<SessionQuotaView | undefined>) =>
  Effect.map(
    Effect.all([readTaskLevels(polls, readSessions), readRemoteTaskLevels(remote, readSessions)], { concurrency: "unbounded" }),
    ([here, there]): TasksReadings => ({ levels: mergedTaskLevels([here.readings.levels, there.readings.levels]), zone: here.readings.zone }),
  );

const readTasks = (polls: Polls): Effect.Effect<TasksReadings, never, TaskSamplesSource> => {
  if (polls.showRemote && polls.remote !== undefined) return Effect.map(readRemoteTaskLevels(polls.remote, polls.sessions), (read) => read.readings);
  if (polls.showRemote) return Effect.map(DateTime.now, (now) => unsetRemoteLevels(polls.remoteName, now));
  if (polls.remote !== undefined) return everyMachine(polls, polls.remote, polls.sessions);
  return Effect.map(readTaskLevels(polls, polls.sessions), (read) => read.readings);
};

const tasksScreen = (polls: Polls): Screen<TasksReadings, Navigation, TaskSamplesSource> => ({
  read: readTasks(polls),
  initial: startNavigation,
  draw: drawTasks,
  move: (readings, navigation, move) => moved(readings.levels, navigation, move),
  pending: (readings) => readings.levels.pending,
});

const refresh = "10 seconds";

export const liveTasksScreen = (renderer: CliRenderer, remote = false): Effect.Effect<void, Config.ConfigError, TasksSources> =>
  Effect.scoped(Effect.flatMap(backgroundPolls(remote), (polls) => liveScreen(renderer, tasksScreen(polls), refresh)));

export const runTasksScreen = (remote = false): Effect.Effect<void, Config.ConfigError, TasksSources> =>
  Effect.scoped(Effect.flatMap(backgroundPolls(remote), (polls) => runScreen(tasksScreen(polls), refresh)));

const finishedPolls = (showRemote: boolean): Effect.Effect<Polls, Config.ConfigError, TasksSources> => Effect.gen(function* () {
  const polls = yield* finishedTaskPolls;
  const names = yield* machineNames;
  const remote = yield* finishedRemoteTaskPolls;
  const services = yield* Effect.context<SessionQuotaSources>();
  return {
    ...polls,
    sessions: yield* Effect.cached(Effect.provideContext(sessionQuotaOf(readQuotas), services)),
    remoteName: names.remote,
    remote,
    showRemote,
  };
});

export const printTasksFrame = (width: number, height: number, remote = false, color = false): Effect.Effect<void, Config.ConfigError, TasksSources> =>
  Effect.flatMap(finishedPolls(remote), (polls) => printScreen(tasksScreen(polls), width, height, color));
