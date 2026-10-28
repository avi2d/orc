import { DateTime } from "effect";
import {
  isLive,
  longStageOf,
  stalenessOf,
  type PipelineStage,
  type StageMark,
  type TaskPipeline,
  type TaskRow,
} from "@tui-dash/schema";
import { countdown, ellipsize, span, wrapParts, type Block, type Line, type Tone } from "@tui-dash/ui";

// The board's legend pins each mark to one tone, so every pipe dot reads the same everywhere.
export const markToneOf = (mark: StageMark): Tone => {
  switch (mark) {
    case "done": return "success";
    case "active": return "primary";
    case "needsYou": return "accent";
    case "waiting": return "warning";
    case "failed": return "error";
    case "next": return "muted";
    case "skipped": return "muted";
    case "unknown": return "subtle";
  }
};

export const lasted = (seconds: number): string => (seconds < 60 ? "<1m" : countdown(seconds));

const joined = (parts: ReadonlyArray<string | undefined>): string => parts.filter((part) => part !== undefined && part !== "").join(" · ");

const toneOf = (task: TaskRow, anchor: PipelineStage, now: DateTime.Utc): Tone => {
  const stale = stalenessOf(task.lastActiveAt === undefined ? undefined : DateTime.toEpochMillis(task.lastActiveAt), DateTime.toEpochMillis(now));
  const busy = anchor.seconds !== undefined && longStageOf(anchor.seconds, isLive(task.state));
  return stale === "red" ? "error" : stale === "yellow" || busy ? "warning" : "foreground";
};

export const currentOf = (task: TaskRow, pipeline: TaskPipeline, anchor: PipelineStage, now: DateTime.Utc, width: number): Block => {
  const parts = [
    anchor.name,
    task.state === "blocked" && pipeline.validating ? "validation still running" : undefined,
    ...(anchor.detail === undefined ? [] : anchor.detail.split(" · ")),
  ].filter((part): part is string => part !== undefined && part !== "");
  const tone = toneOf(task, anchor, now);
  return wrapParts(parts, Math.max(1, width)).map((text): Line => [span(ellipsize(text, Math.max(1, width)), tone)]);
};

export const activityOf = (task: TaskRow, anchor: PipelineStage, now: DateTime.Utc): string => {
  const idle =
    task.lastActiveAt === undefined ? undefined : Math.max(0, DateTime.toEpochMillis(now) / 1000 - DateTime.toEpochMillis(task.lastActiveAt) / 1000);
  return joined([
    idle === undefined ? undefined : `last activity ${lasted(idle)} ago`,
    anchor.seconds === undefined ? undefined : `${lasted(anchor.seconds)} in ${anchor.name}`,
  ]);
};
