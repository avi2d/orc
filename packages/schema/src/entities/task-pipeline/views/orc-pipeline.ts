import type { OrcRun } from "../contract/orc";
import {
  anchorOf,
  type OpenTaskState,
  runMarkOf,
  stageNamesOf,
  stageOf,
  stoppedAt,
  type TaskPipeline,
  unknownPipelineOf,
} from "./task-pipeline";

const orcStepOf: ReadonlyMap<string, string> = new Map([
  ["agent", "implement"],
  ["fix, up to 3", "fix"],
  ["no-mistakes PR", "no-mistakes"],
]);

export const orcPipelineOf = (run: OrcRun | undefined, state: OpenTaskState): TaskPipeline => {
  if (run === undefined) return unknownPipelineOf("orc run");
  const names = stageNamesOf("orc run");
  const byName = new Map(run.stages.map((stage) => [stage.name.toLowerCase(), stage]));
  const orderOf = new Map(run.stages.map((stage, index) => [stage.name.toLowerCase(), index]));
  // The implement step is the agent phase, and a listed run already finished its checkout.
  const stages = names.map((name) => {
    if (name === "take task" || name === "isolated copy") return stageOf(name, "done");
    const found = byName.get(name.toLowerCase()) ?? byName.get(orcStepOf.get(name) ?? "");
    if (found === undefined) return stageOf(name, "unknown");
    const mark = runMarkOf(found.status);
    const at = orderOf.get(found.name.toLowerCase()) ?? 0;
    const moved = mark === "failed" && run.stages.slice(at + 1).some((later) => runMarkOf(later.status) === "active");
    return stageOf(name, moved ? "next" : mark, found.detail);
  });
  const anchor = anchorOf(stages);
  const noticed = run.notice === undefined ? stages : stages.map((stage) => stage === anchor
    ? stageOf(stage.name, stage.mark, [stage.detail, run.notice].filter((part) => part !== undefined && part !== "").join(" \u00B7 "), stage.seconds)
    : stage);
  return { kind: "orc run", stages: stoppedAt(noticed, state), validating: false, parkedSeconds: undefined };
};
