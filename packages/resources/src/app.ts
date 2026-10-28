import type { CliRenderer } from "@opentui/core";
import { Console, DateTime, Effect, Option } from "effect";
import {
  type HostSources,
  LocalTasks,
  type MachinesView,
  machineTaskResources,
  mapOutcome,
  ok,
  type Outcome,
  readBeside,
  readLocalResources,
  readMachines,
  ResourceMachines,
  ResourcesReport,
  resourcesReport,
  TaskProcessesSource,
} from "@tui-dash/schema";
import { livePanel as liveUiPanel, type Panel, panelWidth, printFrame, runPanel } from "@tui-dash/ui";
import { machinesLines } from "./panels";

export type TaskSources = LocalTasks | TaskProcessesSource;

type Sources = HostSources | ResourceMachines;

const resourcesPanel: Panel<MachinesView, Sources> = {
  read: readMachines,
  lines: (view, columns, rows) => machinesLines(view, panelWidth(columns), rows),
};

export const livePanel = (renderer: CliRenderer): Effect.Effect<void, never, Sources> =>
  liveUiPanel(renderer, resourcesPanel, "10 seconds");

export const runResourcesPanel: Effect.Effect<void, never, Sources> = runPanel(resourcesPanel, "10 seconds");

export const printResourcesFrame = (width: number, height: number = Number.POSITIVE_INFINITY, color = false): Effect.Effect<void, never, Sources> =>
  printFrame(resourcesPanel, width, height, color);

export const readResourcesReport: Effect.Effect<ResourcesReport, never, HostSources | TaskSources> = Effect.gen(function* () {
  const localTasks = yield* LocalTasks;
  const sampler = yield* TaskProcessesSource;
  const taskReadings = Effect.transposeOption(
    Option.map(localTasks, (machine) => Effect.all([machine.read, sampler.read], { concurrency: "unbounded" })),
  );
  const [view, readings] = yield* Effect.all([readLocalResources, taskReadings], { concurrency: "unbounded" });
  const generatedAt = yield* DateTime.now;
  const tasks = Option.getOrUndefined(Option.map(readings, (read) => machineTaskResources(view.machine, ...read)));
  return resourcesReport({ generatedAt, view, tasks });
});

export const printResourcesJson: Effect.Effect<void, never, HostSources | TaskSources> = Effect.flatMap(readResourcesReport, (report) =>
  Console.log(JSON.stringify(report)),
);

export interface MachineReport {
  readonly name: string;
  readonly reading: Outcome<ResourcesReport>;
}

export const readMachineReports: Effect.Effect<ReadonlyArray<MachineReport>, never, HostSources | TaskSources | ResourceMachines> =
  Effect.gen(function* () {
    const configured = yield* ResourceMachines;
    const [local, remotes] = yield* readBeside(readResourcesReport, configured);
    return [
      { name: configured.local, reading: ok(local) },
      ...remotes.map(({ name, reading }) => ({ name, reading: mapOutcome(reading, resourcesReport) })),
    ];
  });
