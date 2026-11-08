import { anchorOf, type StageMark, type TaskPipeline } from "./task-pipeline";

// A recorded stage can hold a task the orchestrator still calls working, and never eases a state it reports.
export interface GateHold {
  readonly mark: Extract<StageMark, "needsYou" | "waiting">;
  readonly seconds: number | undefined;
}

// Only the recorded full review row names a gate, so only it holds the pane; cue rows read their wait from the worker detail.
export const gateHoldOf = (pipeline: TaskPipeline | undefined): GateHold | undefined => {
  if (pipeline?.kind !== "full review fix") return undefined;
  const anchor = anchorOf(pipeline.stages);
  if (anchor?.mark !== "needsYou" && anchor?.mark !== "waiting") return undefined;
  return { mark: anchor.mark, seconds: pipeline.parkedSeconds };
};
