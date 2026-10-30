import { Context, Duration, Effect, Layer, Schema } from "effect";
import { type Decoded, decoded, decodeValue, flatMapDecoded, rejected } from "../decode";
import type { Source } from "../source";
import { hostSource, LoadAverage, probe } from "./host";
import { nonEmptyLines, splitEach } from "./lines";
import { AmountText, CountText } from "./numerals";

const Sysctl = Schema.Struct({ cpuCount: CountText, memoryBytes: CountText, load: LoadAverage });

const VmStat = Schema.Struct({
  pageSizeBytes: CountText,
  "Pages active": CountText,
  "Pages wired down": CountText,
  "Pages speculative": CountText,
  "Pages occupied by compressor": CountText,
});

export type MacSysctl = typeof Sysctl.Type;
export type MacVmStat = typeof VmStat.Type;

export interface MacTopCpu {
  readonly totalPercent: number;
  readonly cpuByPid: ReadonlyMap<number, number>;
}

export interface MacHost {
  readonly sysctl: MacSysctl;
  readonly vmStat: MacVmStat;
  readonly top: MacTopCpu;
}

const loadAverages = /^\{ (\S+) (\S+) (\S+) \}$/;

export const decodeSysctl = (stdout: string): Decoded<MacSysctl> => {
  const lines = nonEmptyLines(stdout);
  if (lines.length !== 3) return rejected(`expected 3 lines of hw.ncpu, hw.memsize and vm.loadavg, got ${lines.length}`);
  const [cpuCount, memoryBytes, load] = lines;
  const averages = loadAverages.exec(load);
  if (averages === null) return rejected("vm.loadavg does not read as { 1m 5m 15m }");
  return decodeValue(Sysctl)({ cpuCount, memoryBytes, load: averages.slice(1) });
};

const pageSize = /\(page size of (\S+) bytes\)/;
const counter = /^"?([^":]+)"?:\s+(\S+)\.$/;

const splitCounter = (row: string) => {
  const match = counter.exec(row);
  return match === null ? undefined : ([match[1], match[2]] as const);
};

export const decodeVmStat = (stdout: string): Decoded<MacVmStat> => {
  const [header = "", ...rows] = nonEmptyLines(stdout);
  const size = pageSize.exec(header);
  if (size === null) return rejected("the vm_stat header names no page size");
  return flatMapDecoded(splitEach(rows, "a counter and its count", splitCounter), (counters) =>
    decodeValue(VmStat)({ ...Object.fromEntries(counters), pageSizeBytes: size[1] }),
  );
};

const TopCpu = Schema.Struct({
  user: AmountText,
  sys: AmountText,
  idle: AmountText,
  rows: Schema.Array(Schema.Struct({ pid: CountText, cpu: AmountText })),
});

const cpuUsageLine = /CPU usage:\s*(\S+)% user,\s*(\S+)% sys,\s*(\S+)% idle/;
const topHeader = /^PID\s+COMMAND\s+%CPU\s*$/;
const topRow = /^\s*(\d+)\s+(.*?)\s*(\d+\.\d+)\s*$/;

const splitTopRow = (line: string) => {
  const match = topRow.exec(line);
  return match === null ? undefined : { pid: match[1], cpu: match[3] };
};

// top prints one frame per sample, so the last cpu line and the last table hold the recent delta.
export const decodeTopCpu = (stdout: string): Decoded<MacTopCpu> => {
  const lines = nonEmptyLines(stdout);
  const usages = lines.flatMap((line) => {
    const match = cpuUsageLine.exec(line);
    return match === null ? [] : [{ user: match[1], sys: match[2], idle: match[3] }];
  });
  const usage = usages.at(-1);
  if (usage === undefined) return rejected("top output holds no cpu usage line");
  const header = lines.findLastIndex((line) => topHeader.test(line));
  if (header === -1) return rejected("top output holds no pid, command and cpu table");
  return flatMapDecoded(splitEach(lines.slice(header + 1), "pid, command and cpu", splitTopRow), (rows) =>
    flatMapDecoded(decodeValue(TopCpu)({ ...usage, rows }), ({ user, sys, idle, rows: shares }) => {
      const total = user + sys + idle;
      return decoded({
        totalPercent: total > 0 ? ((user + sys) / total) * 100 : 0,
        cpuByPid: new Map(shares.map(({ pid, cpu }) => [pid, cpu] as const)),
      });
    }),
  );
};

const sysctlCommand = {
  argv: ["sysctl", "-n", "hw.ncpu", "hw.memsize", "vm.loadavg"],
  timeout: Duration.seconds(5),
} as const;

const vmStatCommand = { argv: ["vm_stat"], timeout: Duration.seconds(5) } as const;

const topCommand = {
  argv: ["top", "-l", "2", "-s", "1", "-stats", "pid,command,cpu"],
  timeout: Duration.seconds(15),
} as const;

export class MacHostSource extends Context.Service<MacHostSource, Source<MacHost>>()("tui-dash/MacHostSource") {}

export const macHostSourceLayer = Layer.effect(
  MacHostSource,
  hostSource(
    Effect.all(
      {
        sysctl: probe(sysctlCommand, decodeSysctl),
        vmStat: probe(vmStatCommand, decodeVmStat),
        top: probe(topCommand, decodeTopCpu),
      },
      { concurrency: "unbounded" },
    ),
  ),
);
