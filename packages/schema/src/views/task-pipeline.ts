import type { NoMistakesRun, NoMistakesSnapshot, NoMistakesStep } from "../contract/no-mistakes";
import type { OrcRun, OrcSnapshot } from "../contract/orc";
import type { TaskEntry, TaskState } from "../contract/tasks";

export const pipelineKinds = ["full review fix", "quick fix", "local only", "scout", "orc run"] as const;
export type PipelineKind = (typeof pipelineKinds)[number];

const isPipelineKind = (kind: string): kind is PipelineKind => (pipelineKinds as ReadonlyArray<string>).includes(kind);

export const kindOf = (kind: string): PipelineKind | undefined => (isPipelineKind(kind) ? kind : undefined);

const fullReviewStages = [
  "build",
  "intent",
  "catch up with main",
  "review",
  "test",
  "docs",
  "lint",
  "push",
  "PR",
  "CI",
  "merge",
] as const;

const quickFixStages = ["build", "PR", "CI", "merge"] as const;

const localOnlyStages = ["build", "ready branch", "your approval", "land locally"] as const;

const scoutStages = ["investigate", "report", "your calls", "follow-ups filed"] as const;

const orcStages = ["take task", "isolated copy", "agent", "checks", "fix, up to 3", "no-mistakes PR", "report"] as const;

export const rebuildStage = "your rebuild";

export const stageNamesOf = (kind: PipelineKind): ReadonlyArray<string> => {
  switch (kind) {
    case "full review fix":
      return [...fullReviewStages];
    case "quick fix":
      return [...quickFixStages];
    case "local only":
      return [...localOnlyStages];
    case "scout":
      return [...scoutStages];
    case "orc run":
      return [...orcStages];
  }
};

export const stageMarkNames = ["done", "active", "needsYou", "waiting", "failed", "next", "skipped", "unknown"] as const;

export type StageMark = (typeof stageMarkNames)[number];

export const markGlyphOf = (mark: StageMark): string => {
  switch (mark) {
    case "done": return "✓";
    case "active": return "●";
    case "needsYou": return "◆";
    case "waiting": return "◷";
    case "failed": return "✕";
    case "next": return "○";
    case "skipped": return "–";
    case "unknown": return "○";
  }
};

export type TaskDerivedState = TaskState | "unknown";
export type OpenTaskState = Exclude<TaskDerivedState, "done">;

export interface PipelineStage {
  readonly name: string;
  readonly mark: StageMark;
  readonly detail: string | undefined;
  readonly seconds: number | undefined;
}

export interface TaskPipeline {
  readonly kind: PipelineKind;
  readonly stages: ReadonlyArray<PipelineStage>;
  readonly validating: boolean;
  readonly parkedSeconds: number | undefined;
}

export const stageOf = (name: string, mark: StageMark, detail?: string, seconds?: number): PipelineStage => ({
  name,
  mark,
  detail,
  seconds,
});

export const unknownPipelineOf = (kind: PipelineKind): TaskPipeline => ({
  kind,
  stages: stageNamesOf(kind).map((name) => stageOf(name, "unknown")),
  validating: false,
  parkedSeconds: undefined,
});

export const donePipelineOf = (kind: PipelineKind): TaskPipeline => ({
  kind,
  stages: stageNamesOf(kind).map((name) => stageOf(name, "done")),
  validating: false,
  parkedSeconds: undefined,
});

export const anchorOf = (stages: ReadonlyArray<PipelineStage>): PipelineStage | undefined =>
  stages.find((stage) => stage.mark === "failed") ??
  stages.find((stage) => stage.mark === "needsYou") ??
  stages.find((stage) => stage.mark === "waiting") ??
  stages.find((stage) => stage.mark === "active") ??
  stages.find((stage) => stage.mark === "next");

// A blocked worker stopped on the stage it was at, whatever the record says that stage is still doing.
export const stoppedAt = (stages: ReadonlyArray<PipelineStage>, state: OpenTaskState): ReadonlyArray<PipelineStage> => {
  if (state !== "blocked") return stages;
  const anchor = anchorOf(stages);
  return stages.map((stage) => (stage === anchor ? stageOf(stage.name, "failed", stage.detail, stage.seconds) : stage));
};

const normalized = (text: string): string =>
  text.toLowerCase().replaceAll(/[^a-z0-9 ]/gu, " ").replaceAll(/\s+/gu, " ").trim();

export type CueKind = Exclude<PipelineKind, "full review fix" | "orc run">;

const stageAliasesOf = (kind: PipelineKind): ReadonlyArray<ReadonlyArray<string>> => {
  switch (kind) {
    case "full review fix":
      return [["build"], ["intent"], ["catch up", "rebase"], ["review"], ["test"], ["docs", "document"], ["lint"], ["push"], ["pr", "pull request"], ["ci", "checks"], ["merge"]];
    case "orc run":
      return [["take task"], ["isolated copy"], ["agent"], ["checks"], ["fix"], ["no mistakes pr", "pr"], ["report"]];
    case "quick fix":
      return [["build"], ["pr", "pull request", "http"], ["ci", "checks"], ["merge"], ["rebuild"]];
    case "local only":
      return [["build"], ["ready branch"], ["approval"], ["land"]];
    case "scout":
      return [["investigat"], ["report"], ["your calls", "decision"], ["follow up", "followup"]];
  }
};

// Short aliases such as pr and ci sit inside longer words, so they match only as whole words.
const aliasAt = (alias: string, words: string): number => {
  const padded = " " + words + " ";
  const at = padded.indexOf(" " + alias + (alias.length <= 3 ? " " : ""));
  return at === -1 ? Number.POSITIVE_INFINITY : at;
};

// A detail names the stage it is on before any it looks ahead to, as in "investigating; will report back".
const aliasIndexInDetail = (kind: PipelineKind, detail: string): number => {
  const words = normalized(detail);
  const positions = stageAliasesOf(kind).map((group) => Math.min(...group.map((alias) => aliasAt(alias, words))));
  const earliest = Math.min(...positions);
  return earliest === Number.POSITIVE_INFINITY ? -1 : positions.indexOf(earliest);
};

export const cueMarkOf = (state: Exclude<OpenTaskState, "unknown">): StageMark => {
  switch (state) {
    case "working": return "active";
    case "waiting": return "needsYou";
    case "parked": return "waiting";
    case "blocked": return "failed";
  }
};

const withRebuild = (stages: ReadonlyArray<string>, detail: string, branches: ReadonlyArray<string>): ReadonlyArray<string> => {
  const mentioned = detail.toLowerCase().includes("rebuild") || branches.some((branch) => branch.toLowerCase().includes("rebuild"));
  return mentioned ? [...stages, rebuildStage] : stages;
};

const orderedFill = (names: ReadonlyArray<string>, anchor: number, mark: StageMark, detail: string | undefined): ReadonlyArray<PipelineStage> =>
  names.map((name, index) => {
    if (index < anchor) return stageOf(name, "done");
    if (index === anchor) return stageOf(name, mark, detail);
    return stageOf(name, "next");
  });

export const withAnchorSeconds = (pipeline: TaskPipeline, seconds: number | undefined): TaskPipeline => {
  const anchor = anchorOf(pipeline.stages);
  return { ...pipeline, stages: pipeline.stages.map((stage) => (stage === anchor ? stageOf(stage.name, stage.mark, stage.detail, seconds) : stage)) };
};

export const cuePipelineOf = (kind: CueKind, state: OpenTaskState, detail: string, branches: ReadonlyArray<string>): TaskPipeline => {
  const names = kind === "quick fix" ? withRebuild(stageNamesOf(kind), detail, branches) : stageNamesOf(kind);
  if (state === "unknown") return { kind, stages: names.map((name) => stageOf(name, "unknown")), validating: false, parkedSeconds: undefined };
  const found = aliasIndexInDetail(kind, detail);
  const stages = found === -1 ? orderedFill(names, 0, cueMarkOf(state), undefined) : orderedFill(names, found, cueMarkOf(state), summaryOf(detail));
  return { kind, stages, validating: false, parkedSeconds: undefined };
};

const countOf = (pattern: RegExp, detail: string): number | undefined => {
  const match = pattern.exec(detail);
  if (match === null) return undefined;
  return Number.parseInt(match[1], 10);
};

export const fixRoundOf = (detail: string): number | undefined => countOf(/\bfix(?:\s+round)?\s+([12])(?!\d)/iu, detail);

export const checksOf = (detail: string): { readonly passed: number; readonly total: number } | undefined => {
  const match = /(\d+)\s+of\s+(\d+)\s+checks?/iu.exec(detail);
  if (match === null) return undefined;
  return { passed: Number.parseInt(match[1], 10), total: Number.parseInt(match[2], 10) };
};

const waitsCue = /wait(?:ing|s)?\s+(?:on|for)\s+([^·]+?)(?:\s+·|$)/iu;

export const waitsOnOf = (detail: string): string | undefined => {
  const match = waitsCue.exec(detail);
  if (match === null) return undefined;
  const waits = match[1].trim();
  return waits === "" ? undefined : waits;
};

const findingsText = (findings: number): string => findings + (findings === 1 ? " finding" : " findings");

const roundText = (round: number): string => "fix " + round + " of 2";

const outsideCuesOf = (detail: string): ReadonlyArray<string | undefined> => {
  const checks = checksOf(detail);
  const waits = waitsOnOf(detail);
  return [checks === undefined ? undefined : checks.passed + " of " + checks.total + " passed", waits === undefined ? undefined : "waits on " + waits];
};

const joinedDetail = (parts: ReadonlyArray<string | undefined>): string | undefined => {
  const kept = parts.filter((part) => part !== undefined && part !== "");
  return kept.length === 0 ? undefined : kept.join(" · ");
};

export const detailWithoutWaitsOf = (detail: string): string | undefined =>
  joinedDetail(detail.replace(waitsCue, " · ").split("·").map((part) => part.trim()));

// A recorded pipeline holds its own findings and rounds, while only the orchestrator's detail counts checks and names a wait.
export const withDetailCue = (pipeline: TaskPipeline, detail: string): TaskPipeline => {
  const cue = joinedDetail(outsideCuesOf(detail));
  const named = aliasIndexInDetail(pipeline.kind, detail);
  if (cue === undefined || named === -1) return pipeline;
  return {
    ...pipeline,
    stages: pipeline.stages.map((stage, index) => (index === named ? stageOf(stage.name, stage.mark, joinedDetail([stage.detail, cue]), stage.seconds) : stage)),
  };
};

export const summaryOf = (detail: string): string | undefined => {
  const parts: Array<string> = [];
  const findings = countOf(/(\d+)\s+(?:\S+\s+)?findings?/iu, detail);
  if (findings !== undefined) parts.push(findingsText(findings));
  const awaiting = countOf(/(\d+)\s+awaiting/iu, detail);
  if (awaiting !== undefined) parts.push(awaiting + " awaiting");
  const autoFix = countOf(/(\d+)\s+auto-fix/iu, detail);
  if (autoFix !== undefined) parts.push(autoFix + " auto-fix");
  const round = fixRoundOf(detail);
  if (round !== undefined) parts.push(roundText(round));
  return joinedDetail([...parts, ...outsideCuesOf(detail)]);
};

export const modelBadgeOf = (model: string | undefined): string | undefined => {
  if (model === undefined) return undefined;
  if (/opus/iu.test(model)) return "Opus";
  if (/sonnet/iu.test(model)) return "Sonnet";
  if (/haiku/iu.test(model)) return "Haiku";
  if (/muse/iu.test(model)) return "Muse";
  return model.length <= 14 ? model : model.slice(0, 13).trimEnd();
};

const noMistakesStepName: ReadonlyMap<string, string> = new Map([
  ["intent", "intent"],
  ["rebase", "catch up with main"],
  ["review", "review"],
  ["test", "test"],
  ["document", "docs"],
  ["lint", "lint"],
  ["push", "push"],
  ["pr", "PR"],
  ["ci", "CI"],
]);

export const runMarkOf = (status: string): StageMark => {
  switch (status.toLowerCase()) {
    case "completed":
    case "complete":
    case "success":
    case "passed":
      return "done";
    case "running":
    case "active":
    case "in_progress":
    case "in-progress":
    case "fixing":
      return "active";
    case "awaiting_approval":
      return "needsYou";
    case "parked":
      return "waiting";
    case "failed":
    case "failure":
    case "error":
    case "errored":
    case "cancelled":
      return "failed";
    case "skipped":
      return "skipped";
    case "queued":
    case "pending":
    case "waiting":
      return "next";
    default:
      return "unknown";
  }
};

const reviewerShortOf = (reviewer: string): string => {
  const bare = reviewer.split("/").at(-1) ?? reviewer;
  const word = bare.split("-").findLast((part) => /[a-z]/iu.test(part)) ?? bare;
  return word.slice(0, 1).toUpperCase() + word.slice(1);
};

// The run's breakdown counts what the review raised, so it stands beside the reviewer rather than on a later stage.
const stepDetailOf = (name: string, step: NoMistakesStep, run: NoMistakesRun): string | undefined => {
  const round = fixRoundOf(step.active?.round ?? "");
  const review = name === "review";
  const findings = review && run.findings !== undefined ? run.findings : step.findings === 0 ? undefined : findingsText(step.findings);
  return joinedDetail([
    review && run.reviewer !== undefined ? "reviewer " + reviewerShortOf(run.reviewer) : undefined,
    findings,
    round === undefined ? undefined : roundText(round),
  ]);
};

const fullReviewStageOf = (
  name: string,
  later: ReadonlyArray<string>,
  byName: ReadonlyMap<string, NoMistakesStep>,
  runMark: StageMark,
  run: NoMistakesRun,
): PipelineStage => {
  if (name === "build") return stageOf(name, "done");
  if (name === "merge") return stageOf(name, runMark === "done" ? "next" : "unknown");
  const step = byName.get(name);
  // A completed record that names a later step skipped this one, as when a docs-only change skips review.
  if (step === undefined)
    return stageOf(name, runMark === "done" && later.some((stage) => byName.get(stage) !== undefined) ? "skipped" : "unknown");
  const seconds = step.active?.seconds ?? (step.durationMs > 0 ? Math.round(step.durationMs / 1000) : undefined);
  return stageOf(name, runMarkOf(step.status), stepDetailOf(name, step, run), seconds);
};

// Stages before the open one finished with it, so a wait on CI still shows the test run done.
const fillEarlierDone = (stages: ReadonlyArray<PipelineStage>, anchor: number): Array<PipelineStage> =>
  stages.map((stage, index) => (index < anchor && stage.mark !== "done" ? stageOf(stage.name, "done", stage.detail, stage.seconds) : stage));

const openMarks: ReadonlySet<StageMark> = new Set(["active", "needsYou", "waiting", "next"]);

const holdingMarks: ReadonlySet<StageMark> = new Set(["failed", "needsYou", "waiting", "active"]);

export const fullReviewPipelineOf = (run: NoMistakesRun | undefined, state: OpenTaskState): TaskPipeline => {
  if (run === undefined) return unknownPipelineOf("full review fix");
  const runMark = runMarkOf(run.status);
  const validating = openMarks.has(runMark);
  // Without step rows the record names no stage, so the row dims instead of guessing.
  if (run.steps.length === 0) return { ...unknownPipelineOf("full review fix"), validating, parkedSeconds: run.parkedSeconds };
  const names = stageNamesOf("full review fix");
  const byName = new Map(run.steps.map((step) => [noMistakesStepName.get(step.step.toLowerCase()) ?? step.step, step]));
  const stages = names.map((name, index) => fullReviewStageOf(name, names.slice(index + 1), byName, runMark, run));
  const anchor = stages.findIndex((stage) => holdingMarks.has(stage.mark));
  return { kind: "full review fix", stages: stoppedAt(fillEarlierDone(stages, anchor), state), validating, parkedSeconds: run.parkedSeconds };
};

export const noMistakesRunOf = (snapshot: NoMistakesSnapshot | undefined, branches: ReadonlyArray<string>): NoMistakesRun | undefined => {
  if (snapshot === undefined) return undefined;
  return snapshot.find((run) => run.branch !== "" && branches.includes(run.branch));
};

export const orcRunOf = (snapshot: OrcSnapshot | undefined, id: string, branches: ReadonlyArray<string>): OrcRun | undefined => {
  if (snapshot === undefined) return undefined;
  return snapshot.runs.find((run) => run.id === id || (run.branch !== undefined && branches.includes(run.branch)));
};

export interface PipelineFolder {
  readonly folder: string;
  readonly branches: ReadonlyArray<string>;
}

export const pipelineFoldersOf = (tasks: ReadonlyArray<TaskEntry>, kind: "full review fix" | "orc run"): ReadonlyArray<PipelineFolder> => {
  const branches = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (task.kind !== kind || task.state === "done") continue;
    for (const folder of task.folders) branches.set(folder, new Set([...(branches.get(folder) ?? []), ...task.branches]));
  }
  return [...branches].map(([folder, wanted]) => ({ folder, branches: [...wanted] }));
};
