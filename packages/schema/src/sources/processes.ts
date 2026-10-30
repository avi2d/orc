import { Context, Duration, Layer, Schema } from "effect";
import { type Decoded, decoded, decodeValue, flatMapDecoded, rejected } from "../decode";
import { runDecoded, sourceOf, stamped, type Source } from "../source";
import { nonEmptyLines, splitEach } from "./lines";
import { AmountText, CountText } from "./numerals";
import { cpuFieldsOf, CpuSample, cpuUsageBetween } from "./linux-host";

const ProcessRow = Schema.Struct({
  pid: CountText,
  command: Schema.String,
  cpuPercent: AmountText,
  residentKiB: CountText,
});

const ProcessTable = Schema.NonEmptyArray(ProcessRow);

export type ProcessRow = typeof ProcessRow.Type;

const columns = /^ *(\S+) +(\S+) +(\S+) (.+?) *$/;

const splitRow = (line: string) => {
  const match = columns.exec(line);
  return match === null ? undefined : { pid: match[1], cpuPercent: match[2], residentKiB: match[3], command: match[4] };
};

export const decodeProcesses = (stdout: string): Decoded<ReadonlyArray<ProcessRow>> =>
  flatMapDecoded(splitEach(nonEmptyLines(stdout), "pid, cpu, rss and command", splitRow), decodeValue(ProcessTable));

const PidStat = Schema.Struct({
  pid: CountText,
  comm: Schema.String,
  utime: CountText,
  stime: CountText,
  starttime: CountText,
  rss: CountText,
});

type PidStat = typeof PidStat.Type;

const ProgramName = Schema.Struct({
  pid: CountText,
  name: Schema.String,
});

const ProcSample = Schema.Struct({ cpu: CpuSample, processes: Schema.Array(PidStat) });

const ProcSamples = Schema.Struct({
  pageBytes: CountText.check(Schema.isGreaterThan(0)),
  samples: Schema.Tuple([ProcSample, ProcSample]),
  names: Schema.Array(ProgramName),
});

// comm may hold spaces and parentheses, so it runs to the last ") " on the line.
const pidStatLine = /^(\S+) \((.*)\) \S(?: \S+){10} (\S+) (\S+)(?: \S+){6} (\S+) \S+ (\S+)(?: \S+)*$/;

const pidStatFieldsOf = (line: string): Record<string, string> | undefined => {
  const match = pidStatLine.exec(line);
  if (match === null) return undefined;
  const [pid, comm, utime, stime, starttime, rss] = match.slice(1);
  return { pid, comm, utime, stime, starttime, rss };
};

const nameLine = /^name (\S+) (.+)$/;

const nameFieldsOf = (line: string): Record<string, string> | undefined => {
  const match = nameLine.exec(line);
  if (match === null) return undefined;
  const [pid, name] = match.slice(1);
  return { pid, name };
};

interface RawSample {
  readonly cpu: Record<string, string>;
  readonly processes: Array<Record<string, string>>;
}

const groupSamples = (lines: ReadonlyArray<string>): Decoded<unknown> => {
  const [pageBytes, ...rest] = lines;
  const samples: Array<RawSample> = [];
  const names: Array<Record<string, string>> = [];
  for (const [index, line] of rest.entries()) {
    const cpu = cpuFieldsOf(line);
    const process = pidStatFieldsOf(line);
    const name = nameFieldsOf(line);
    const current = samples.at(-1);
    if (cpu !== undefined) samples.push({ cpu, processes: [] });
    else if (process !== undefined && current !== undefined) current.processes.push(process);
    else if (name !== undefined && current !== undefined) names.push(name);
    else
      return rejected(
        `line ${index + 2} does not read as the cpu line of /proc/stat, a /proc/<pid>/stat line or a /proc/<pid>/cmdline argument`,
      );
  }
  return decoded({ pageBytes, samples, names });
};

const cpuJiffiesOf = ({ utime, stime }: PidStat): number => utime + stime;

// A pid can be reused between the samples, so only a matching start time makes it the same process.
const identityOf = ({ pid, starttime }: PidStat): string => `${pid} ${starttime}`;

const cpuShares = ({
  pageBytes,
  samples: [before, after],
  names,
}: typeof ProcSamples.Type): Decoded<ReadonlyArray<ProcessRow>> =>
  flatMapDecoded(cpuUsageBetween(before.cpu, after.cpu), ({ totalJiffies }) => {
    const earlier = new Map(before.processes.map((process) => [identityOf(process), process]));
    const fullNames = new Map(names.map(({ pid, name }) => [pid, name]));
    const rows: Array<ProcessRow> = [];
    for (const process of after.processes) {
      const first = earlier.get(identityOf(process));
      if (first === undefined) continue;
      const cpuJiffies = cpuJiffiesOf(process) - cpuJiffiesOf(first);
      if (cpuJiffies < 0) return rejected(`process ${process.pid} has fewer cpu jiffies in the second sample than the first`);
      rows.push({
        pid: process.pid,
        command: fullNames.get(process.pid) ?? process.comm,
        cpuPercent: (cpuJiffies / totalJiffies) * 100,
        residentKiB: (process.rss * pageBytes) / 1024,
      });
    }
    return rows.length > 0 ? decoded(rows) : rejected("no process lasted across both /proc samples");
  });

export const decodeLinuxProcesses = (stdout: string): Decoded<ReadonlyArray<ProcessRow>> =>
  flatMapDecoded(groupSamples(nonEmptyLines(stdout)), (samples) =>
    flatMapDecoded(decodeValue(ProcSamples)(samples), cpuShares),
  );

const macProcessesCommand = {
  argv: ["ps", "-A", "-o", "pid=", "-o", "%cpu=", "-o", "rss=", "-o", "comm="],
  timeout: Duration.seconds(10),
} as const;

// Linux ps reports %cpu averaged over a process's whole life, so the cpu now is the jiffy difference between two samples.
// A process can exit between the glob and its read, which fails cat without spoiling the rest of the sample.
// Only a 15-character comm may be cut, so only those pids pay for a cmdline read.
// A cut comm takes argv0's base name when that continues comm, else the base name of the script a shebang ran.
// That script is argv1, or argv2 behind one option, and names the program only as a path with no whitespace, so a -c payload or an operand never does.
// A newline inside an argument reads as a space, so each line stays one whole argument.
export const linuxProcessesCommand = {
  argv: [
    "sh",
    "-c",
    "sample() { head -n 1 /proc/stat; stats=$(cat /proc/[0-9]*/stat 2>/dev/null || true); printf \"%s\\n\" \"$stats\"; }; names() { printf \"%s\\n\" \"$stats\" | while IFS= read -r line; do pid=${line%% *}; rest=${line#*(}; comm=${rest%)*}; if [ \"${#comm}\" -eq 15 ]; then cat /proc/\"$pid\"/cmdline 2>/dev/null | tr \"\\n\\0\" \" \\n\" | head -n 3 | { IFS= read -r argv0; IFS= read -r script; case \"$script\" in -*) IFS= read -r script;; esac; name=; case \"${argv0##*/}\" in \"$comm\"*) name=${argv0##*/};; *) case \"$script\" in -* | *[[:space:]]*) ;; */*) case \"${script##*/}\" in \"$comm\"*) name=${script##*/};; esac;; esac;; esac; if [ -n \"$name\" ]; then printf \"name %s %s\\n\" \"$pid\" \"$name\"; fi; }; fi; done; }; getconf PAGESIZE && sample && sleep 1 && sample && names",
  ],
  timeout: Duration.seconds(10),
} as const;

export class MacProcessesSource extends Context.Service<MacProcessesSource, Source<ReadonlyArray<ProcessRow>>>()(
  "tui-dash/MacProcessesSource",
) {}

export class LinuxProcessesSource extends Context.Service<LinuxProcessesSource, Source<ReadonlyArray<ProcessRow>>>()(
  "tui-dash/LinuxProcessesSource",
) {}

export const macProcessesSourceLayer = Layer.effect(
  MacProcessesSource,
  sourceOf(stamped(runDecoded(macProcessesCommand, decodeProcesses))),
);

export const linuxProcessesSourceLayer = Layer.effect(
  LinuxProcessesSource,
  sourceOf(stamped(runDecoded(linuxProcessesCommand, decodeLinuxProcesses))),
);
