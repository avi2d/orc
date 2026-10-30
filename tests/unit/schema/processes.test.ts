import { describe, expect, test } from "bun:test";
import { decodeProcesses, decodeLinuxProcesses } from "@tui-dash/schema";
import { fixture } from "../../lib/fixtures";
import { issueOf, valueOf } from "../../lib/outcomes";

describe("decodeProcesses against ps -o pid=,%cpu=,rss=,comm= output", () => {
  test("splits the recorded mac table into pid, cpu, rss and command", () => {
    const rows = valueOf(decodeProcesses(fixture("mac/ps.txt")));
    expect(rows).toHaveLength(6);
    expect(rows[1]).toEqual({
      pid: 759,
      command: "/Library/Objective-See/BlockBlock/BlockBlock.app/Contents/MacOS/BlockBlock",
      cpuPercent: 1,
      residentKiB: 11968,
    });
  });

  test("keeps the spaces inside a macOS executable path", () => {
    const chrome = valueOf(decodeProcesses(fixture("mac/ps.txt"))).find((row) => row.pid === 1441);
    expect(chrome?.command).toBe(
      "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/154.0.8037.58/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)",
    );
    expect(chrome?.cpuPercent).toBe(1.6);
  });

  test("keeps the whole path when comm is the last column, from the live Mac capture", () => {
    const rows = valueOf(
      decodeProcesses(
        " 1430   0.0  80976 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder\n 2113   0.0   5456 /System/Library/PrivateFrameworks/XprotectFramework.framework/Versions/A/XPCServices/XprotectService.xpc/Contents/MacOS/XprotectService\n  759   1.0  11968 /Library/Objective-See/BlockBlock/BlockBlock.app/Contents/MacOS/BlockBlock\n15980  15.4  66944 /Applications/WezTerm.app/Contents/MacOS/wezterm-gui\n",
      ),
    );
    expect(rows.map((row) => row.command)).toEqual([
      "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
      "/System/Library/PrivateFrameworks/XprotectFramework.framework/Versions/A/XPCServices/XprotectService.xpc/Contents/MacOS/XprotectService",
      "/Library/Objective-See/BlockBlock/BlockBlock.app/Contents/MacOS/BlockBlock",
      "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui",
    ]);
  });

  test("a table with a header row is invalid, never a process", () => {
    expect(issueOf(decodeProcesses(fixture("mac/ps-changed.txt")))).toContain("pid");
  });

  test("a line with too few columns is invalid", () => {
    expect(issueOf(decodeProcesses("  12 0.0\n"))).toBe("line 1 does not read as pid, cpu, rss and command");
  });

  test("empty output is invalid, since ps always lists itself", () => {
    expect(decodeProcesses("").kind).toBe("invalid");
  });
});

describe("decodeProcesses against the four columns ps -o prints", () => {
  test("a command holding spaces still reads as one row", () => {
    expect(valueOf(decodeProcesses("    1 0.0  1234 init S\n"))[0]?.command).toBe("init S");
  });

  test("a line of only spaces is blank, not a row", () => {
    expect(valueOf(decodeProcesses("    1 0.0  1234 init\n      \n"))).toHaveLength(1);
  });
});

describe("decodeProcesses against rows with leading extra fields", () => {
  test("a row with a field before the pid is invalid", () => {
    expect(decodeProcesses("S     1 0.0  1234 init\n").kind).toBe("invalid");
  });

  test("a row indented with a tab is invalid, since ps pads its columns with spaces", () => {
    expect(issueOf(decodeProcesses("\t1 0.0  1234 init\n"))).toBe("line 1 does not read as pid, cpu, rss and command");
  });
});

interface PidStat {
  readonly pid: number;
  readonly comm: string;
  readonly utime: number;
  readonly stime: number;
  readonly cutime?: number;
  readonly starttime: number;
  readonly rss: number;
}

const pidStat = ({ pid, comm, utime, stime, cutime = 0, starttime, rss }: PidStat): string =>
  `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 4194560 1200 0 3 0 ${utime} ${stime} ${cutime} 0 20 0 1 0 ${starttime} 20000000 ${rss} 18446744073709551615 1 1 0 0 0 0 0 4096 81920 0 0 0 17 3 0 0 0 0 0 0 0 0 0 0 0 0 0`;

const idleCpu = "cpu  0 0 0 0 0 0 0 0 0 0";
const hundredLater = "cpu  0 0 0 100 0 0 0 0 0 0";

const sampled = (before: ReadonlyArray<string>, after: ReadonlyArray<string>, pageBytes = "4096"): string =>
  [pageBytes, idleCpu, ...before, hundredLater, ...after].join("\n");

const shell: PidStat = { pid: 40, comm: "sh", utime: 0, stime: 0, starttime: 900, rss: 300 };

describe("decodeLinuxProcesses against hand-computed /proc/<pid>/stat deltas over the 1618 jiffies of the recorded /proc/stat", () => {
  const rows = valueOf(decodeLinuxProcesses(fixture("linux/proc-stat.txt")));
  const row = (pid: number) => rows.find((candidate) => candidate.pid === pid);

  test("a process's cpu is its utime plus stime delta, 120 + 42 of 1618 jiffies, and rss is pages of 4096 bytes", () => {
    expect(row(492953)?.command).toBe("pi");
    expect(row(492953)?.cpuPercent).toBeCloseTo((162 / 1618) * 100, 10);
    expect(row(492953)?.residentKiB).toBe(467956);
  });

  test("the time of waited-for children, cutime and cstime, is not the process's own", () => {
    expect(row(680112)?.cpuPercent).toBeCloseTo((81 / 1618) * 100, 10);
  });

  test("keeps the parentheses inside comm, which runs to the last parenthesis on the line", () => {
    expect(row(505)?.command).toBe("(sd-pam)");
    expect(row(2)?.command).toBe("init-systemd(Ub");
  });

  test("drops a process that exited, one that started, and a pid reused between the samples", () => {
    expect(rows.map((candidate) => candidate.pid).toSorted((a, b) => a - b)).toEqual([
      1, 2, 77, 505, 492953, 680112, 2817940, 3809535,
    ]);
  });
});

describe("decodeLinuxProcesses against linux /proc lines and the program names read from cmdline for cut comms, a shell and a kworker", () => {
  const rows = valueOf(decodeLinuxProcesses(fixture("linux/proc-stat-cmdline.txt")));
  const row = (pid: number) => rows.find((candidate) => candidate.pid === pid);

  test("a cut comm shows the whole name read for its pid", () => {
    expect(row(3221480)?.command).toBe("Runner.Listener");
    expect(row(2788)?.command).toBe("my-remote-job-worker.sh");
    expect(row(1131476)?.command).toBe("chrome_crashpad_handler");
    expect(row(182)).toEqual({ pid: 182, command: "networkd-dispatcher", cpuPercent: 0, residentKiB: 5280 });
  });

  test("a cut comm with no name read keeps comm, so pid 2 keeps init-systemd(Ub", () => {
    expect(row(2)?.command).toBe("init-systemd(Ub");
    expect(row(2)?.residentKiB).toBe(2064);
  });

  test("a short comm keeps its name with no cmdline line read for it", () => {
    expect(row(1983600)).toEqual({ pid: 1983600, command: "bash", cpuPercent: 0, residentKiB: 7304 });
  });

  test("a kernel thread keeps its comm from the recorded linux capture, since its cmdline is empty", () => {
    expect(row(77)?.command).toBe("kworker/0:1-events");
    expect(row(77)?.cpuPercent).toBeCloseTo((2 / 1947) * 100, 10);
  });

  test("an idle process reads 0% with pages of 4096 bytes", () => {
    expect(row(547038)).toEqual({
      pid: 547038,
      command: "at-spi-bus-launcher",
      cpuPercent: 0,
      residentKiB: 5572,
    });
  });
});

describe("decodeLinuxProcesses against proc(5)'s forms", () => {
  test("a field the kernel appends after the 52nd still reads", () => {
    expect(valueOf(decodeLinuxProcesses(sampled([`${pidStat(shell)} 0`], [`${pidStat(shell)} 0`])))).toEqual([
      { pid: 40, command: "sh", cpuPercent: 0, residentKiB: 1200 },
    ]);
  });

  test("a whole interval of one process's jiffies is 100% of the machine", () => {
    const busy = { ...shell, utime: 100 };
    expect(valueOf(decodeLinuxProcesses(sampled([pidStat(shell)], [pidStat(busy)])))[0]?.cpuPercent).toBe(100);
  });
});

describe("decodeLinuxProcesses against changed or broken samples", () => {
  test("a program name in place of the cpu line of /proc/stat is invalid and named by its line", () => {
    expect(issueOf(decodeLinuxProcesses(`4096\nname 40 sh\n${sampled([pidStat(shell)], [pidStat(shell)]).slice(5)}`))).toBe(
      "line 2 does not read as the cpu line of /proc/stat, a /proc/<pid>/stat line or a /proc/<pid>/cmdline argument",
    );
  });

  test("ps output in place of /proc is invalid, never a process", () => {
    expect(issueOf(decodeLinuxProcesses("4096\n    1 systemd          0.0 11524\n"))).toBe(
      "line 2 does not read as the cpu line of /proc/stat, a /proc/<pid>/stat line or a /proc/<pid>/cmdline argument",
    );
  });

  test("a /proc/<pid>/stat line before any /proc/stat line is invalid", () => {
    expect(decodeLinuxProcesses(["4096", pidStat(shell), idleCpu, hundredLater].join("\n")).kind).toBe("invalid");
  });

  test("a /proc/<pid>/stat line short of the rss field is invalid", () => {
    const short = pidStat(shell).split(" ").slice(0, 23).join(" ");
    expect(decodeLinuxProcesses(sampled([short], [pidStat(shell)])).kind).toBe("invalid");
  });

  test("a single sample is invalid, since one sample only holds totals since boot", () => {
    expect(issueOf(decodeLinuxProcesses(["4096", idleCpu, pidStat(shell)].join("\n")))).toContain("[1]");
  });

  test("a missing or zero page size is invalid, so no rss is guessed", () => {
    expect(issueOf(decodeLinuxProcesses(sampled([pidStat(shell)], [pidStat(shell)], "0")))).toContain('["pageBytes"]');
    expect(decodeLinuxProcesses(sampled([pidStat(shell)], [pidStat(shell)]).replace("4096\n", "")).kind).toBe("invalid");
  });

  test("a signed jiffy count is invalid and names its field", () => {
    const signed = pidStat(shell).replace(" 0 0 0 0 20 ", " -1 0 0 0 20 ");
    expect(issueOf(decodeLinuxProcesses(sampled([signed], [pidStat(shell)])))).toContain('["utime"]');
  });

  test("a /proc/stat that did not advance is invalid, so no share divides by zero", () => {
    expect(issueOf(decodeLinuxProcesses(["4096", idleCpu, pidStat(shell), idleCpu, pidStat(shell)].join("\n")))).toBe(
      "the second /proc/stat sample does not follow the first",
    );
  });

  test("an iowait drop that leaves more busy jiffies than total ones is invalid, never a process above 100%", () => {
    const busy = { ...shell, utime: 50 };
    const stdout = ["4096", "cpu  0 0 0 0 100 0 0 0 0 0", pidStat(shell), "cpu  50 0 0 10 70 0 0 0 0 0", pidStat(busy)].join("\n");
    expect(issueOf(decodeLinuxProcesses(stdout))).toBe("the second /proc/stat sample does not follow the first");
  });

  test("a /proc/<pid>/stat line with a field before the pid is invalid and named by its line", () => {
    expect(issueOf(decodeLinuxProcesses(sampled([`x ${pidStat(shell)}`], [pidStat(shell)])))).toBe(
      "line 3 does not read as the cpu line of /proc/stat, a /proc/<pid>/stat line or a /proc/<pid>/cmdline argument",
    );
  });

  test("a per-cpu line, which a whole /proc/stat would bring in, is invalid and named by its line", () => {
    expect(issueOf(decodeLinuxProcesses(sampled(["cpu0 0 0 0 0 0 0 0 0 0 0"], [pidStat(shell)])))).toBe(
      "line 3 does not read as the cpu line of /proc/stat, a /proc/<pid>/stat line or a /proc/<pid>/cmdline argument",
    );
  });

  test("process jiffies that went backwards are invalid, since proc(5)'s counters only grow", () => {
    expect(issueOf(decodeLinuxProcesses(sampled([pidStat({ ...shell, stime: 5 })], [pidStat(shell)])))).toBe(
      "process 40 has fewer cpu jiffies in the second sample than the first",
    );
  });

  test("no process in both samples is invalid, since the sampling shell itself lasts across them", () => {
    expect(issueOf(decodeLinuxProcesses(sampled([pidStat(shell)], [pidStat({ ...shell, pid: 41 })])))).toBe(
      "no process lasted across both /proc samples",
    );
  });
});
