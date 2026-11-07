import { type Config, Console, Effect, type FileSystem } from "effect";
import { type QueueSources, readQueuesReport } from "@tui-dash/queues";
import { readMachineReports, type TaskSources } from "@tui-dash/resources";
import { readComposedSessionQuotaReport } from "@tui-dash/session-quota";
import {
  type ConfigRefused,
  type HostSources,
  machineNames,
  mapOutcome,
  readAlertSettings,
  type ResourceMachines,
  type SessionQuotaSources,
  type SnapshotSource,
  TasksMachines,
  tasksReport,
} from "@tui-dash/schema";
import { type AlertReaders, streamAlerts } from "./alerts";
import { type SnapshotReaders, snapshotReport } from "./snapshot";

export type SnapshotSources = SessionQuotaSources | HostSources | TaskSources | ResourceMachines | QueueSources | TasksMachines;

const readTaskMachines = Effect.flatMap(TasksMachines, (machines) =>
  Effect.forEach(machines, (machine) => Effect.map(machine.read, (reading) => ({ name: machine.name, reading })), {
    concurrency: "unbounded",
  }),
);

const readTasksReports = Effect.map(readTaskMachines, (machines) =>
  machines.map(({ name, reading }) => ({ name, reading: mapOutcome(reading, tasksReport) })),
);

export const liveReaders: SnapshotReaders<SnapshotSources> = {
  quota: Effect.map(readComposedSessionQuotaReport, (report) => ({ report })),
  resources: Effect.map(readMachineReports, (machines) => ({ machines })),
  queues: readQueuesReport,
  tasks: Effect.map(readTasksReports, (machines) => ({ machines })),
};

const liveAlertReaders: AlertReaders<SnapshotSources> = {
  quota: readComposedSessionQuotaReport,
  resources: readMachineReports,
  tasks: readTaskMachines,
};

export const printSnapshotJson = (selected: ReadonlySet<SnapshotSource>): Effect.Effect<void, Config.ConfigError, SnapshotSources> =>
  Effect.gen(function* () {
    const names = yield* machineNames;
    const report = yield* snapshotReport(names.local, liveReaders, selected);
    yield* Console.log(JSON.stringify(report));
  });

export const printAlertsJson: Effect.Effect<void, Config.ConfigError | ConfigRefused, SnapshotSources | FileSystem.FileSystem> = Effect.gen(
  function* () {
    const settings = yield* readAlertSettings;
    yield* streamAlerts(liveAlertReaders, settings);
  },
);
