import { describe, expect, test } from "bun:test";
import { DateTime, Schema } from "effect";
import {
  AlertEvent,
  defaultAlertSettings,
  heavyLoadStart,
  heavyLoadStep,
  type HeavyLoadSettings,
  type MachineResources,
  type Outcome,
  type ResourcesReport,
} from "@tui-dash/schema";

const start = Date.parse("2026-10-19T09:00:00Z");

const second = 1000;

const minute = 60 * second;

const totalBytes = 100_000;

type Process = { readonly pid: number; readonly program: string; readonly cpuPercent: number; readonly residentBytes: number };

const processes: ReadonlyArray<Process> = [
  { pid: 11, program: "bun", cpuPercent: 90, residentBytes: 1_000 },
  { pid: 12, program: "node", cpuPercent: 70, residentBytes: 9_000 },
  { pid: 13, program: "cc1plus", cpuPercent: 50, residentBytes: 2_000 },
  { pid: 14, program: "rustc", cpuPercent: 40, residentBytes: 8_000 },
  { pid: 15, program: "ld", cpuPercent: 30, residentBytes: 3_000 },
  { pid: 16, program: "python3", cpuPercent: 20, residentBytes: 7_000 },
  { pid: 17, program: "zsh", cpuPercent: 10, residentBytes: 6_000 },
];

interface Level {
  readonly load5: number;
  readonly usedPercent: number;
}

const reportOf = ({ load5, usedPercent }: Level, generatedAt: number): ResourcesReport => ({
  schemaVersion: 1,
  generatedAt: new Date(generatedAt).toISOString(),
  machine: {
    cpu: { kind: "ok", value: { percent: 50, cores: 16 } },
    memory: { kind: "ok", value: { usedBytes: (totalBytes * usedPercent) / 100, totalBytes } },
    load: { kind: "ok", value: [load5, load5, load5] },
    processes: { kind: "ok", value: processes },
  },
  gpu: null,
});

const calm: Level = { load5: 1, usedPercent: 20 };

type Sample = Level | "unread" | { readonly saved: Level };

const savedAt = start - 61 * second;

const readingOf = (sample: Sample, at: number): Outcome<ResourcesReport> => {
  if (sample === "unread") return { kind: "unreachable", reason: "sh exited 255" };
  return "saved" in sample ? { kind: "ok", value: reportOf(sample.saved, savedAt) } : { kind: "ok", value: reportOf(sample, at) };
};

const machineSample = (name: string, sample: Sample, at: number): Outcome<ReadonlyArray<MachineResources>> => ({
  kind: "ok",
  value: [{ name, reading: readingOf(sample, at) }],
});

// Samples arrive every 30 seconds from the start, and each entry says what the machine read at that moment.
const run = (name: string, samples: ReadonlyArray<Sample>, settings: HeavyLoadSettings = defaultAlertSettings.heavyLoad) => {
  let state = heavyLoadStart;
  const fired: Array<{ readonly at: number; readonly event: ReturnType<typeof heavyLoadStep>["events"][number] }> = [];
  samples.forEach((sample, index) => {
    const at = start + index * 30 * second;
    const stepped = heavyLoadStep(state, machineSample(name, sample, at), DateTime.makeUnsafe(at), settings);
    state = stepped.state;
    for (const event of stepped.events) fired.push({ at: at - start, event });
  });
  return fired;
};

const held = (level: Level, minutes: number): ReadonlyArray<Level> => Array.from({ length: minutes * 2 }, () => level);

describe("the heavy load defaults", () => {
  test("hold the limits and the five minutes the brief names, keyed by the default machine names, local and remote, and by no other name", () => {
    expect(defaultAlertSettings.heavyLoad.sustainedMinutes).toBe(5);
    expect(defaultAlertSettings.heavyLoad.machines).toEqual([
      { name: "local", loadAtLeast: 10, memory: { usedAtLeastPercent: 90 } },
      { name: "remote", loadAtLeast: 16, memory: { availableUnderPercent: 15 } },
    ]);
  });
});

describe("the heavy load rule", () => {
  test("fires once on the Mac when the five-minute load holds at 10 for five minutes, and stays quiet while it holds", () => {
    const fired = run("local", [...held({ load5: 10, usedPercent: 20 }, 20)]);
    expect(fired.map(({ at }) => at)).toEqual([5 * minute]);
    expect(fired[0].event.crossed).toEqual(["load"]);
  });

  test("fires on the Mac when memory holds at 90 percent used, and never just below either limit", () => {
    expect(run("local", held({ load5: 1, usedPercent: 90 }, 6)).map(({ at, event }) => [at, event.crossed])).toEqual([[5 * minute, ["memory"]]]);
    expect(run("local", held({ load5: 9.99, usedPercent: 89.99 }, 20))).toEqual([]);
  });

  test("fires on the remote machine at load 16 or under 15 percent available, and not at load 15.99 or 15 percent available", () => {
    expect(run("remote", held({ load5: 16, usedPercent: 20 }, 6)).map(({ at }) => at)).toEqual([5 * minute]);
    expect(run("remote", held({ load5: 1, usedPercent: 85.01 }, 6)).map(({ at, event }) => [at, event.crossed])).toEqual([[5 * minute, ["memory"]]]);
    expect(run("remote", held({ load5: 15.99, usedPercent: 85 }, 20))).toEqual([]);
  });

  test("restarts the five minutes after a sample below the limits", () => {
    const heavy = { load5: 12, usedPercent: 20 };
    const fired = run("local", [...held(heavy, 4.5), calm, ...held(heavy, 6)]);
    expect(fired.map(({ at }) => at)).toEqual([10 * minute]);
  });

  test("fires again for a new episode once one calm sample ends the first", () => {
    const heavy = { load5: 12, usedPercent: 20 };
    const fired = run("local", [...held(heavy, 7), calm, ...held(heavy, 6)]);
    expect(fired.map(({ at }) => at)).toEqual([5 * minute, 12.5 * minute]);
  });

  test("lets an unread sample neither end the episode nor fire it", () => {
    const heavy = { load5: 12, usedPercent: 20 };
    const fired = run("local", [...held(heavy, 3), "unread", "unread", "unread", "unread", ...held(heavy, 2)]);
    expect(fired.map(({ at }) => at)).toEqual([5 * minute]);
  });

  test("ignores a machine the settings name no limits for", () => {
    expect(run("north", held({ load5: 99, usedPercent: 99 }, 20))).toEqual([]);
  });
});

describe("a resources report over a minute old", () => {
  test("never fires however long the same saved heavy copy comes back", () => {
    expect(run("remote", Array.from({ length: 40 }, () => ({ saved: { load5: 20, usedPercent: 90 } })))).toEqual([]);
  });

  test("neither ends nor extends an episode, like an unread sample", () => {
    const heavy = { load5: 12, usedPercent: 20 };
    const fired = run("local", [...held(heavy, 3), { saved: calm }, ...held(heavy, 2)]);
    expect(fired.map(({ at }) => at)).toEqual([5 * minute]);
  });
});

describe("the heavy load event", () => {
  test("names the machine, the episode start, the readings and the top processes by CPU and by memory, not every process the machine runs", () => {
    const fired = run("remote", [{ load5: 20, usedPercent: 90 }, ...held({ load5: 20, usedPercent: 90 }, 5)]);
    expect(fired).toHaveLength(1);
    const event = fired[0].event;
    expect(Schema.decodeUnknownSync(AlertEvent)(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(event).toMatchObject({
      schemaVersion: 1,
      rule: "heavy-load",
      at: "2026-10-19T09:05:00.000Z",
      machine: "remote",
      since: "2026-10-19T09:00:00.000Z",
      crossed: ["load", "memory"],
      limits: { name: "remote", loadAtLeast: 16, memory: { availableUnderPercent: 15 } },
      load: [20, 20, 20],
      memory: { usedBytes: 90_000, totalBytes, usedPercent: 90 },
    });
    expect(event.topProcesses.byCpu.map(({ pid }) => pid)).toEqual([11, 12, 13, 14, 15]);
    expect(event.topProcesses.byMemory.map(({ pid }) => pid)).toEqual([12, 14, 16, 17, 15]);
  });
});
