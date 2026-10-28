import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import {
  decodeLinuxTaskProcesses,
  decodeMacTaskProcesses,
  decodeTasksReport,
  overLimits,
  type ProcessSamples,
  type TaskFolders,
  taskResources,
} from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { issueOf, valueOf } from "../../lib/outcomes";

const gib = 1024 ** 3;

const millisOf = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

const linuxSamples = () => valueOf(decodeLinuxTaskProcesses(fixture("linux/task-processes.txt")));

const macSamples = () => valueOf(decodeMacTaskProcesses(fixture("mac/task-processes.txt")));

const recordedTasks = (): ReadonlyArray<TaskFolders> => valueOf(decodeTasksReport(fixture("tasks/east.json"))).view.tasks;

const onMac = (tasks: ReadonlyArray<TaskFolders>): ReadonlyArray<TaskFolders> =>
  tasks.map((task) => ({ ...task, folders: task.folders.map((folder) => folder.replace("/home/example", "/Users/example")) }));

const eastMemory = { totalBytes: 47 * gib };

const after = (samples: ProcessSamples, pid: number) => samples.after.find((process) => process.pid === pid);

// A clock step moves btime, so a btime-derived start cannot name a process.
describe("decodeLinuxTaskProcesses against the recorded /proc listing, reaped-child time kept and starttime read in clock ticks", () => {
  test("reads the interval between the two uptimes and every process of each sample", () => {
    const samples = linuxSamples();
    expect(samples.intervalSeconds).toBeCloseTo(1, 10);
    expect(samples.before).toHaveLength(13);
    expect(samples.after).toHaveLength(12);
  });

  test("keeps own and waited-for children's ticks apart, dates the start from boot, and joins the cwd link", () => {
    const pi = after(linuxSamples(), 2100);
    expect(pi?.ownSeconds).toBeCloseTo(500.9, 10);
    expect(pi?.waitedChildSeconds).toBeCloseTo(30.2, 10);
    expect(pi).toMatchObject({
      pid: 2100,
      parent: 1,
      startedAtMillis: millisOf("2026-10-18T22:20:00Z"),
      residentBytes: 116989 * 4096,
      folder: "/home/example/work/harbor",
    });
  });

  test("keeps a start time a hundredth of a second before the second", () => {
    expect(after(linuxSamples(), 2701)?.startedAtMillis).toBe(millisOf("2026-10-18T22:14:58.990Z"));
  });

  test("a process is the same process across a clock step, and another after a reboot", () => {
    const recorded = fixture("linux/task-processes.txt");
    const pi = (text: string) => after(valueOf(decodeLinuxTaskProcesses(text)), 2100)?.identity;
    const stepped = recorded.replace("btime 1792281600", "btime 1792281605");
    const rebooted = recorded.replace(/boot \S+/u, "boot 0a1b2c3d-0000-4000-8000-000000000000");
    expect(pi(stepped)).toBe(pi(recorded));
    expect(pi(rebooted)).not.toBe(pi(recorded));
    expect(after(valueOf(decodeLinuxTaskProcesses(stepped)), 2100)?.startedAtMillis).toBe(millisOf("2026-10-18T22:20:05Z"));
  });

  test("a start is known to within the whole second btime drops and one tick", () => {
    expect(linuxSamples().startPrecisionMillis).toBe(1010);
  });

  test("reads a comm holding a space and a folder holding spaces", () => {
    expect(after(linuxSamples(), 2600)?.folder).toBe("/home/example/work/harbor old copy");
  });

  test("an empty cwd, one since deleted, is no folder", () => {
    expect(after(linuxSamples(), 1)?.folder).toBeUndefined();
  });
});

describe("decodeLinuxTaskProcesses against changed or broken listings", () => {
  const recorded = () => fixture("linux/task-processes.txt");

  test("a listing without its tick rate is invalid and names the field", () => {
    expect(issueOf(decodeLinuxTaskProcesses(recorded().replace("ticks 100\n", "")))).toContain('["ticks"]');
  });

  test("a listing without its boot id is invalid and names the field", () => {
    expect(issueOf(decodeLinuxTaskProcesses(recorded().replace(/boot \S+\n/u, "")))).toContain('["boot"]');
  });

  test("a single sample is invalid, since one sample only holds totals since boot", () => {
    const single = recorded().replace(/uptime 115331\.00\n[\s\S]*?(?=cwd )/, "");
    expect(issueOf(decodeLinuxTaskProcesses(single))).toContain('["samples"]');
  });

  test("a second uptime no later than the first is invalid", () => {
    expect(issueOf(decodeLinuxTaskProcesses(recorded().replace("uptime 115331.00", "uptime 115330.00")))).toBe(
      "the second sample is not later than the first",
    );
  });

  test("a /proc/<pid>/stat line after the cwd links is invalid and named by its line", () => {
    const lines = recorded().trimEnd().split("\n");
    const stat = lines[4] ?? "";
    expect(issueOf(decodeLinuxTaskProcesses([...lines, stat].join("\n")))).toBe(
      "line " + String(lines.length + 1) + " does not read as a page size, tick rate, boot time or boot id, an uptime, a /proc/<pid>/stat line or a /proc/<pid>/cwd link",
    );
  });

  test("a sample with no process is invalid, since the sampling shell is always one", () => {
    const empty = recorded().replace(/(uptime 115331\.00\n)[\s\S]*?(?=cwd )/, "$1");
    expect(issueOf(decodeLinuxTaskProcesses(empty))).toContain('["processes"]');
  });

  test("a listing with no cwd is invalid, since the sampling shell's own is always readable", () => {
    const blind = recorded().replace(/cwd [^\n]*\n/g, "");
    expect(issueOf(decodeLinuxTaskProcesses(blind))).toContain('["folders"]');
  });

  test("ps output in place of /proc is invalid, never a process", () => {
    expect(decodeLinuxTaskProcesses("pagesize 4096\nticks 100\nbtime 1\nboot b1\nuptime 1.00\n    1 systemd 0.0 11524\n").kind).toBe(
      "invalid",
    );
  });
});

// Apple's ps ignores -S, so waited-for children's time arrives in per-process rusage lines.
describe("decodeMacTaskProcesses against the recorded ps and lsof listing", () => {
  test("reads the interval between the two zsh stamps and every process of each sample", () => {
    const samples = macSamples();
    expect(samples.intervalSeconds).toBe(1);
    expect(samples.before).toHaveLength(13);
    expect(samples.after).toHaveLength(12);
  });

  test("reads the own and waited-for children's time from rusage, the UTC start, the rss in KiB and the lsof cwd", () => {
    const pi = after(macSamples(), 2100);
    expect(pi?.ownSeconds).toBeCloseTo(500.9, 10);
    expect(pi?.waitedChildSeconds).toBeCloseTo(30.2, 10);
    expect(pi).toMatchObject({
      pid: 2100,
      parent: 1,
      startedAtMillis: millisOf("2026-10-18T22:20:00Z"),
      residentBytes: 467956 * 1024,
      folder: "/Users/example/work/harbor",
    });
  });

  test("reads minutes past 59 as minutes", () => {
    expect(after(macSamples(), 1)?.ownSeconds).toBeCloseTo(126 * 60 + 34.56, 10);
  });

  test("an unread process keeps its ps own time and no waited-for children's time", () => {
    const init = after(macSamples(), 1);
    expect(init?.ownSeconds).toBeCloseTo(126 * 60 + 34.56, 10);
    expect(init?.waitedChildSeconds).toBe(0);
  });

  test("a start is known to within the whole second lstart drops", () => {
    expect(macSamples().startPrecisionMillis).toBe(1000);
  });

  test("a listing with no lsof folder is invalid, since zsh's own is always listed", () => {
    const blind = fixture("mac/task-processes.txt").replace(/p900\n[\s\S]*$/, "");
    expect(issueOf(decodeMacTaskProcesses(blind))).toContain('["folders"]');
  });

  test("a process lsof did not list has no folder", () => {
    expect(after(macSamples(), 1)?.folder).toBeUndefined();
  });

  test("an lstart with no month it knows is invalid and names its process", () => {
    const broken = fixture("mac/task-processes.txt").replace("Sun Oct 18 22:20:00 2026", "Sun Okt 18 22:20:00 2026");
    expect(issueOf(decodeMacTaskProcesses(broken))).toBe("process 2100 has a start time that does not read as a date");
  });

  test("a cpu time ps never prints is invalid", () => {
    expect(decodeMacTaskProcesses(fixture("mac/task-processes.txt").replace("8:15.00", "8m15s")).kind).toBe("invalid");
  });

  test("an hours or days form, which macOS ps never prints for time, is invalid", () => {
    expect(decodeMacTaskProcesses(fixture("mac/task-processes.txt").replace("8:15.00", "1:08:15.00")).kind).toBe("invalid");
    expect(decodeMacTaskProcesses(fixture("mac/task-processes.txt").replace("8:15.00", "1-00:08:15")).kind).toBe("invalid");
  });

  test("a ps row after the lsof fields is invalid, though it reads within a sample", () => {
    const row = " 3000     1    100   0:00.00 0:00.00 Mon Oct 19 08:00:00 2026\n";
    const recorded = fixture("mac/task-processes.txt");
    expect(after(valueOf(decodeMacTaskProcesses(recorded.replace("p900\n", row + "unread 3000\np900\n"))), 3000)?.pid).toBe(3000);
    expect(issueOf(decodeMacTaskProcesses(recorded + row))).toContain(
      "does not read as a sample time, a ps row, a rusage line, an unread pid or an lsof field",
    );
  });

  test("a ps row with neither a rusage nor an unread line is left out of its sample", () => {
    const recorded = fixture("mac/task-processes.txt");
    expect(after(valueOf(decodeMacTaskProcesses(recorded.replace("rusage 2900 0.030000 0.000000\n", ""))), 2900)).toBeUndefined();
    const earlier = valueOf(decodeMacTaskProcesses(recorded.replace("rusage 2900 50.000000 0.000000\n", ""))).before;
    expect(earlier.find(({ pid }) => pid === 2900)).toBeUndefined();
  });
});

describe("taskResources over the recorded tasks, joined by pid and folder, not prefix, and no reaped child's whole life counted", () => {
  const bridge = {
    id: "tasks-bridge-plot",
    processes: 5,
    residentBytes: 610258944,
    over: { memory: false },
  };
  const inbox = { id: "tasks-inbox-sweep", processes: 1, residentBytes: 204800000, over: { memory: false } };
  const notes = { id: "tasks-release-notes", processes: 1, residentBytes: 8192000, over: { memory: false } };

  const platforms = [
    { platform: "linux", samples: linuxSamples, tasks: recordedTasks, piSeconds: 531.1, bridgeCores: 1.78 },
    { platform: "mac", samples: macSamples, tasks: () => onMac(recordedTasks()), piSeconds: 531.1, bridgeCores: 1.78 },
  ] as const;

  for (const { platform, samples, tasks, piSeconds, bridgeCores } of platforms) {
    test("gives each task its processes, cpu so far, cpu now and memory on " + platform, () => {
      const used = taskResources(tasks(), samples(), eastMemory);
      expect(used.map(({ cpuSeconds, cpuCores, ...rest }) => rest)).toEqual([bridge, inbox, notes]);
      const use = (id: string) => used.find((task) => task.id === id);
      const [bridgeUse, inboxUse, notesUse] = [use(bridge.id), use(inbox.id), use(notes.id)];
      expect(bridgeUse?.cpuSeconds).toBeCloseTo(piSeconds + 70.5 + 0.15 + 0.01 + 0.03, 9);
      expect(bridgeUse?.cpuCores).toBeCloseTo(bridgeCores, 9);
      expect(inboxUse?.cpuSeconds).toBeCloseTo(15.5, 9);
      expect(inboxUse?.cpuCores).toBeCloseTo(3.5, 9);
      expect(notesUse?.cpuCores).toBe(0);
    });
  }

  test("a process that started before the task's first start by the listing's precision is no part of it", () => {
    const owned = (pid: number) =>
      taskResources(recordedTasks(), { ...linuxSamples(), after: linuxSamples().after.filter((process) => process.pid === pid) }, eastMemory);
    expect(owned(2700).map(({ id }) => id)).toEqual(["tasks-bridge-plot"]);
    expect(owned(2701)).toEqual([]);
  });

  test("a process in a folder two tasks share goes to the one that started later", () => {
    const owners = taskResources(recordedTasks(), { ...linuxSamples(), after: linuxSamples().after.filter((process) => process.pid === 2200) }, eastMemory);
    expect(owners.map(({ id }) => id)).toEqual(["tasks-inbox-sweep"]);
  });

  test("a task folder ending in a slash, or the root folder, holds the folders beneath it", () => {
    const folders = (folder: string) => [
      { id: "folder", folders: [folder], firstStartedAt: DateTime.makeUnsafe("2026-10-18T00:00:00Z"), endedAt: null },
    ];
    expect(taskResources(folders("/home/example/work/harbor/"), linuxSamples(), eastMemory)[0]?.processes).toBe(5);
    expect(taskResources(folders("/home/example/work/harbor"), linuxSamples(), eastMemory)[0]?.processes).toBe(5);
    expect(taskResources(folders("/"), linuxSamples(), eastMemory)[0]?.processes).toBe(11);
  });

  test("a task with no live process is left out", () => {
    const later = {
      id: "later",
      folders: ["/home/example/work/harbor"],
      firstStartedAt: DateTime.makeUnsafe("2030-01-01T00:00:00Z"),
      endedAt: null,
    };
    expect(taskResources([later], linuxSamples(), eastMemory)).toEqual([]);
  });
});

// Starts truncate to whole seconds and ticks, so ownership cannot compare exact instants.
describe("taskResources with a task that starts within the listing's precision, ownership compared within that precision, not as an exact instant", () => {
  const notesFrom = (iso: string, home: string): ReadonlyArray<TaskFolders> => [
    { id: "notes", folders: [home + "/work/notes"], firstStartedAt: DateTime.makeUnsafe(iso), endedAt: null },
  ];

  test("on the Mac a process whose lstart is the task's start second is the task's", () => {
    expect(taskResources(notesFrom("2026-10-18T10:00:00.500Z", "/Users/example"), macSamples(), eastMemory)).toHaveLength(1);
    expect(taskResources(notesFrom("2026-10-18T10:00:01.000Z", "/Users/example"), macSamples(), eastMemory)).toEqual([]);
  });

  test("on Linux a process dated within a second and a tick before the task's start is the task's", () => {
    expect(taskResources(notesFrom("2026-10-18T10:00:01.009Z", "/home/example"), linuxSamples(), eastMemory)).toHaveLength(1);
    expect(taskResources(notesFrom("2026-10-18T10:00:01.010Z", "/home/example"), linuxSamples(), eastMemory)).toEqual([]);
  });
});

const statLine = (pid: number, ppid: number, ownTicks: number, childTicks: number, startTicks = 3600000) =>
  String(pid) + " (task) S " + String(ppid) + " 1 1 0 -1 0 0 0 0 0 " + String(ownTicks) + " 0 " + String(childTicks) + " 0 20 0 1 0 " + String(startTicks) + " 0 0 0";

const listing = (earlier: ReadonlyArray<string>, later: ReadonlyArray<string>) =>
  ["pagesize 4096", "ticks 100", "btime 1792281600", "boot b1", "uptime 1.00", ...earlier, "uptime 2.00", ...later, "cwd /proc/10 /home/example/work/notes"].join("\n");

const notesCores = (text: string) => {
  const notes = recordedTasks().filter(({ id }) => id === "tasks-release-notes");
  return taskResources(notes, valueOf(decodeLinuxTaskProcesses(text)), eastMemory)[0]?.cpuCores;
};

describe("taskResources over a pool folder another task used between a task's launches, never handed to a task that ended before they started", () => {
  const pool = "/home/example/work/notes";
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const relaunched = { id: "A", folders: [pool], firstStartedAt: at("2026-10-18T10:00:00Z"), endedAt: null };
  const between = { id: "B", folders: [pool], firstStartedAt: at("2026-10-18T11:00:00Z"), endedAt: at("2026-10-18T11:30:00Z") };
  const ownerAt = (startTicks: number) => {
    const process = statLine(10, 1, 0, 0, startTicks);
    return taskResources([relaunched, between], valueOf(decodeLinuxTaskProcesses(listing([process], [process]))), eastMemory).map(({ id }) => id);
  };

  test("a process started at 12:05, after B ended, is the relaunched A's", () => {
    expect(ownerAt(4350000)).toEqual(["A"]);
  });

  test("a process B left from 11:10, while it ran, goes to A, which still runs", () => {
    expect(ownerAt(4020000)).toEqual(["A"]);
  });
});

type MacListingRow =
  | readonly [number, number, string, string]
  | readonly [number, number, string, string, readonly [number, number] | "unread"];

const macListing = (folder: string, earlier: ReadonlyArray<MacListingRow>, later: typeof earlier) => {
  const sample = (at: string, rows: typeof earlier) => [
    "at " + at,
    ...rows.map(([pid, ppid, own, lstart]) => String(pid) + " " + String(ppid) + " 1024 " + own + " 0:00.00 " + lstart),
    ...rows.flatMap(([pid, , , , usage]) => {
      if (usage === undefined) return [];
      if (usage === "unread") return ["unread " + String(pid)];
      return ["rusage " + String(pid) + " " + String(usage[0]) + " " + String(usage[1])];
    }),
  ];
  return [...sample("100.0", earlier), ...sample("101.0", later), "p10", "fcwd", "n" + folder].join("\n");
};

describe("taskResources over a relaunch within a second of the folder's last task ending", () => {
  test("the process goes to A, which still runs", () => {
    const pool = "/Users/example/work/notes";
    const at = (iso: string) => DateTime.makeUnsafe(iso);
    const tasks = [
      { id: "A", folders: [pool], firstStartedAt: at("2026-10-18T10:00:00Z"), endedAt: null },
      { id: "B", folders: [pool], firstStartedAt: at("2026-10-18T11:00:00Z"), endedAt: at("2026-10-18T12:00:00.500Z") },
    ];
    const row = [10, 1, "0:00.00", "Sun Oct 18 12:00:00 2026", [0, 0]] as const;
    expect(taskResources(tasks, valueOf(decodeMacTaskProcesses(macListing(pool, [row], [row]))), eastMemory).map(({ id }) => id)).toEqual(["A"]);
  });
});

describe("taskResources over a child reaped between the samples, its time counted once, neither twice nor off its parent", () => {
  const used = (samples: ProcessSamples, pool: string) => {
    const tasks = [{ id: "notes", folders: [pool], firstStartedAt: DateTime.makeUnsafe("2026-10-18T09:00:00Z"), endedAt: null }];
    return taskResources(tasks, samples, eastMemory).find(({ id }) => id === "notes");
  };

  test("on Linux counts the child's time once in the parent, and no cores", () => {
    const text = listing([statLine(10, 1, 1000, 0), statLine(11, 10, 10000, 0)], [statLine(10, 1, 1000, 10000)]);
    const notes = used(valueOf(decodeLinuxTaskProcesses(text)), "/home/example/work/notes");
    expect(notes?.cpuSeconds).toBeCloseTo(110, 9);
    expect(notes?.cpuCores).toBeCloseTo(0, 9);
  });

  test("on the Mac counts the reaped child's time in the parent, and no cores", () => {
    const pool = "/Users/example/work/notes";
    const lstart = "Sun Oct 18 12:00:00 2026";
    const parent = [10, 1, "0:10.00", lstart, [10, 0]] as const;
    const child = [11, 10, "1:40.00", lstart, [100, 0]] as const;
    const reaped = [10, 1, "0:10.00", lstart, [10, 100]] as const;
    const notes = used(valueOf(decodeMacTaskProcesses(macListing(pool, [parent, child], [reaped]))), pool);
    expect(notes?.cpuSeconds).toBeCloseTo(110, 9);
    expect(notes?.cpuCores).toBeCloseTo(0, 9);
  });

  test("on the Mac with unread processes counts the parent's own time alone, and no cores", () => {
    const pool = "/Users/example/work/notes";
    const lstart = "Sun Oct 18 12:00:00 2026";
    const parent = [10, 1, "0:10.00", lstart, "unread"] as const;
    const child = [11, 10, "1:40.00", lstart, "unread"] as const;
    const notes = used(valueOf(decodeMacTaskProcesses(macListing(pool, [parent, child], [parent]))), pool);
    expect(notes?.cpuSeconds).toBeCloseTo(10, 9);
    expect(notes?.cpuCores).toBeCloseTo(0, 9);
  });
});

describe("taskResources over a mac child reaped while the reader reads, counted once with its half second kept", () => {
  const pool = "/Users/example/work/notes";
  const lstart = "Sun Oct 18 12:00:00 2026";
  const parent = (child: number) => [10, 1, "0:10.00", lstart, [10, child]] as const;
  const child = (pid: number, own: number, waited: number) => [pid, 10, "0:00.00", lstart, [own, waited]] as const;
  const gone = (pid: number, own: string) => [pid, 10, own, lstart] as const;
  const cores = (earlier: ReadonlyArray<MacListingRow>, later: ReadonlyArray<MacListingRow>) => {
    const tasks = [{ id: "notes", folders: [pool], firstStartedAt: DateTime.makeUnsafe("2026-10-18T09:00:00Z"), endedAt: null }];
    return taskResources(tasks, valueOf(decodeMacTaskProcesses(macListing(pool, earlier, later))), eastMemory)[0]?.cpuCores;
  };

  test("reaped in the first sample, the half second", () => {
    expect(cores([parent(100), gone(11, "1:40.00")], [parent(100.5)])).toBeCloseTo(0.5, 9);
  });

  test("reaped in the second sample, the half second", () => {
    expect(cores([parent(0), child(11, 100, 0)], [parent(100.5), gone(11, "1:40.00")])).toBeCloseTo(0.5, 9);
  });

  test("a child that had waited 50 s for its own children, reaped in the first sample, no cores", () => {
    expect(cores([parent(150), gone(11, "1:40.00")], [parent(150)])).toBeCloseTo(0, 9);
  });

  test("a 100 s child and a 0.3 s child both reaped in the second sample, no cores", () => {
    expect(cores([parent(0), child(11, 100, 0), child(9, 0.3, 0)], [parent(100.3), gone(11, "1:40.00"), gone(9, "0:00.30")])).toBeCloseTo(0, 9);
  });
});

describe("taskResources over a mac process lsof missed after the second sample, still owned by its folder and not 0 cores", () => {
  const pool = "/private/tmp/nm-e2e.UiFAd3/race2";
  const idle = "Sun Oct 18 10:00:00 2026";
  const busy = "Sun Oct 18 12:00:00 2026";
  const row = (pid: number, ppid: number, own: string, lstart: string) => `${pid} ${ppid} 1024 ${own} 0:00.00 ${lstart}`;
  const race = (lsof: ReadonlyArray<string>) =>
    [
      "at 100.0",
      row(5489, 1, "0:01.00", idle),
      row(5494, 5489, "0:01.00", idle),
      row(92617, 5494, "0:01.00", busy),
      "rusage 5489 1 0",
      "rusage 5494 1 0",
      "rusage 92617 1 0",
      "at 101.0",
      row(5489, 1, "0:01.00", idle),
      row(5494, 5489, "0:01.00", idle),
      row(92617, 5494, "0:02.64", busy),
      row(95226, 92617, "0:00.38", busy),
      "rusage 5489 1 0",
      "rusage 5494 1 0",
      "rusage 92617 2.64 0",
      "rusage 95226 0.386 0",
      ...lsof,
    ].join("\n");
  const raceTasks = () => [
    { id: "race2", folders: [pool], firstStartedAt: DateTime.makeUnsafe("2026-10-18T09:00:00Z"), endedAt: null },
  ];
  const raceCores = (text: string) => taskResources(raceTasks(), valueOf(decodeMacTaskProcesses(text)), eastMemory)[0]?.cpuCores;

  test("a process with no cwd entry counts under its nearest sampled ancestor's folder", () => {
    expect(raceCores(race(["p5489", "fcwd", "n" + pool, "p5494", "fcwd", "n" + pool]))).toBeCloseTo(2.026, 9);
  });

  test("a process with no cwd entry and no attributed ancestor owns no task", () => {
    expect(taskResources(raceTasks(), valueOf(decodeMacTaskProcesses(race(["p1", "fcwd", "n/var/empty"]))), eastMemory)).toEqual([]);
  });
});

describe("taskResources over a process that works and waits between the samples, its waited child counted, not 0.5 cores", () => {
  test("counts the own half second and the waited-for fifth of a second", () => {
    expect(notesCores(listing([statLine(10, 1, 1000, 0)], [statLine(10, 1, 1050, 20)]))).toBeCloseTo(0.7, 9);
  });
});

describe("taskResources over a mac process that works and waits between the samples, its reaped child counted, not 0.5 cores", () => {
  test("counts the own half second and the reaped fifth of a second", () => {
    const pool = "/Users/example/work/notes";
    const lstart = "Sun Oct 18 12:00:00 2026";
    const tasks = [
      { id: "notes", folders: [pool], firstStartedAt: DateTime.makeUnsafe("2026-10-18T09:00:00Z"), endedAt: null },
    ];
    const text = macListing(
      pool,
      [[10, 1, "0:10.00", lstart, [10, 0]] as const],
      [[10, 1, "0:10.50", lstart, [10.5, 0.2]] as const],
    );
    expect(taskResources(tasks, valueOf(decodeMacTaskProcesses(text)), eastMemory)[0]?.cpuCores).toBeCloseTo(0.7, 9);
  });
});

describe("taskResources over a child that ends between the samples", () => {
  test("a parent that never waits for it still shows the 9 seconds it used itself", () => {
    expect(notesCores(listing([statLine(10, 1, 1000, 0), statLine(11, 10, 10000, 0)], [statLine(10, 1, 1900, 0)]))).toBeCloseTo(9, 9);
  });

  test("a parent that waits for it shows its own 9 seconds and the child's last second", () => {
    expect(notesCores(listing([statLine(10, 1, 1000, 0), statLine(11, 10, 10000, 0)], [statLine(10, 1, 1900, 10100)]))).toBeCloseTo(10, 9);
  });
});

describe("the D5 memory limit, flagged past a quarter of memory, never at exactly a quarter or on one second of busy cores", () => {
  const machine = { totalBytes: 64 * gib };

  test("16 GiB of 64 is not over, a byte more is", () => {
    expect(overLimits({ residentBytes: 16 * gib }, machine)).toEqual({ memory: false });
    expect(overLimits({ residentBytes: 16 * gib + 1 }, machine)).toEqual({ memory: true });
  });

  test("a task flags on its memory now, and never on its cores", () => {
    const notes = recordedTasks().filter(({ id }) => id === "tasks-release-notes");
    const busy = (residentPages: number): ProcessSamples => {
      const samples = valueOf(decodeLinuxTaskProcesses(listing([statLine(10, 1, 0, 0)], [statLine(10, 1, 1600, 0)])));
      return { ...samples, after: samples.after.map((process) => ({ ...process, residentBytes: residentPages * 4096 })) };
    };
    expect(taskResources(notes, busy(0), machine)[0]?.cpuCores).toBeCloseTo(16, 9);
    expect(taskResources(notes, busy(0), machine)[0]?.over).toEqual({ memory: false });
    expect(taskResources(notes, busy((16 * gib) / 4096 + 1), machine)[0]?.over).toEqual({ memory: true });
  });
});
