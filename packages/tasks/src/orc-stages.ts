import { type Config, Effect } from "effect";
import { anchorOf, machineNames, OrcMachines, orcPipelineOf, orcRunOf, pipelineFoldersOf, type ReportedTasks } from "@tui-dash/schema";

export const orcStagesOf = (reported: ReportedTasks): Effect.Effect<ReadonlyMap<string, string> | undefined, Config.ConfigError, OrcMachines> =>
  Effect.gen(function* () {
    const folders = pipelineFoldersOf(reported.view.tasks, "orc run");
    if (folders.length === 0) return undefined;
    const machines = yield* OrcMachines;
    const names = yield* machineNames;
    const local = machines.find((machine) => machine.name === names.local) ?? machines.at(0);
    if (local === undefined) return undefined;
    const reading = yield* local.read(folders);
    if (reading.kind !== "ok") return undefined;
    const stages = new Map<string, string>();
    for (const task of reported.view.tasks) {
      if (task.kind !== "orc run" || task.state === "done") continue;
      const anchor = anchorOf(orcPipelineOf(orcRunOf(reading.value, task.id, task.branches), task.state).stages)?.name;
      if (anchor !== undefined) stages.set(task.id, anchor);
    }
    return stages;
  });
