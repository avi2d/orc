import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import {
  decodeComputeApps,
  decodeGpus,
  decodeLinuxProcesses,
  decodeProcesses,
  decodeSysctl,
  decodeTopCpu,
  decodeVmStat,
  decodeCpuUsage,
  decodeDf,
  decodeLoadavg,
  decodeArcStats,
  decodeMeminfo,
  decodeOnlineCpus,
  ok,
  type Outcome,
  type Reading,
  type ResourceReadings,
  resourcesView,
  type ResourcesView,
} from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { issueOf, valueOf } from "../../lib/outcomes";

const capturedAt = DateTime.makeUnsafe("2026-10-13T20:18:16Z");

const reading = <A>(outcome: Outcome<A>): Reading<A> => ({ ...outcome, capturedAt });

const mac: ResourceReadings = {
  host: {
    platform: "mac",
    host: reading(
      ok({
        sysctl: valueOf(decodeSysctl(fixture("mac/sysctl.txt"))),
        vmStat: valueOf(decodeVmStat(fixture("mac/vm_stat.txt"))),
        top: valueOf(decodeTopCpu(fixture("mac/top.txt"))),
      }),
    ),
  },
  processes: reading(decodeProcesses(fixture("mac/ps.txt"))),
  gpu: reading({ kind: "unreachable", reason: "nvidia-smi did not start" }),
  disk: reading(ok(valueOf(decodeDf(fixture("mac/df.txt"))))),
};

const linuxHost = {
  load: valueOf(decodeLoadavg(fixture("linux/loadavg.txt"))),
  cpuCount: valueOf(decodeOnlineCpus(fixture("linux/nprocessors-onln.txt"))),
  cpuUsage: valueOf(decodeCpuUsage(fixture("linux/stat.txt"))),
  memory: valueOf(decodeMeminfo(fixture("linux/meminfo.txt"))),
  arcReclaimableBytes: 0,
};

const linux: ResourceReadings = {
  host: { platform: "linux", host: reading(ok(linuxHost)) },
  processes: reading(decodeLinuxProcesses(fixture("linux/proc-stat.txt"))),
  disk: reading(ok(valueOf(decodeDf(fixture("linux/df.txt"))))),
  gpu: reading(
    ok({
      gpus: valueOf(decodeGpus(fixture("linux/gpu.csv"))),
      apps: decodeComputeApps(fixture("linux/gpu-apps.csv")),
    }),
  ),
};

const gpuOf = (view: ResourcesView) => {
  if (view.gpu === undefined) throw new Error("expected a gpu panel");
  return valueOf(view.gpu);
};

describe("the mac resources against top and vm_stat applied to the mac fixtures", () => {
  test("cpu is the second sample, 9.50 user and 4.03 sys of 100 ticks, on the 10 cores sysctl names", () => {
    const cpu = valueOf(resourcesView(mac).machine.cpu);
    expect(cpu.percent).toBeCloseTo(13.53, 9);
    expect(cpu.cores).toBe(10);
  });

  test("memory used is (400000 active + 150000 wired) pages of 16384 bytes", () => {
    expect(valueOf(resourcesView(mac).machine.memory)).toEqual({
      usedBytes: 9011200000,
      totalBytes: 34359738368,
    });
  });

  test("disk used is the df of the home directory's total less available, in bytes", () => {
    expect(resourcesView(mac).machine.disk).toEqual(
      ok({ usedBytes: (482797652 - 154758788) * 1024, totalBytes: 482797652 * 1024 }),
    );
  });

  test("load is sysctl's three averages", () => {
    expect(valueOf(resourcesView(mac).machine.load)).toEqual([2.17, 2.36, 2.4]);
  });

  test("processes run busiest first, ties by memory, named by the last part of their path", () => {
    const rows = valueOf(resourcesView(mac).machine.processes);
    expect(rows.map((row) => [row.pid, row.program])).toEqual([
      [15980, "wezterm-gui"],
      [1441, "Google Chrome Helper (Renderer)"],
      [1430, "Finder"],
      [759, "BlockBlock"],
      [1, "launchd"],
      [2113, "XprotectService"],
    ]);
    expect(rows[1]?.residentBytes).toBe(81168 * 1024);
  });

  test("a process cpu is the recent top %cpu over the 10 cores, a share of the machine as on linux", () => {
    const shares = valueOf(resourcesView(mac).machine.processes).map((row) => row.cpuPercent);
    [1.52, 0.31, 0.02, 0.01, 0, 0].forEach((share, index) => expect(shares[index]).toBeCloseTo(share, 10));
  });

  test("a process born after the top sample reads 0, as btop gives a first-seen process no delta", () => {
    const processes = reading(decodeProcesses("99999  20.0   1000 newborn\n" + fixture("mac/ps.txt")));
    const rows = valueOf(resourcesView({ ...mac, processes }).machine.processes);
    expect(rows.find((row) => row.pid === 99999)?.cpuPercent).toBe(0);
  });
});

describe("the linux resources against hand sums of the recorded /proc output", () => {
  test("cpu is the 175 busy of the 1618 jiffies between the two /proc/stat samples, on the 16 online cpus getconf names", () => {
    const cpu = valueOf(resourcesView(linux).machine.cpu);
    expect(cpu.percent).toBeCloseTo(10.816, 3);
    expect(cpu.cores).toBe(16);
  });

  test("a load of 16 on 16 cores with the cpus idle or waiting on I/O reads as low cpu, and keeps the load", () => {
    const busyOnIo = {
      platform: "linux" as const,
      host: reading(
        ok({
          ...linuxHost,
          load: [16, 16, 16] as const,
          cpuUsage: valueOf(
            decodeCpuUsage("cpu  1000 0 500 100000 2000 0 100 0 0 0\ncpu  1010 0 505 101200 2380 0 105 0 0 0\n"),
          ),
        }),
      ),
    };
    const view = resourcesView({ ...linux, host: busyOnIo });
    expect(valueOf(view.machine.cpu).percent).toBeCloseTo(1.25, 10);
    expect(valueOf(view.machine.load)).toEqual([16, 16, 16]);
  });

  test("memory used is MemTotal less MemAvailable, in bytes", () => {
    expect(valueOf(resourcesView(linux).machine.memory)).toEqual({
      usedBytes: (32790160 - 27070860) * 1024,
      totalBytes: 32790160 * 1024,
    });
  });

  test("disk used is the df of the root filesystem's total less available, in bytes", () => {
    expect(resourcesView(linux).machine.disk).toEqual(
      ok({ usedBytes: (1055762868 - 853496292) * 1024, totalBytes: 1055762868 * 1024 }),
    );
  });

  test("a reclaimable ZFS cache reads as available, size less c_min off the used bytes", () => {
    const cached = {
      platform: "linux" as const,
      host: reading(ok({ ...linuxHost, arcReclaimableBytes: valueOf(decodeArcStats(fixture("linux/arcstats.txt"))) })),
    };
    expect(valueOf(resourcesView({ ...linux, host: cached }).machine.memory)).toEqual({
      usedBytes: (32790160 - 27070860) * 1024 - (1073741824 - 33554432),
      totalBytes: 32790160 * 1024,
    });
  });

  test("processes run busiest first by their 162, 81, 40 and 2 jiffies of the 1618 between the samples", () => {
    const rows = valueOf(resourcesView(linux).machine.processes);
    expect(rows.slice(0, 4).map((row) => [row.pid, row.program])).toEqual([
      [492953, "pi"],
      [680112, "bash"],
      [2817940, "pi"],
      [77, "kworker/0:1-events"],
    ]);
    expect(rows.slice(0, 4).map((row) => row.cpuPercent)).toEqual(
      [162, 81, 40, 2].map((jiffies) => (jiffies / 1618) * 100),
    );
  });

  test("python's 10000 jiffies in the 10000 since it started, which ps reads as 100%, rank below every process busy now", () => {
    const rows = valueOf(resourcesView(linux).machine.processes);
    const python = rows.findIndex((row) => row.pid === 3809535);
    expect(rows[python]?.cpuPercent).toBe(0);
    expect(python).toBe(4);
  });

  test("a kernel thread keeps the slash in its name", () => {
    const kworker = valueOf(resourcesView(linux).machine.processes).find((row) => row.pid === 77);
    expect(kworker?.program).toBe("kworker/0:1-events");
  });

  test("load is /proc/loadavg's three averages", () => {
    expect(valueOf(resourcesView(linux).machine.load)).toEqual([0.79, 1.28, 1.45]);
  });

  test("processes at the same cpu run largest resident set first", () => {
    const idle = reading(decodeProcesses("   10 0.0   100 small\n   20 0.0   900 large\n   30 0.0   500 middle\n"));
    expect(valueOf(resourcesView({ ...linux, processes: idle }).machine.processes).map((row) => row.pid)).toEqual([
      20, 30, 10,
    ]);
  });
});

describe("the GPU resources against the recorded nvidia-smi and /proc output", () => {
  test("keeps nvidia-smi's figures", () => {
    expect(gpuOf(resourcesView(linux)).gpus).toEqual([
      {
        name: "NVIDIA GeForce RTX 3080 Laptop GPU",
        utilizationPercent: { kind: "value", value: 9 },
        memoryUsedMiB: { kind: "value", value: 1871 },
        memoryTotalMiB: { kind: "value", value: 16384 },
        temperatureC: { kind: "value", value: 46 },
      },
    ]);
  });

  test("names a [Not Found] app from the linux process with its pid, and leaves [N/A] memory unreported", () => {
    expect(valueOf(gpuOf(resourcesView(linux)).apps)).toEqual([
      { pid: 3809535, program: "python", memoryUsedMiB: { kind: "not-reported" } },
    ]);
  });

  test("leaves an app unnamed when the linux processes are unreachable", () => {
    const view = resourcesView({ ...linux, processes: reading({ kind: "unreachable", reason: "ps exited 1: no" }) });
    expect(valueOf(gpuOf(view).apps)[0]?.program).toBeUndefined();
  });

  test("keeps a name nvidia-smi reported, and its memory", () => {
    const apps = decodeComputeApps("4242, /usr/bin/python3, 2048\n");
    const view = resourcesView({ ...linux, gpu: reading(ok({ gpus: [], apps })) });
    expect(valueOf(gpuOf(view).apps)).toEqual([{ pid: 4242, program: "python3", memoryUsedMiB: { kind: "value", value: 2048 } }]);
  });

  test("a GPU field nvidia-smi does not support is not reported, never a number", () => {
    const gpus = valueOf(decodeGpus("RTX, 9, 1871, 16384, [Not Supported]\n"));
    const view = resourcesView({ ...linux, gpu: reading(ok({ gpus, apps: ok([]) })) });
    expect(gpuOf(view).gpus[0]?.temperatureC).toEqual({ kind: "not-reported" });
  });

  test("an unreachable apps query keeps nvidia-smi's gpu figures and leaves only the apps unreachable", () => {
    const gpus = valueOf(decodeGpus(fixture("linux/gpu.csv")));
    const apps = { kind: "unreachable" as const, reason: "nvidia-smi exited 6: no" };
    const view = resourcesView({ ...linux, gpu: reading(ok({ gpus, apps })) });
    expect(gpuOf(view).gpus[0]?.utilizationPercent).toEqual({ kind: "value", value: 9 });
    expect(gpuOf(view).apps).toEqual(apps);
  });

  test("an unreachable nvidia-smi leaves the gpu panel out, never an error box", () => {
    expect(resourcesView(mac).gpu).toBeUndefined();
  });
});

describe("the resources against failed readings, which must show the failure and no number", () => {
  test("an unreachable host leaves cpu, memory and load unreachable but keeps the process table", () => {
    const view = resourcesView({
      ...linux,
      host: { platform: "linux", host: reading({ kind: "unreachable", reason: "getconf exited 1: no" }) },
    });
    expect(view.machine.cpu).toEqual({ kind: "unreachable", reason: "getconf exited 1: no" });
    expect(view.machine.memory).toEqual({ kind: "unreachable", reason: "getconf exited 1: no" });
    expect(view.machine.load).toEqual({ kind: "unreachable", reason: "getconf exited 1: no" });
    expect(view.machine.processes.kind).toBe("ok");
  });

  test("an unreachable mac host leaves the processes unreachable, never ps's lifetime cpu", () => {
    const view = resourcesView({
      ...mac,
      host: { platform: "mac", host: reading({ kind: "unreachable", reason: "top exited 1: no" }) },
    });
    expect(view.machine.cpu).toEqual({ kind: "unreachable", reason: "top exited 1: no" });
    expect(view.machine.processes).toEqual({ kind: "unreachable", reason: "top exited 1: no" });
  });

  test("an invalid mac ps leaves the processes invalid but keeps the top cpu and the memory", () => {
    const view = resourcesView({ ...mac, processes: reading(decodeProcesses(fixture("mac/ps-changed.txt"))) });
    expect(valueOf(view.machine.cpu).percent).toBeCloseTo(13.53, 9);
    expect(view.machine.memory.kind).toBe("ok");
    expect(view.machine.processes.kind).toBe("invalid");
  });

  test("an invalid GPU reading is invalid", () => {
    const issue = issueOf(decodeGpus(fixture("linux/gpu-changed.csv")));
    const view = resourcesView({ ...linux, gpu: reading({ kind: "invalid", issue }) });
    expect(view.gpu).toEqual({ kind: "invalid", issue });
  });
});
