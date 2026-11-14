import { Config, Context, DateTime, Effect, FileSystem, Layer, Schema } from "effect";
import { CommandRunner } from "../../../shared/lib";
import { decodeJson, decodeValue } from "../../../shared/lib";
import { mapOutcome, ok, type Outcome, unreachable } from "../../../shared/lib";
import { duplicateOf, MachinesFile, ProjectsFile, rawAccounts, strictAccount } from "./dispatch-schema";
import { backlogRoot, missingBacklog, readBeatWaits, stateOf, taskFields, type DispatchMachine, type DispatchProject, type DispatchReading, type DispatchSnapshot, type DispatchTask, type TaskFolder } from "./dispatch";
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
  const stemmed = /^([A-Za-z0-9][A-Za-z0-9._-]*-\d+)\.md$/u.exec(name);
  return stemmed?.[1] ?? null;
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
  return [...seen.values()].toSorted(
    (left, right) => left.created.localeCompare(right.created) || left.id.localeCompare(right.id, "en", { numeric: true }),
  );
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

const readSnapshot = (fs: FileSystem.FileSystem, root: string): Effect.Effect<DispatchSnapshot, never, CommandRunner> =>
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
        waits: unreachable(reason),
        unread: [reason],
      };
    }
    if (!present) {
      return {
        root,
        missing: true,
        machines: unreachable(missingBacklog(root)),
        projects: unreachable(missingBacklog(root)),
        tasks: [],
        waits: unreachable(missingBacklog(root)),
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
      const raw = machinesRead.kind === "ok" ? machinesRead.value : undefined;
      const strict = rawAccounts(raw)
        .map((entry) => strictAccount(entry))
        .find((issue) => issue !== undefined);
      if (strict !== undefined) return unreachable(machinesFile + ": " + strict);
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
      const single = decodedMachines.value.quota.accounts.find((entry) => "kind" in entry && entry.kind === "none");
      if (single !== undefined && decodedMachines.value.quota.accounts.length > 1) {
        return unreachable(
          machinesFile + ": the account " + single.name + " takes kind none and names no login, so the quota names no other account beside it"
        );
      }
      const renewed = decodedMachines.value.machines.find((entry) => entry.renew !== undefined);
      if (single !== undefined && renewed !== undefined) {
        return unreachable(
          machinesFile + ": the account " + single.name + " takes kind none and holds no token, so the machine " + renewed.name + " names a renew command it never takes"
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
    const waits = yield* readBeatWaits;
    return { root, missing: false, machines, projects, tasks, waits, unread: [...unread, ...failed] };
  });

export interface DispatchReader {
  readonly root: string;
  readonly read: Effect.Effect<DispatchReading>;
}

export class DispatchSource extends Context.Service<DispatchSource, DispatchReader>()("orc-dash/DispatchSource") {}

export const dispatchSourceLayer: Layer.Layer<DispatchSource, Config.ConfigError, FileSystem.FileSystem | CommandRunner> = Layer.effect(
  DispatchSource,
  Effect.gen(function* () {
    const root = yield* backlogRoot;
    const fs = yield* FileSystem.FileSystem;
    const runner = yield* CommandRunner;
    return {
      root,
      read: Effect.gen(function* () {
        const snapshot = yield* Effect.provideService(readSnapshot(fs, root), CommandRunner, runner);
        const capturedAt = yield* DateTime.now;
        return { snapshot, capturedAt };
      }),
    };
  }),
);
