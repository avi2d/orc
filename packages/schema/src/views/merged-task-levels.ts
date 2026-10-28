import { DateTime } from "effect";
import { historyDays } from "../sources/task-samples";
import { byProject } from "./project-order";
import { projectOf, taskLevels, type TaskLevels } from "./task-levels";

// One board across machines keeps one row per project, so a project on both machines reads as one row with both machines' tasks.
export const mergedTaskLevels = (levels: readonly [TaskLevels, ...TaskLevels[]]): TaskLevels => {
  const [first] = levels;
  const all = levels.flatMap((level) => level.projects);
  const tasks = all.flatMap((project) => project.tasks);
  const planned = all.flatMap((project) => project.planned);
  const names = new Set([...tasks.map((task) => task.project), ...planned.map((row) => row.project), ...levels.flatMap((level) => level.registered)]);
  return {
    machine: first.machine,
    machines: [...new Set(levels.flatMap((level) => level.machines))],
    interval: first.interval,
    source: "local",
    days: Math.max(...levels.map((level) => level.days)),
    registered: [...new Set(levels.flatMap((level) => level.registered))],
    now: first.now,
    pending: levels.every((level) => level.pending),
    unset: levels.every((level) => level.unset),
    listed: levels.some((level) => level.listed),
    usageRead: levels.every((level) => level.usageRead),
    liveConfigured: levels.every((level) => level.liveConfigured),
    failures: levels.flatMap((level) => level.failures),
    projects: [...names].map((name) => projectOf(name, tasks.filter((task) => task.project === name), planned.filter((row) => row.project === name))).toSorted(byProject),
    runOwners: new Map(levels.flatMap((level) => [...level.runOwners])),
  };
};

// A machine with no tasks command reads as unset rather than borrowing another machine's levels.
export const unsetTaskLevels = (machine: string, now: DateTime.Utc, zone: DateTime.TimeZone): TaskLevels =>
  taskLevels({
    machine,
    origin: "remote",
    zone,
    tasks: { kind: "unset" },
    samples: [],
    live: undefined,
    liveConfigured: false,
    pueue: undefined,
    noMistakes: undefined,
    orc: undefined,
    sessions: undefined,
    now,
    days: historyDays,
  });
