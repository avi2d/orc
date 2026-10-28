import { DateTime } from "effect";
import type { TaskEntry } from "../contract/tasks";
import type { CountedProcess, ProcessSamples } from "../sources/task-processes";

export interface MachineSize {
  readonly totalBytes: number;
}

export interface TaskLimits {
  readonly memory: boolean;
}

export interface TaskResources {
  readonly id: string;
  readonly processes: number;
  readonly cpuSeconds: number;
  readonly cpuCores: number;
  readonly residentBytes: number;
  readonly over: TaskLimits;
}

export type TaskFolders = Pick<TaskEntry, "id" | "folders" | "firstStartedAt" | "endedAt">;

export const overLimits = ({ residentBytes }: Pick<TaskResources, "residentBytes">, { totalBytes }: MachineSize): TaskLimits => ({
  memory: residentBytes > totalBytes / 4,
});

const asFolder = (path: string): string => path.replace(/\/+$/, "") + "/";

export const within = (folder: string, outer: string): boolean => asFolder(folder).startsWith(asFolder(outer));

const isRunning = (task: TaskFolders): boolean => task.endedAt === null;

// Start times are known only to the listing's precision, so a task still running outranks one that has ended.
const outranks = (task: TaskFolders, owner: TaskFolders): boolean =>
  isRunning(task) === isRunning(owner)
    ? DateTime.toEpochMillis(task.firstStartedAt) > DateTime.toEpochMillis(owner.firstStartedAt)
    : isRunning(task);

export interface FolderWork {
  readonly folder: string | undefined;
  readonly startedAtMillis: number;
}

// A pool folder serves one task after another, so of the tasks still running when the work started, the latest to start owns it.
export const taskOwning = <T extends TaskFolders>(tasks: ReadonlyArray<T>, work: FolderWork, startPrecisionMillis: number): T | undefined => {
  const { folder } = work;
  if (folder === undefined) return undefined;
  let owner: T | undefined;
  for (const task of tasks) {
    const startMillis = DateTime.toEpochMillis(task.firstStartedAt);
    if (work.startedAtMillis + startPrecisionMillis <= startMillis) continue;
    if (task.endedAt !== null && DateTime.toEpochMillis(task.endedAt) <= work.startedAtMillis) continue;
    if (!task.folders.some((taskFolder) => within(folder, taskFolder))) continue;
    if (owner === undefined || outranks(task, owner)) owner = task;
  }
  return owner;
};

export const totalSecondsOf = ({ ownSeconds, waitedChildSeconds }: Pick<CountedProcess, "ownSeconds" | "waitedChildSeconds">): number =>
  ownSeconds + waitedChildSeconds;

const survivorOf = (
  process: CountedProcess,
  earlierByPid: ReadonlyMap<number, CountedProcess>,
  later: ReadonlySet<string>,
): string | undefined => {
  const seen = new Set<number>();
  let current = earlierByPid.get(process.parent);
  while (current !== undefined && !seen.has(current.pid)) {
    if (later.has(current.identity)) return current.identity;
    seen.add(current.pid);
    current = earlierByPid.get(current.parent);
  }
  return undefined;
};

export interface OwnedProcess {
  readonly task: string;
  readonly folder: string;
  readonly pid: number;
  readonly identity: string;
  readonly parent: string | undefined;
  readonly ownSeconds: number;
  readonly waitedChildSeconds: number;
  readonly cpuCores: number;
  readonly residentBytes: number;
}

// A child reaped between the samples moves its whole time into its waiting parent's waited-child time, so its first sample comes off that.
export const ownedProcesses = (
  tasks: ReadonlyArray<TaskFolders>,
  { intervalSeconds, startPrecisionMillis, before, after }: ProcessSamples,
): ReadonlyArray<OwnedProcess> => {
  const later = new Set(after.map((process) => process.identity));
  const earlierByIdentity = new Map(before.map((process) => [process.identity, process]));
  const earlierByPid = new Map(before.map((process) => [process.pid, process]));
  const laterByPid = new Map(after.map((process) => [process.pid, process]));
  const vanishedSeconds = new Map<string, number>();
  for (const process of before) {
    if (later.has(process.identity)) continue;
    const survivor = survivorOf(process, earlierByPid, later);
    if (survivor !== undefined) vanishedSeconds.set(survivor, (vanishedSeconds.get(survivor) ?? 0) + totalSecondsOf(process));
  }
  const secondsBetween = (process: CountedProcess): number => {
    const earlier = earlierByIdentity.get(process.identity);
    if (earlier === undefined) return totalSecondsOf(process);
    // A parent that ignores SIGCHLD reaps a child without taking its time, so its waited-child time can grow by less than its vanished children held.
    const reaped = process.waitedChildSeconds - earlier.waitedChildSeconds - (vanishedSeconds.get(process.identity) ?? 0);
    return process.ownSeconds - earlier.ownSeconds + Math.max(0, reaped);
  };
  const folderOf = (process: CountedProcess & { readonly folder: string | undefined }): string | undefined => {
    if (process.folder !== undefined) return process.folder;
    const seen = new Set<number>([process.pid]);
    let current = laterByPid.get(process.parent);
    while (current !== undefined && !seen.has(current.pid)) {
      if (current.folder !== undefined) return current.folder;
      seen.add(current.pid);
      current = laterByPid.get(current.parent);
    }
    return undefined;
  };
  return after.flatMap((process) => {
    const folder = folderOf(process);
    const owner = taskOwning(tasks, { folder, startedAtMillis: process.startedAtMillis }, startPrecisionMillis);
    if (owner === undefined || folder === undefined) return [];
    return [
      {
        task: owner.id,
        folder,
        pid: process.pid,
        identity: process.identity,
        parent: laterByPid.get(process.parent)?.identity,
        ownSeconds: process.ownSeconds,
        waitedChildSeconds: process.waitedChildSeconds,
        cpuCores: secondsBetween(process) / intervalSeconds,
        residentBytes: process.residentBytes,
      },
    ];
  });
};

export const taskResources = (
  tasks: ReadonlyArray<TaskFolders>,
  samples: ProcessSamples,
  machine: MachineSize,
): ReadonlyArray<TaskResources> => {
  const byTask = Map.groupBy(ownedProcesses(tasks, samples), (process) => process.task);
  return tasks.flatMap(({ id }) => {
    const owned = byTask.get(id);
    if (owned === undefined) return [];
    const sum = (valueOf: (process: OwnedProcess) => number): number => owned.reduce((total, process) => total + valueOf(process), 0);
    const residentBytes = sum((process) => process.residentBytes);
    return [
      {
        id,
        processes: owned.length,
        cpuSeconds: sum(totalSecondsOf),
        cpuCores: sum((process) => process.cpuCores),
        residentBytes,
        over: overLimits({ residentBytes }, machine),
      },
    ];
  });
};
