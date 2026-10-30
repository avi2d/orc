import { Config, Context, DateTime, Effect, FileSystem, Layer, Result, Schema } from "effect";
import { decodeJson, decodeValue } from "../decode";
import { mapOutcome, ok, type Outcome, unreachable } from "../reading";
import { selector } from "./environment";

type DispatchMachine = typeof MachinesFile.Type["machines"][number];

interface DispatchProject {
  readonly name: string;
  readonly checkouts: Readonly<Partial<Record<string, string>>>;
}

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
  | { readonly outcome: "done" | "failed"; readonly started: DispatchStarted; readonly reason: string };

type DispatchTaskState =
  | { readonly kind: "new" }
  | { readonly kind: "taken"; readonly claim: DispatchClaim | null }
  | { readonly kind: "started"; readonly claim: DispatchClaim; readonly started: DispatchStarted }
  | { readonly kind: "closed"; readonly claim: DispatchClaim; readonly closing: DispatchClosing; readonly closedAt: string };

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
  readonly unread: ReadonlyArray<string>;
}

export interface DispatchReading {
  readonly snapshot: DispatchSnapshot;
  readonly capturedAt: DateTime.Utc;
}

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const Name = Schema.String.check(Schema.isPattern(namePattern));

const Command = Schema.NonEmptyArray(Schema.String.check(Schema.isNonEmpty()));

const AbsolutePath = Schema.String.check(Schema.isPattern(/^\//));

const Machine = Schema.Struct({
  name: Name,
  slots: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  start: Command,
  renew: Schema.optionalKey(Command),
});

const Account = Schema.Union([
  Schema.Struct({ name: Name, kind: Schema.Literal("token-file"), tokenFile: AbsolutePath, tokenCommand: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ name: Name, kind: Schema.Literal("token-command"), tokenCommand: Command, tokenFile: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ name: Name, kind: Schema.Literal("none"), tokenFile: Schema.optionalKey(Schema.Never), tokenCommand: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ name: Name, tokenFile: AbsolutePath, tokenCommand: Schema.optionalKey(Schema.Never), kind: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ name: Name, tokenCommand: Command, tokenFile: Schema.optionalKey(Schema.Never), kind: Schema.optionalKey(Schema.Never) }),
]);

const MachinesFile = Schema.Struct({
  machines: Schema.Array(Machine),
  quota: Schema.Struct({
    provider: Schema.String.check(Schema.isPattern(namePattern)),
    command: Command,
    accounts: Schema.NonEmptyArray(Account),
    floorPercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  }),
});

const Project = Schema.Struct({ name: Name, checkouts: Schema.Record(Name, Schema.String.check(Schema.isPattern(/^\//))) });

const ProjectsFile = Schema.Struct({ projects: Schema.Array(Project) });

const duplicateOf = (names: ReadonlyArray<string>): string | null => names.find((name, index) => names.indexOf(name) !== index) ?? null;

const TaskFields = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  project: Schema.String,
  machine: Schema.NullOr(Schema.String),
  depends_on: Schema.Array(Schema.String),
  created: Schema.String,
  beat: Schema.optional(Schema.String),
  taken_for: Schema.optional(Schema.String),
  account: Schema.optional(Schema.String),
  taken_at: Schema.optional(Schema.String),
  started_at: Schema.optional(Schema.String),
  start_log: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.Literals(["done", "failed", "start-failed"])),
  closed_at: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});

type TaskFields = typeof TaskFields.Type;

type TaskFolder = "new" | "taken" | "closed";

const backlogVariable = "ORC_HOME";

const backlogRoot: Config.Config<string> = Config.all({
  explicit: selector(backlogVariable),
  home: Config.String("HOME"),
}).pipe(Config.map(({ explicit, home }) => (explicit ?? home + "/.orc") + "/backlog"));


const feed = String.fromCharCode(10);
const fence = "---";

const splitFrontmatter = (text: string): string | undefined => {
  if (!text.startsWith(fence + feed)) return undefined;
  const end = text.indexOf(feed + fence + feed, fence.length);
  return end === -1 ? undefined : text.slice(fence.length + 1, end);
};

const taskFields = (file: string, text: string): TaskFields | string => {
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
  return front.outcome === undefined || started === null ? null : { outcome: front.outcome, started, reason };
};

const stateOf = (folder: TaskFolder, file: string, front: TaskFields): DispatchTaskState | string => {
  if (folder === "new") return { kind: "new" };
  const claim = claimOf(front);
  const started = startedOf(front);
  if (folder === "taken") {
    if (started === null) return { kind: "taken", claim };
    return claim === null ? file + ": a started task names no claim" : { kind: "started", claim, started };
  }
  const closing = closingOf(front, started);
  if (claim === null || closing === null || front.closed_at === undefined) {
    return file + ": a closed task names no claim, outcome or close time";
  }
  return { kind: "closed", claim, closing, closedAt: front.closed_at };
};

const taskOf = (folder: TaskFolder, file: string, stem: string, text: string): DispatchTask | string => {
  const front = taskFields(file, text);
  if (typeof front === "string") return front;
  if (front.id !== stem) return file + ": its id " + front.id + " is not its file name";
  const state = stateOf(folder, file, front);
  if (typeof state === "string") return state;
  return {
    id: front.id,
    title: front.title,
    project: front.project,
    machine: front.machine,
    dependsOn: front.depends_on,
    created: front.created,
    state,
  };
};

const byName = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const readText = (
  fs: FileSystem.FileSystem,
  file: string,
): Effect.Effect<string | null | void> =>
  fs.readFileString(file).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
    Effect.catchTag("PlatformError", () => Effect.void),
  );

const readJsonFile = (fs: FileSystem.FileSystem, file: string): Effect.Effect<Outcome<unknown>> =>
  Effect.gen(function* () {
    const text = yield* readText(fs, file);
    if (text === null || text === undefined) return unreachable(file + " cannot be read");
    return decodeJson(Schema.Unknown)(text);
  });

const stemOf = (name: string): string | null => {
  const stemmed = /^task-(\d+)\.md$/u.exec(name);
  return stemmed === null ? null : "task-" + stemmed[1];
};

const takeTask = (
  folder: TaskFolder,
  file: string,
  stem: string,
  text: string,
  tasks: Array<DispatchTask>,
  unread: Array<string>,
): void => {
  const task = taskOf(folder, file, stem, text);
  if (typeof task === "string") unread.push(task);
  else tasks.push(task);
};

const readTaskFile = (
  fs: FileSystem.FileSystem,
  folder: TaskFolder,
  root: string,
  name: string,
  tasks: Array<DispatchTask>,
  unread: Array<string>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const stem = stemOf(name);
    if (stem === null) return;
    const file = root + "/" + folder + "/" + name;
    const text = yield* readText(fs, file);
    if (text === null) return;
    if (text === undefined) {
      unread.push(file + ": the task file cannot be read");
      return;
    }
    takeTask(folder, file, stem, text, tasks, unread);
  });

const readFolder = (
  fs: FileSystem.FileSystem,
  root: string,
  folder: TaskFolder,
  tasks: Array<DispatchTask>,
  unread: Array<string>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const listed = yield* fs.readDirectory(root + "/" + folder).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed<ReadonlyArray<string> | null>([])),
      Effect.catchTag("PlatformError", () => Effect.succeed<ReadonlyArray<string> | null>(null)),
    );
    if (listed === null) {
      unread.push(root + "/" + folder + ": cannot be listed");
      return;
    }
    for (const name of listed.toSorted(byName)) {
      yield* readTaskFile(fs, folder, root, name, tasks, unread);
    }
  });

const orderedTasks = (tasks: ReadonlyArray<DispatchTask>): ReadonlyArray<DispatchTask> => {
  const seen = new Map<string, DispatchTask>();
  for (const task of tasks) seen.set(task.id, task);
  const numbered = (id: string): number => Number(id.slice(5));
  return [...seen.values()].toSorted((left, right) => numbered(left.id) - numbered(right.id));
};

const readTasks = (
  fs: FileSystem.FileSystem,
  root: string,
): Effect.Effect<{ readonly tasks: ReadonlyArray<DispatchTask>; readonly unread: ReadonlyArray<string> }> =>
  Effect.gen(function* () {
    const tasks: Array<DispatchTask> = [];
    const unread: Array<string> = [];
    const folders: ReadonlyArray<TaskFolder> = ["new", "taken", "closed"];
    for (const folder of folders) {
      yield* readFolder(fs, root, folder, tasks, unread);
    }
    return { tasks: orderedTasks(tasks), unread };
  });

const readSnapshot = (fs: FileSystem.FileSystem, root: string): Effect.Effect<DispatchSnapshot> =>
  Effect.gen(function* () {
    const present = yield* fs.exists(root).pipe(Effect.catchTag("PlatformError", () => Effect.succeed<boolean | null>(null)));
    if (present === null) {
      const reason = root + ": cannot be read";
      return {
        root,
        missing: false,
        machines: unreachable(reason),
        projects: unreachable(reason),
        tasks: [],
        unread: [reason],
      };
    }
    if (!present) {
      return {
        root,
        missing: true,
        machines: unreachable("no backlog at " + root),
        projects: unreachable("no backlog at " + root),
        tasks: [],
        unread: [],
      };
    }
    const machinesRead = yield* readJsonFile(fs, root + "/dispatch.json");
    const projectsRead = yield* readJsonFile(fs, root + "/projects.json");
    const { tasks, unread } = yield* readTasks(fs, root);
    const decodedMachines: Outcome<typeof MachinesFile.Type> =
      machinesRead.kind === "ok" ? decodeValue(MachinesFile)(machinesRead.value) : machinesRead;
    const machinesFile = root + "/dispatch.json";
    const machines: Outcome<ReadonlyArray<DispatchMachine>> = (() => {
      if (decodedMachines.kind !== "ok") return decodedMachines;
      const machine = duplicateOf(decodedMachines.value.machines.map((entry) => entry.name));
      if (machine !== null) return unreachable(machinesFile + ": the machine " + machine + " is named twice");
      const account = duplicateOf(decodedMachines.value.quota.accounts.map((entry) => entry.name));
      if (account !== null) return unreachable(machinesFile + ": the account " + account + " is named twice");
      const commandAccount = decodedMachines.value.quota.accounts.find((entry) => "tokenCommand" in entry);
      const unrenewed = decodedMachines.value.machines.find((entry) => entry.renew === undefined);
      if (commandAccount !== undefined && unrenewed !== undefined) {
        return unreachable(
          machinesFile + ": the machine " + unrenewed.name + " has no renew command, which the account " + commandAccount.name + " needs to carry its token past its expiry"
        );
      }
      const lone = decodedMachines.value.quota.accounts.find((entry) => "kind" in entry && entry.kind === "none");
      const renewed = decodedMachines.value.machines.find((entry) => entry.renew !== undefined);
      if (lone !== undefined && renewed !== undefined) {
        return unreachable(
          machinesFile + ": the account " + lone.name + " takes kind none and holds no token, so the machine " + renewed.name + " names a renew command it never takes"
        );
      }
      return ok(decodedMachines.value.machines);
    })();
    const decodedProjects: Outcome<ReadonlyArray<DispatchProject>> =
      projectsRead.kind === "ok"
        ? mapOutcome(decodeValue(ProjectsFile)(projectsRead.value), (file) =>
          file.projects.map((project) => ({ name: project.name, checkouts: { ...project.checkouts } })),
        )
        : projectsRead;
    const projectsFile = root + "/projects.json";
    const projects: Outcome<ReadonlyArray<DispatchProject>> = (() => {
      if (decodedProjects.kind !== "ok") return decodedProjects;
      const duplicate = duplicateOf(decodedProjects.value.map((project) => project.name));
      if (duplicate !== null) return unreachable(projectsFile + ": the project " + duplicate + " is named twice");
      if (machines.kind === "ok") {
        const known = new Set(machines.value.map((machine) => machine.name));
        for (const project of decodedProjects.value) {
          const unknown = Object.keys(project.checkouts).find((machine) => !known.has(machine));
          if (unknown !== undefined) return unreachable(projectsFile + ": the project " + project.name + " names the unknown machine " + unknown);
        }
      }
      return decodedProjects;
    })();
    const diagnostic = (file: string, outcome: Outcome<unknown>): string | undefined => {
      if (outcome.kind === "ok") return undefined;
      return outcome.kind === "unreachable" ? outcome.reason : file + ": " + outcome.issue;
    };
    const failed = [diagnostic(machinesFile, machines), diagnostic(projectsFile, projects)].filter((reason) => reason !== undefined);
    return { root, missing: false, machines, projects, tasks, unread: [...unread, ...failed] };
  });

export interface DispatchReader {
  readonly root: string;
  readonly read: Effect.Effect<DispatchReading>;
}

export class DispatchSource extends Context.Service<DispatchSource, DispatchReader>()("tui-dash/DispatchSource") {}

export const dispatchSourceLayer: Layer.Layer<DispatchSource, Config.ConfigError, FileSystem.FileSystem> = Layer.effect(
  DispatchSource,
  Effect.gen(function* () {
    const root = yield* backlogRoot;
    const fs = yield* FileSystem.FileSystem;
    return {
      root,
      read: Effect.gen(function* () {
        const snapshot = yield* readSnapshot(fs, root);
        const capturedAt = yield* DateTime.now;
        return { snapshot, capturedAt };
      }),
    };
  }),
);
