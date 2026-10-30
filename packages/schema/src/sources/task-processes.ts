import { Context, DateTime, Duration, Layer, Option, Schema } from "effect";
import { type Decoded, decoded, decodeValue, flatMapDecoded, rejected } from "../decode";
import { runDecoded, sourceOf, stamped, type Source } from "../source";
import { nonEmptyLines } from "./lines";
import { macRusageReader } from "./mac-rusage-reader";
import { AmountText, CountText } from "./numerals";

export interface CountedProcess {
  // The same for one process in every sample of it, and never shared with another process.
  readonly identity: string;
  readonly pid: number;
  readonly parent: number;
  readonly startedAtMillis: number;
  readonly ownSeconds: number;
  readonly waitedChildSeconds: number;
}

export interface LiveProcess extends CountedProcess {
  readonly residentBytes: number;
  readonly folder: string | undefined;
}

// Each process started at or after its startedAtMillis and less than startPrecisionMillis later.
export interface ProcessSamples {
  readonly intervalSeconds: number;
  readonly startPrecisionMillis: number;
  readonly before: ReadonlyArray<CountedProcess>;
  readonly after: ReadonlyArray<LiveProcess>;
}

type Phase = "header" | "samples" | "folders";

interface RawSample {
  readonly at: string;
  readonly processes: Array<Record<string, string>>;
}

interface RawMacSample extends RawSample {
  readonly rusage: Array<Record<string, string>>;
  readonly unread: Array<string>;
}

interface RawFolder {
  readonly pid: string;
  folder?: string;
}

const intervalOf = (earlier: number, later: number): Decoded<number> =>
  later > earlier ? decoded(later - earlier) : rejected("the second sample is not later than the first");

const allDecoded = <A, B>(items: ReadonlyArray<A>, each: (item: A) => Decoded<B>): Decoded<ReadonlyArray<B>> => {
  const values: Array<B> = [];
  for (const item of items) {
    const value = each(item);
    if (value.kind !== "ok") return value;
    values.push(value.value);
  }
  return decoded(values);
};

const Folder = Schema.Struct({ pid: CountText, folder: Schema.String });

const PidStat = Schema.Struct({
  pid: CountText,
  ppid: CountText,
  utime: CountText,
  stime: CountText,
  cutime: CountText,
  cstime: CountText,
  starttime: CountText,
  rss: CountText,
});

// The sampling shell is itself a process with a readable folder, so an empty listing means its collector failed.
const LinuxSample = Schema.Struct({ at: AmountText, processes: Schema.Array(PidStat).check(Schema.isMinLength(1)) });

const LinuxSamples = Schema.Struct({
  pagesize: CountText.check(Schema.isGreaterThan(0)),
  ticks: CountText.check(Schema.isGreaterThan(0)),
  btime: CountText,
  boot: Schema.String,
  samples: Schema.Tuple([LinuxSample, LinuxSample]),
  folders: Schema.Array(Folder).check(Schema.isMinLength(1)),
});

// comm may hold spaces and parentheses, so it runs to the last ") " on the line.
const pidStatLine = /^(\S+) \(.*\) \S (\S+)(?: \S+){9} (\S+) (\S+) (\S+) (\S+)(?: \S+){4} (\S+) \S+ (\S+)(?: \S+)*$/;

const pidStatFieldsOf = (line: string): Record<string, string> | undefined => {
  const match = pidStatLine.exec(line);
  if (match === null) return undefined;
  const [pid, ppid, utime, stime, cutime, cstime, starttime, rss] = match.slice(1);
  return { pid, ppid, utime, stime, cutime, cstime, starttime, rss };
};

const linuxHeaderLine = /^(pagesize|ticks|btime|boot) (\S+)$/;

const uptimeLine = /^uptime (\S+)$/;

const linuxCwdLine = /^cwd \/proc\/(\S+) (.*)$/;

const groupLinux = (lines: ReadonlyArray<string>): Decoded<unknown> => {
  const header: Record<string, string> = {};
  const samples: Array<RawSample> = [];
  const folders: Array<RawFolder> = [];
  let phase: Phase = "header";
  for (const [index, line] of lines.entries()) {
    const heading = linuxHeaderLine.exec(line);
    const uptime = uptimeLine.exec(line);
    const process = pidStatFieldsOf(line);
    const cwd = linuxCwdLine.exec(line);
    if (heading !== null && phase === "header") header[heading[1]] = heading[2];
    else if (uptime !== null && phase !== "folders") {
      phase = "samples";
      samples.push({ at: uptime[1], processes: [] });
    } else if (process !== undefined && phase === "samples") samples.at(-1)?.processes.push(process);
    else if (cwd !== null && phase !== "header") {
      phase = "folders";
      if (cwd[2] !== "") folders.push({ pid: cwd[1], folder: cwd[2] });
    } else
      return rejected(
        "line " + String(index + 1) + " does not read as a page size, tick rate, boot time or boot id, an uptime, a /proc/<pid>/stat line or a /proc/<pid>/cwd link",
      );
  }
  return decoded({ ...header, samples, folders });
};

const linuxSamplesOf = ({
  pagesize,
  ticks,
  btime,
  boot,
  samples: [before, after],
  folders,
}: typeof LinuxSamples.Type): Decoded<ProcessSamples> => {
  const counted = (stat: typeof PidStat.Type): CountedProcess => ({
    // btime moves when the clock is stepped, so the identity holds the boot's id and the start in ticks since that boot.
    identity: boot + " " + String(stat.pid) + " " + String(stat.starttime),
    pid: stat.pid,
    parent: stat.ppid,
    startedAtMillis: btime * 1000 + (stat.starttime * 1000) / ticks,
    ownSeconds: (stat.utime + stat.stime) / ticks,
    waitedChildSeconds: (stat.cutime + stat.cstime) / ticks,
  });
  const folderByPid = new Map(folders.map(({ pid, folder }) => [pid, folder]));
  return flatMapDecoded(intervalOf(before.at, after.at), (intervalSeconds) =>
    decoded({
      intervalSeconds,
      // btime is whole seconds and starttime whole ticks, and each truncates.
      startPrecisionMillis: 1000 + 1000 / ticks,
      before: before.processes.map(counted),
      after: after.processes.map((stat) => ({
        ...counted(stat),
        residentBytes: stat.rss * pagesize,
        folder: folderByPid.get(stat.pid),
      })),
    }),
  );
};

export const decodeLinuxTaskProcesses = (stdout: string): Decoded<ProcessSamples> =>
  flatMapDecoded(groupLinux(nonEmptyLines(stdout)), (grouped) =>
    flatMapDecoded(decodeValue(LinuxSamples)(grouped), linuxSamplesOf),
  );

const CpuTime = Schema.String.check(Schema.isPattern(/^\d+:\d{2}\.\d{2}$/));

const MacRow = Schema.Struct({
  pid: CountText,
  ppid: CountText,
  rss: CountText,
  utime: CpuTime,
  stime: CpuTime,
  lstart: Schema.String,
});

const MacRusage = Schema.Struct({
  pid: CountText,
  own: AmountText,
  child: AmountText,
});

const MacSample = Schema.Struct({
  at: AmountText,
  processes: Schema.Array(MacRow).check(Schema.isMinLength(1)),
  rusage: Schema.Array(MacRusage),
  unread: Schema.Array(CountText),
});

const MacSamples = Schema.Struct({
  samples: Schema.Tuple([MacSample, MacSample]),
  folders: Schema.Array(Folder).check(Schema.isMinLength(1)),
});

const atLine = /^at (\S+)$/;

const rusageLine = /^rusage (\S+) (\S+) (\S+)$/;

const unreadLine = /^unread (\S+)$/;

const lstartText = "(\\S{3} \\S{3} +\\d{1,2} \\d{2}:\\d{2}:\\d{2} \\d{4})";

const psLine = new RegExp("^ *(\\S+) +(\\S+) +(\\S+) +(\\S+) +(\\S+) +" + lstartText + " *$");

const lsofLine = /^([pfn])(.*)$/;

// lsof -F prints one field per line, and each process opens with its p line.
const addLsofField = (folders: Array<RawFolder>, kind: string, value: string): void => {
  if (kind === "p") folders.push({ pid: value });
  const listed = folders.at(-1);
  if (kind === "n" && listed !== undefined) listed.folder = value;
};

const groupMac = (lines: ReadonlyArray<string>): Decoded<unknown> => {
  const samples: Array<RawMacSample> = [];
  const folders: Array<RawFolder> = [];
  let phase: Phase = "header";
  for (const [index, line] of lines.entries()) {
    const at = atLine.exec(line);
    const row = psLine.exec(line);
    const read = rusageLine.exec(line);
    const unread = unreadLine.exec(line);
    const field = lsofLine.exec(line);
    const sample = samples.at(-1);
    if (at !== null && phase !== "folders") {
      phase = "samples";
      samples.push({ at: at[1], processes: [], rusage: [], unread: [] });
    } else if (row !== null && phase === "samples") {
      const [pid, ppid, rss, utime, stime, lstart] = row.slice(1);
      sample?.processes.push({ pid, ppid, rss, utime, stime, lstart });
    } else if (read !== null && phase === "samples") {
      const [pid, own, child] = read.slice(1);
      sample?.rusage.push({ pid, own, child });
    } else if (unread !== null && phase === "samples") {
      sample?.unread.push(unread[1]);
    } else if (field !== null && phase !== "header") {
      phase = "folders";
      addLsofField(folders, field[1], field[2]);
    } else
      return rejected("line " + String(index + 1) + " does not read as a sample time, a ps row, a rusage line, an unread pid or an lsof field");
  }
  return decoded({ samples, folders: folders.filter((listed) => listed.folder !== undefined) });
};

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const lstartFields = /^\S{3} (\S{3}) +(\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/;

// ps runs under TZ=UTC, so the clock lstart shows is already UTC.
const lstartMillisOf = (lstart: string): number | undefined => {
  const match = lstartFields.exec(lstart);
  if (match === null) return undefined;
  const [month, day, clock, year] = match.slice(1);
  const index = months.indexOf(month);
  if (index === -1) return undefined;
  const iso = year + "-" + String(index + 1).padStart(2, "0") + "-" + day.padStart(2, "0") + "T" + clock + "Z";
  return Option.match(DateTime.make(iso), { onNone: () => undefined, onSome: DateTime.toEpochMillis });
};

const secondsOfCpuTime = (time: string): number => {
  const [minutes, seconds] = time.split(":");
  return Number(minutes) * 60 + Number(seconds);
};

const startOf = ({ pid, lstart }: typeof MacRow.Type): Decoded<number> => {
  const startedAtMillis = lstartMillisOf(lstart);
  return startedAtMillis === undefined
    ? rejected("process " + String(pid) + " has a start time that does not read as a date")
    : decoded(startedAtMillis);
};

type MacCounted = CountedProcess & { readonly rss: number };

// An unread process keeps the ps own time and no child time.
const macCountedOf = (row: typeof MacRow.Type, usage: ReadonlyMap<number, typeof MacRusage.Type>): Decoded<MacCounted> =>
  flatMapDecoded(startOf(row), (startedAtMillis) => {
    const read = usage.get(row.pid);
    return decoded({
      identity: String(row.pid) + " " + String(startedAtMillis),
      pid: row.pid,
      parent: row.ppid,
      startedAtMillis,
      ownSeconds: read?.own ?? secondsOfCpuTime(row.utime) + secondsOfCpuTime(row.stime),
      waitedChildSeconds: read?.child ?? 0,
      rss: row.rss,
    });
  });

const macSamplesOf = ({ samples: [before, after], folders }: typeof MacSamples.Type): Decoded<ProcessSamples> => {
  const folderByPid = new Map(folders.map(({ pid, folder }) => [pid, folder]));
  const live = ({ rss, ...process }: MacCounted): LiveProcess => ({
    ...process,
    residentBytes: rss * 1024,
    folder: folderByPid.get(process.pid),
  });
  const countedIn = (sample: typeof MacSample.Type): Decoded<ReadonlyArray<MacCounted>> => {
    const usage = new Map(sample.rusage.map((read) => [read.pid, read] as const));
    const unread = new Set(sample.unread);
    const running = sample.processes.filter((row) => usage.has(row.pid) || unread.has(row.pid));
    return allDecoded(running, (row) => macCountedOf(row, usage));
  };
  return flatMapDecoded(intervalOf(before.at, after.at), (intervalSeconds) =>
    flatMapDecoded(countedIn(before), (earlier) =>
      flatMapDecoded(countedIn(after), (counted) =>
        // lstart is whole seconds and truncates.
        decoded({
          intervalSeconds,
          startPrecisionMillis: 1000,
          before: earlier.map(({ rss, ...process }) => process),
          after: counted.map(live),
        }),
      ),
    ),
  );
};

export const decodeMacTaskProcesses = (stdout: string): Decoded<ProcessSamples> =>
  flatMapDecoded(groupMac(nonEmptyLines(stdout)), (grouped) =>
    flatMapDecoded(decodeValue(MacSamples)(grouped), macSamplesOf),
  );

// One readlink per process would fork hundreds of times, and cat or find fail the whole listing over one process that
// exits or whose cwd this user may not read, so the shell's own read and cd visit each process and skip those.
// A cwd since deleted prints an empty folder.
const linuxTaskProcessesCommand = {
  argv: [
    "sh",
    "-c",
    'set -e; printf "pagesize %s\\nticks %s\\n" "$(getconf PAGESIZE)" "$(getconf CLK_TCK)"; while read -r name value; do case "$name" in btime) printf "btime %s\\n" "$value";; esac; done < /proc/stat; read -r boot < /proc/sys/kernel/random/boot_id; printf "boot %s\\n" "$boot"; sample() { read -r up idle < /proc/uptime; printf "uptime %s\\n" "$up"; for stat in /proc/[0-9]*/stat; do if read -r line < "$stat"; then printf "%s\\n" "$line"; fi; done; }; sample; sleep 1; sample; for cwd in /proc/[0-9]*/cwd; do if cd -P "$cwd"; then printf "cwd %s %s\\n" "${cwd%/cwd}" "$PWD"; fi; done',
  ],
  timeout: Duration.seconds(5),
} as const;

// macOS ps takes the rest of an -o list after "=" as its header, so each column takes its own -o.
// sh has no clock finer than a second, so zsh stamps each sample.
// macOS ps ignores -S, so each sample also reads proc_pid_rusage for the own and waited-for children's time ps never prints.
// A user service's PATH may hold no bun, so the reader runs under the interpreter running this.
const macTaskProcessesCommand = {
  argv: [
    "zsh",
    "-c",
    'setopt err_exit; zmodload zsh/datetime; reader=$1; sample() { print -r -- "at $EPOCHREALTIME"; TZ=UTC LC_ALL=C ps -A -o pid= -o ppid= -o rss= -o utime= -o stime= -o lstart=; "$reader" -e "' +
      macRusageReader +
      '" ${=$(ps -A -o pid= -o ppid=)}; }; sample; sleep 1; sample; lsof -a -d cwd -F pn',
    "zsh",
    process.execPath,
  ],
  timeout: Duration.seconds(5),
} as const;

export class TaskProcessesSource extends Context.Service<TaskProcessesSource, Source<ProcessSamples>>()(
  "tui-dash/TaskProcessesSource",
) {}

export const linuxTaskProcessesSourceLayer = Layer.effect(
  TaskProcessesSource,
  sourceOf(stamped(runDecoded(linuxTaskProcessesCommand, decodeLinuxTaskProcesses))),
);

export const macTaskProcessesSourceLayer = Layer.effect(
  TaskProcessesSource,
  sourceOf(stamped(runDecoded(macTaskProcessesCommand, decodeMacTaskProcesses))),
);
