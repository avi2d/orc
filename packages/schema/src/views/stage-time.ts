import { DateTime } from "effect";
import type { StageCue } from "./task-history";
import { anchorOf, type CueKind, cuePipelineOf, type OpenTaskState } from "./task-pipeline";

const staleYellowMs = 5 * 60 * 1000;

const staleRedMs = 15 * 60 * 1000;

const longStageSeconds = 2 * 60 * 60;

export type Staleness = "fresh" | "yellow" | "red" | "none";

export const stalenessOf = (lastActiveMillis: number | undefined, nowMillis: number): Staleness => {
  if (lastActiveMillis === undefined) return "none";
  const idle = Math.max(0, nowMillis - lastActiveMillis);
  if (idle >= staleRedMs) return "red";
  if (idle >= staleYellowMs) return "yellow";
  return "fresh";
};

export const longStageOf = (seconds: number, live: boolean): boolean => live && seconds >= longStageSeconds;

interface Cue {
  readonly kind: CueKind;
  readonly state: OpenTaskState;
  readonly detail: string;
  readonly branches: ReadonlyArray<string>;
}

export const orcStageSecondsOf = (stage: string | undefined, cues: ReadonlyArray<StageCue>, now: DateTime.Utc): number | undefined => {
  if (stage === undefined) return undefined;
  let since: DateTime.Utc | undefined;
  for (const cue of cues.toReversed()) {
    if (cue.orcStage !== stage) break;
    since = cue.orcStageSince ?? cue.at;
  }
  return since === undefined ? undefined : Math.max(0, (DateTime.toEpochMillis(now) - DateTime.toEpochMillis(since)) / 1000);
};

// A cue names its stage only through its detail, so the stage began with the oldest of the latest cues that name it.
export const cueStageSecondsOf = ({ kind, state, detail, branches }: Cue, cues: ReadonlyArray<StageCue>, now: DateTime.Utc): number | undefined => {
  const stageNamed = (cued: OpenTaskState, said: string) => anchorOf(cuePipelineOf(kind, cued, said, branches).stages)?.name;
  const current = stageNamed(state, detail);
  let since: DateTime.Utc | undefined;
  for (const cue of cues.toReversed()) {
    if (cue.state === "done" || cue.detail === undefined || stageNamed(cue.state, cue.detail) !== current) break;
    since = cue.at;
  }
  return since === undefined ? undefined : Math.max(0, (DateTime.toEpochMillis(now) - DateTime.toEpochMillis(since)) / 1000);
};
