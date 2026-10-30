import { describe, expect, test } from "bun:test";
import { decodeArcStats, decodeCpuUsage, decodeLoadavg, decodeMeminfo, decodeOnlineCpus } from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { issueOf, valueOf } from "../../lib/outcomes";

describe("the linux /proc readers against the recorded linux output", () => {
  test("decodeLoadavg reads the three averages of /proc/loadavg", () => {
    expect(valueOf(decodeLoadavg(fixture("linux/loadavg.txt")))).toEqual([0.79, 1.28, 1.45]);
  });

  test("decodeOnlineCpus reads the online cpu count", () => {
    expect(valueOf(decodeOnlineCpus(fixture("linux/nprocessors-onln.txt")))).toBe(16);
  });

  test("decodeCpuUsage reads the jiffies between two samples: user 60, system 98, softirq 17 busy, plus idle 1443", () => {
    expect(valueOf(decodeCpuUsage(fixture("linux/stat.txt")))).toEqual({ busyJiffies: 175, totalJiffies: 1618 });
  });

  test("decodeMeminfo reads MemTotal, MemFree and MemAvailable in kB", () => {
    expect(valueOf(decodeMeminfo(fixture("linux/meminfo.txt")))).toEqual({
      MemTotal: 32790160,
      MemFree: 2254444,
      MemAvailable: 27070860,
    });
  });

  test("decodeArcStats reads the reclaimable ZFS cache as size less c_min, in bytes", () => {
    expect(valueOf(decodeArcStats(fixture("linux/arcstats.txt")))).toBe(1073741824 - 33554432);
  });
});

describe("the linux /proc readers against changed formats", () => {
  test("meminfo in MB is invalid, never a kB figure", () => {
    expect(issueOf(decodeMeminfo(fixture("linux/meminfo-changed.txt")))).toContain("MemTotal");
  });

  test("a comma-separated loadavg is invalid", () => {
    expect(issueOf(decodeLoadavg("0.79,1.28,1.45\n"))).toBe(
      "/proc/loadavg does not read as 1m 5m 15m runnable/total pid",
    );
  });

  test("a zero core count is invalid, so no meter divides by it", () => {
    expect(decodeOnlineCpus("0\n").kind).toBe("invalid");
  });

  test("a cpu line without proc(5)'s ten counts is invalid", () => {
    expect(issueOf(decodeCpuUsage("cpu  1 2 3 4\ncpu  2 3 4 5\n"))).toBe("line 1 does not read as the cpu line of /proc/stat");
  });

  test("a single /proc/stat sample is invalid, since one sample only holds totals since boot", () => {
    expect(issueOf(decodeCpuUsage("cpu  1 0 1 10 0 0 0 0 0 0\n"))).toContain("[1]");
  });

  test("a third /proc/stat sample is invalid", () => {
    expect(decodeCpuUsage("cpu  1 0 1 10 0 0 0 0 0 0\n".repeat(3)).kind).toBe("invalid");
  });

  test("a signed or exponent jiffy count is invalid and names its field", () => {
    expect(issueOf(decodeCpuUsage("cpu  1 0 1 -10 0 0 0 0 0 0\ncpu  2 0 2 20 0 0 0 0 0 0\n"))).toContain('["idle"]');
    expect(issueOf(decodeCpuUsage("cpu  1 0 1 10 0 0 0 0 0 0\ncpu  2 0 2 20 0 0 1e3 0 0 0\n"))).toContain('["softirq"]');
  });

  test("a second sample that did not advance is invalid, so no meter divides by zero", () => {
    expect(decodeCpuUsage("cpu  1 0 1 10 0 0 0 0 0 0\ncpu  1 0 1 10 0 0 0 0 0 0\n").kind).toBe("invalid");
  });
});

describe("the linux /proc readers against proc(5)'s forms", () => {
  test("time waiting on I/O counts toward the total and not as busy", () => {
    expect(valueOf(decodeCpuUsage("cpu  0 0 0 0 0 0 0 0 0 0\ncpu  0 0 0 20 80 0 0 0 0 0\n"))).toEqual({
      busyJiffies: 0,
      totalJiffies: 100,
    });
  });

  test("irq, softirq and steal count as busy", () => {
    expect(valueOf(decodeCpuUsage("cpu  0 0 0 0 0 0 0 0 0 0\ncpu  0 0 0 70 0 10 10 10 0 0\n"))).toEqual({
      busyJiffies: 30,
      totalJiffies: 100,
    });
  });

  test("guest time, which the kernel also adds to user and nice, counts once", () => {
    expect(valueOf(decodeCpuUsage("cpu  0 0 0 0 0 0 0 0 0 0\ncpu  40 10 0 50 0 0 0 0 40 10\n"))).toEqual({
      busyJiffies: 50,
      totalJiffies: 100,
    });
  });

  test("a runnable count of more than one digit reads", () => {
    expect(valueOf(decodeLoadavg("0.79 1.28 1.45 12/1230 1191494\n"))).toEqual([0.79, 1.28, 1.45]);
  });

  test("a loadavg with a field before the three averages is invalid", () => {
    expect(decodeLoadavg("0.50 0.79 1.28 1.45 3/1230 1191494\n").kind).toBe("invalid");
  });

  test("a loadavg with a field after the last pid is invalid", () => {
    expect(decodeLoadavg("0.79 1.28 1.45 3/1230 1191494 7\n").kind).toBe("invalid");
  });

  test("a signed average is invalid, since /proc writes only unsigned decimals", () => {
    expect(decodeLoadavg("-0.79 1.28 1.45 3/1230 1191494\n").kind).toBe("invalid");
  });

  test("an average in exponent form is invalid", () => {
    expect(decodeLoadavg("7.9e-1 1.28 1.45 3/1230 1191494\n").kind).toBe("invalid");
  });

  test("a signed or exponent kB count is invalid", () => {
    expect(decodeMeminfo("MemTotal:       -5 kB\nMemAvailable:   1 kB\n").kind).toBe("invalid");
    expect(decodeMeminfo("MemTotal:       1e3 kB\nMemAvailable:   1 kB\n").kind).toBe("invalid");
  });
});

describe("decodeCpuUsage against hand-computed /proc/stat deltas", () => {
  test("an interval spent wholly in user time is 100 busy jiffies of 100, never invalid", () => {
    expect(valueOf(decodeCpuUsage("cpu  0 0 0 0 0 0 0 0 0 0\ncpu  100 0 0 0 0 0 0 0 0 0\n"))).toEqual({
      busyJiffies: 100,
      totalJiffies: 100,
    });
  });

  test("busy jiffies that went backwards are invalid, since proc(5)'s counters only grow", () => {
    expect(issueOf(decodeCpuUsage("cpu  100 0 0 0 0 0 0 0 0 0\ncpu  50 0 0 200 0 0 0 0 0 0\n"))).toBe(
      "the second /proc/stat sample does not follow the first",
    );
  });

  test("an iowait drop that leaves more busy jiffies than total ones is invalid, never above 100%", () => {
    expect(decodeCpuUsage("cpu  0 0 0 0 100 0 0 0 0 0\ncpu  50 0 0 10 70 0 0 0 0 0\n").kind).toBe("invalid");
  });

  test("a cpu line with a field before cpu is invalid", () => {
    expect(issueOf(decodeCpuUsage("0 cpu  1 0 1 10 0 0 0 0 0 0\n0 cpu  2 0 2 20 0 0 0 0 0 0\n"))).toBe(
      "line 1 does not read as the cpu line of /proc/stat",
    );
  });

  test("a cpu line with an eleventh count is invalid", () => {
    expect(issueOf(decodeCpuUsage("cpu  1 0 1 10 0 0 0 0 0 0 0\ncpu  2 0 2 20 0 0 0 0 0 0 0\n"))).toBe(
      "line 1 does not read as the cpu line of /proc/stat",
    );
  });
});

describe("decodeArcStats against /proc/spl/kstat/zfs/arcstats output", () => {
  test("a cache smaller than its minimum reads as no reclaimable memory", () => {
    expect(valueOf(decodeArcStats("c_min 4 200\nsize 4 100\n"))).toBe(0);
  });

  test("a size that is not a number is invalid and names its field", () => {
    expect(issueOf(decodeArcStats("c_min 4 100\nsize 4 lots\n"))).toContain("size");
  });

  test("a file without the cache lines is invalid, so the host reads it as no cache", () => {
    expect(issueOf(decodeArcStats("name type data\nhits 4 10\n"))).toContain("cMin");
  });
});

describe("decodeMeminfo against lines with extra fields", () => {
  test("a MemTotal line with a field before its key is invalid", () => {
    expect(issueOf(decodeMeminfo("1 MemTotal:       32790160 kB\nMemAvailable:   27070860 kB\n"))).toContain("MemTotal");
  });

  test("a MemTotal line with a field after its unit is invalid", () => {
    expect(issueOf(decodeMeminfo("MemTotal:       32790160 kB 0\nMemAvailable:   27070860 kB\n"))).toContain("MemTotal");
  });
});
