import { type Config, Console, Effect, type FileSystem, Option } from "effect";
import { type QueueSources, readQueuesReport } from "@tui-dash/queues";
import { readMachineReports, type TaskSources } from "@tui-dash/resources";
import { readComposedSessionQuotaReport } from "@tui-dash/session-quota";
import {
  CiRuns,
  type CiReport,
  type ConfigRefused,
  type HostSources,
  MachineSchedules,
  machineNames,
  mapOutcome,
  type NightlyInputs,
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

export type AlertSources = SnapshotSources | MachineSchedules | CiRuns;

const emptyReport: CiReport = { repos: [], runs: [], failures: [] };

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

const readNightlySample: Effect.Effect<NightlyInputs, never, MachineSchedules | CiRuns> = Effect.gen(function* () {
  const schedules = yield* (yield* MachineSchedules).read;
  const runs = yield* CiRuns;
  if (Option.isNone(runs)) return { schedules, report: emptyReport };
  const reading = yield* runs.value.read;
  return { schedules, report: reading.kind === "ok" ? reading.value : emptyReport };
});

const liveAlertReaders: AlertReaders<AlertSources> = {
  quota: readComposedSessionQuotaReport,
  resources: readMachineReports,
  tasks: readTaskMachines,
  nightly: readNightlySample,
};

export const printSnapshotJson = (selected: ReadonlySet<SnapshotSource>): Effect.Effect<void, Config.ConfigError, SnapshotSources> =>
  Effect.gen(function* () {
    const names = yield* machineNames;
    const report = yield* snapshotReport(names.local, liveReaders, selected);
    yield* Console.log(JSON.stringify(report));
  });

export const printAlertsJson: Effect.Effect<void, Config.ConfigError | ConfigRefused, AlertSources | FileSystem.FileSystem> = Effect.gen(
  function* () {
    const settings = yield* readAlertSettings;
    yield* streamAlerts(liveAlertReaders, settings);
  },
);
