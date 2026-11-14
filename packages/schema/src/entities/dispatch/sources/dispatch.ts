import { Config, DateTime, Duration, Effect, Result, Schema } from "effect";
import { CommandRunner } from "../../../shared/lib";
import { decodeJson, decodeValue } from "../../../shared/lib";
import { mapOutcome, type Outcome } from "../../../shared/lib";
import { runDecoded } from "../../../shared/lib";
import { selector } from "../../../shared/config";
import { MachinesFile } from "./dispatch-schema";

interface DispatchClaim {
  readonly beat: string;
  readonly machine: string;
  readonly account: string;
  readonly takenAt: string;
}

interface DispatchStarted {
  readonly at: string;
  readonly log: string;
}

type DispatchClosing =
  | { readonly outcome: "start-failed"; readonly reason: string }
  | { readonly outcome: "done" | "failed" | "stopped"; readonly started: DispatchStarted; readonly reason: string };

export type DispatchTaskState =
  | { readonly kind: "new" }
  | { readonly kind: "taken"; readonly claim: DispatchClaim | null }
  | { readonly kind: "started"; readonly claim: DispatchClaim; readonly started: DispatchStarted }
  | { readonly kind: "closed"; readonly claim: DispatchClaim; readonly closing: DispatchClosing; readonly closedAt: string }
  | { readonly kind: "closed"; readonly claim: null; readonly closing: { readonly outcome: "dropped" | "answered"; readonly reason: string }; readonly closedAt: string };

export type TaskFolder = "new" | "taken" | "closed";

export const TaskFields = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  project: Schema.String,
  machine: Schema.NullOr(Schema.String),
  depends_on: Schema.Array(Schema.String),
  created: Schema.String,
  kind: Schema.optional(Schema.Literals(["ship", "scout", "task", "parent", "decision"])),
  beat: Schema.optional(Schema.String),
  taken_for: Schema.optional(Schema.String),
  account: Schema.optional(Schema.String),
  taken_at: Schema.optional(Schema.String),
  started_at: Schema.optional(Schema.String),
  start_log: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.Literals(["done", "failed", "stopped", "start-failed", "dropped"])),
  closed_at: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});

export type TaskFields = typeof TaskFields.Type;

const feed = String.fromCharCode(10);
const fence = "---";

const splitFrontmatter = (text: string): string | undefined => {
  if (!text.startsWith(fence + feed)) return undefined;
  const end = text.indexOf(feed + fence + feed, fence.length);
  return end === -1 ? undefined : text.slice(fence.length + 1, end);
};

export const taskFields = (file: string, text: string): TaskFields | string => {
  const head = splitFrontmatter(text);
  if (head === undefined) return file + ": its first lines hold no task orc can read";
  const raw = Result.try((): unknown => Bun.YAML.parse(head));
  if (Result.isFailure(raw)) return file + ": its frontmatter is no YAML orc can read";
  const fields = decodeValue(TaskFields)(raw.success);
  return fields.kind === "ok" ? fields.value : file + ": its frontmatter holds no task orc can read";
};

const claimOf = (front: TaskFields): DispatchClaim | null =>
  front.beat === undefined || front.taken_for === undefined || front.account === undefined || front.taken_at === undefined
    ? null
    : { beat: front.beat, machine: front.taken_for, account: front.account, takenAt: front.taken_at };

const startedOf = (front: TaskFields): DispatchStarted | null =>
  front.started_at === undefined ? null : { at: front.started_at, log: front.start_log ?? "" };

const closingOf = (front: TaskFields, started: DispatchStarted | null): DispatchClosing | null => {
  const reason = front.reason ?? "";
  if (front.outcome === "start-failed") return { outcome: "start-failed", reason };
  return front.outcome === undefined || front.outcome === "dropped" || started === null ? null : { outcome: front.outcome, started, reason };
};

export const stateOf = (folder: TaskFolder, file: string, front: TaskFields): DispatchTaskState | string => {
  if (folder === "new") return { kind: "new" };
  const claim = claimOf(front);
  const started = startedOf(front);
  if (folder === "taken") {
    if (started === null) return { kind: "taken", claim };
    return claim === null ? file + ": a started task names no claim" : { kind: "started", claim, started };
  }
  const unclaimed = front.outcome === "dropped" ? "dropped" : front.kind === "decision" && front.outcome === "done" ? "answered" : null;
  if (unclaimed !== null) {
    return front.closed_at === undefined
      ? file + ": a " + unclaimed + " task names no close time"
      : { kind: "closed", claim: null, closing: { outcome: unclaimed, reason: front.reason ?? "" }, closedAt: front.closed_at };
  }
  const closing = closingOf(front, started);
  if (claim === null || closing === null || front.closed_at === undefined) {
    return file + ": a closed task names no claim, outcome or close time";
  }
  return { kind: "closed", claim, closing, closedAt: front.closed_at };
};

export type DispatchMachine = typeof MachinesFile.Type["machines"][number];

export interface DispatchProject {
  readonly name: string;
  readonly checkouts: Readonly<Partial<Record<string, string>>>;
}

export interface DispatchTask {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly machine: string | null;
  readonly dependsOn: ReadonlyArray<string>;
  readonly created: string;
  readonly state: DispatchTaskState;
}

export interface DispatchSnapshot {
  readonly root: string;
  readonly missing: boolean;
  readonly machines: Outcome<ReadonlyArray<DispatchMachine>>;
  readonly projects: Outcome<ReadonlyArray<DispatchProject>>;
  readonly tasks: ReadonlyArray<DispatchTask>;
  readonly waits: Outcome<BeatWaits>;
  readonly unread: ReadonlyArray<string>;
}

export interface DispatchReading {
  readonly snapshot: DispatchSnapshot;
  readonly capturedAt: DateTime.Utc;
}


const BacklogWaits = Schema.Struct({
  schema: Schema.Literal("orc.backlog.v1"),
  tasks: Schema.Array(Schema.Struct({ id: Schema.String, wait: Schema.NullOr(Schema.String) })),
});

// A task id absent from the map has nothing the beat waits on.
type BeatWaits = ReadonlyMap<string, string>;

const beatWaitsOf = (backlog: typeof BacklogWaits.Type): BeatWaits =>
  new Map(backlog.tasks.flatMap((task) => (task.wait === null ? [] : [[task.id, task.wait] as const])));

const backlogTimeout = Duration.seconds(15);

export const readBeatWaits: Effect.Effect<Outcome<BeatWaits>, never, CommandRunner> = Effect.map(
  runDecoded({ argv: ["orc", "backlog", "--json"], timeout: backlogTimeout }, decodeJson(BacklogWaits)),
  (outcome) => mapOutcome(outcome, beatWaitsOf),
);

const backlogVariable = "ORC_HOME";

export const missingBacklog = (root: string): string => "no backlog at " + root + ": it lives on the machine that runs orc beat";

export const backlogRoot: Config.Config<string> = Config.all({
  explicit: selector(backlogVariable),
  home: Config.String("HOME"),
}).pipe(Config.map(({ explicit, home }) => (explicit ?? home + "/.orc") + "/backlog"));


