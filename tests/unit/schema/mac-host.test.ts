import { describe, expect, test } from "bun:test";
import { decodeSysctl, decodeTopCpu, decodeVmStat } from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { issueOf, valueOf } from "../../lib/outcomes";

describe("decodeSysctl against sysctl -n hw.ncpu hw.memsize vm.loadavg output", () => {
  test("reads the core count, the memory size and the three load averages", () => {
    expect(valueOf(decodeSysctl(fixture("mac/sysctl.txt")))).toEqual({
      cpuCount: 10,
      memoryBytes: 34359738368,
      load: [2.17, 2.36, 2.4],
    });
  });

  test("a load average without its braces is invalid", () => {
    expect(issueOf(decodeSysctl(fixture("mac/sysctl-changed.txt")))).toBe(
      "vm.loadavg does not read as { 1m 5m 15m }",
    );
  });

  test("a missing line is invalid", () => {
    expect(issueOf(decodeSysctl("10\n34359738368\n"))).toBe(
      "expected 3 lines of hw.ncpu, hw.memsize and vm.loadavg, got 2",
    );
  });
});

describe("decodeVmStat against vm_stat output", () => {
  test("reads the page size from the header and the four counters the memory meter sums", () => {
    expect(valueOf(decodeVmStat(fixture("mac/vm_stat.txt")))).toEqual({
      pageSizeBytes: 16384,
      "Pages active": 400000,
      "Pages wired down": 150000,
      "Pages speculative": 10000,
      "Pages occupied by compressor": 140000,
    });
  });

  test("a renamed counter is invalid", () => {
    expect(issueOf(decodeVmStat(fixture("mac/vm_stat-changed.txt")))).toContain("Pages active");
  });

  test("a header without a page size is invalid", () => {
    expect(issueOf(decodeVmStat("Pages active: 1.\n"))).toBe("the vm_stat header names no page size");
  });
});

describe("the mac readers against the exact forms macOS prints", () => {
  test("a load average with its name in front, as sysctl prints it without -n, is invalid", () => {
    expect(issueOf(decodeSysctl("10\n34359738368\nvm.loadavg: { 2.17 2.36 2.40 }\n"))).toBe(
      "vm.loadavg does not read as { 1m 5m 15m }",
    );
  });

  test("a load average with anything after its closing brace is invalid", () => {
    expect(decodeSysctl("10\n34359738368\n{ 2.17 2.36 2.40 } 1.00\n").kind).toBe("invalid");
  });

  test("a vm_stat counter without its closing period is invalid", () => {
    const changed = fixture("mac/vm_stat.txt").replace("400000.", "400000");
    expect(issueOf(decodeVmStat(changed))).toBe("line 2 does not read as a counter and its count");
  });

  test("a vm_stat counter with text after its period is invalid", () => {
    expect(decodeVmStat(fixture("mac/vm_stat.txt").replace("400000.", "400000. (35%)")).kind).toBe("invalid");
  });

  test("empty vm_stat output is invalid", () => {
    expect(issueOf(decodeVmStat(""))).toBe("the vm_stat header names no page size");
  });
});

describe("decodeTopCpu against top -l output", () => {
  test("reads the last sample as user and sys over user, sys and idle", () => {
    expect(valueOf(decodeTopCpu(fixture("mac/top.txt"))).totalPercent).toBeCloseTo(13.53, 10);
  });

  test("maps each pid of the last table to its recent cpu", () => {
    const { cpuByPid } = valueOf(decodeTopCpu(fixture("mac/top.txt")));
    expect(cpuByPid.get(15980)).toBe(15.2);
    expect(cpuByPid.get(1441)).toBe(3.1);
    expect(cpuByPid.get(1)).toBe(0);
  });

  test("ignores the first sample, which top averages since boot", () => {
    expect(valueOf(decodeTopCpu(fixture("mac/top.txt"))).totalPercent).not.toBeCloseTo(4.12 + 2.1, 1);
  });

  test("output without a cpu usage line is invalid", () => {
    expect(issueOf(decodeTopCpu("PID COMMAND %CPU\n1 launchd 0.0\n"))).toBe("top output holds no cpu usage line");
  });

  test("output without a process table is invalid", () => {
    expect(issueOf(decodeTopCpu("CPU usage: 9.50% user, 4.03% sys, 86.47% idle\n"))).toBe(
      "top output holds no pid, command and cpu table",
    );
  });

  test("a process row without its cpu is invalid and named by its line", () => {
    expect(issueOf(decodeTopCpu("CPU usage: 9.50% user, 4.03% sys, 86.47% idle\nPID COMMAND %CPU\n1 launchd\n"))).toBe(
      "line 1 does not read as pid, command and cpu",
    );
  });
});

describe("decodeVmStat against counter lines with extra fields", () => {
  test("a counter line with a labelled field before its name is invalid and named by its line", () => {
    const changed = fixture("mac/vm_stat.txt").replace("Pages active:", "x: Pages active:");
    expect(issueOf(decodeVmStat(changed))).toBe("line 2 does not read as a counter and its count");
  });
});
