import { Context, Duration, Effect, Layer, Schema } from "effect";
import { type Decoded, decoded, decodeValue, flatMapDecoded, rejected } from "../decode";
import { runDecoded, type Source } from "../source";
import { hostSource, LoadAverage, probe } from "./host";
import { nonEmptyLines, splitEach } from "./lines";
import { CountText } from "./numerals";

const CpuCount = CountText.check(Schema.isGreaterThan(0));

const MemInfo = Schema.Struct({ MemTotal: CountText, MemFree: CountText, MemAvailable: CountText });

export type LinuxMemInfo = typeof MemInfo.Type;

export const CpuSample = Schema.Struct({
  user: CountText,
  nice: CountText,
  system: CountText,
  idle: CountText,
  iowait: CountText,
  irq: CountText,
  softirq: CountText,
  steal: CountText,
});

const CpuSamples = Schema.Tuple([CpuSample, CpuSample]);

export interface CpuUsage {
  readonly busyJiffies: number;
  readonly totalJiffies: number;
}

export interface LinuxHost {
  readonly load: typeof LoadAverage.Type;
  readonly cpuCount: number;
  readonly cpuUsage: CpuUsage;
  readonly memory: LinuxMemInfo;
  readonly arcReclaimableBytes: number;
}

const loadavgLine = /^(\S+) (\S+) (\S+) \d+\/\d+ \d+$/;

export const decodeLoadavg = (stdout: string): Decoded<typeof LoadAverage.Type> => {
  const match = loadavgLine.exec(stdout.trim());
  return match === null ? rejected("/proc/loadavg does not read as 1m 5m 15m runnable/total pid") : decodeValue(LoadAverage)(match.slice(1));
};

export const decodeOnlineCpus = (stdout: string): Decoded<number> => decodeValue(CpuCount)(stdout.trim());

const cpuLine = /^cpu +(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) \d+ \d+$/;

export const cpuFieldsOf = (line: string): Record<string, string> | undefined => {
  const match = cpuLine.exec(line);
  if (match === null) return undefined;
  const [user, nice, system, idle, iowait, irq, softirq, steal] = match.slice(1);
  return { user, nice, system, idle, iowait, irq, softirq, steal };
};

// The kernel adds guest and guest_nice time to user and nice as well, so summing them would count it twice.
const jiffiesOf = ({ user, nice, system, idle, iowait, irq, softirq, steal }: typeof CpuSample.Type): CpuUsage => {
  const busyJiffies = user + nice + system + irq + softirq + steal;
  return { busyJiffies, totalJiffies: busyJiffies + idle + iowait };
};

export const cpuUsageBetween = (first: typeof CpuSample.Type, second: typeof CpuSample.Type): Decoded<CpuUsage> => {
  const before = jiffiesOf(first);
  const after = jiffiesOf(second);
  const busyJiffies = after.busyJiffies - before.busyJiffies;
  const totalJiffies = after.totalJiffies - before.totalJiffies;
  return totalJiffies > 0 && busyJiffies >= 0 && busyJiffies <= totalJiffies
    ? decoded({ busyJiffies, totalJiffies })
    : rejected("the second /proc/stat sample does not follow the first");
};

export const decodeCpuUsage = (stdout: string): Decoded<CpuUsage> =>
  flatMapDecoded(splitEach(nonEmptyLines(stdout), "the cpu line of /proc/stat", cpuFieldsOf), (lines) =>
    flatMapDecoded(decodeValue(CpuSamples)(lines), ([before, after]) => cpuUsageBetween(before, after)),
  );

const meminfoLine = /^(\w+):\s+(\S+) kB$/;

export const decodeMeminfo = (stdout: string): Decoded<LinuxMemInfo> => {
  const fields: Record<string, string> = {};
  for (const line of nonEmptyLines(stdout)) {
    const match = meminfoLine.exec(line);
    if (match !== null) fields[match[1]] = match[2];
  }
  return decodeValue(MemInfo)(fields);
};

const loadavgCommand = { argv: ["cat", "/proc/loadavg"], timeout: Duration.seconds(10) } as const;
const onlineCpusCommand = { argv: ["getconf", "_NPROCESSORS_ONLN"], timeout: Duration.seconds(10) } as const;
// /proc/stat counts jiffies since boot, so the utilization now is the difference between two samples.
const cpuStatCommand = {
  argv: ["sh", "-c", "head -n 1 /proc/stat && sleep 1 && head -n 1 /proc/stat"],
  timeout: Duration.seconds(10),
} as const;
const meminfoCommand = { argv: ["cat", "/proc/meminfo"], timeout: Duration.seconds(10) } as const;

const ArcStats = Schema.Struct({ cMin: CountText, size: CountText });

const arcLine = /^(c_min|size)\s+\S+\s+(\S+)\s*$/;

export const decodeArcStats = (stdout: string): Decoded<number> => {
  const fields: Record<string, string> = {};
  for (const line of nonEmptyLines(stdout)) {
    const match = arcLine.exec(line);
    if (match !== null) fields[match[1] === "c_min" ? "cMin" : "size"] = match[2];
  }
  return flatMapDecoded(decodeValue(ArcStats)(fields), ({ cMin, size }) => decoded(Math.max(0, size - cMin)));
};

const arcStatsCommand = {
  argv: ["cat", "/proc/spl/kstat/zfs/arcstats"],
  timeout: Duration.seconds(10),
} as const;

// Without ZFS the file is missing, so any failure reads as no reclaimable cache rather than no host.
const arcReclaimableBytes = runDecoded(arcStatsCommand, decodeArcStats).pipe(
  Effect.map((outcome) => (outcome.kind === "ok" ? outcome.value : 0)),
);

export class LinuxHostSource extends Context.Service<LinuxHostSource, Source<LinuxHost>>()(
  "tui-dash/LinuxHostSource",
) {}

export const linuxHostSourceLayer = Layer.effect(
  LinuxHostSource,
  hostSource(
    Effect.all(
      {
        load: probe(loadavgCommand, decodeLoadavg),
        cpuCount: probe(onlineCpusCommand, decodeOnlineCpus),
        cpuUsage: probe(cpuStatCommand, decodeCpuUsage),
        memory: probe(meminfoCommand, decodeMeminfo),
        arcReclaimableBytes,
      },
      { concurrency: "unbounded" },
    ),
  ),
);
