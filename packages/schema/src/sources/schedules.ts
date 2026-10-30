import { Context, DateTime, Duration, Effect, Layer, Option, Result, Schema } from "effect";
import { CommandRunner } from "../command";
import { type Decoded, decoded, decodeJson, decodeValue, flatMapDecoded, recordLines, rejected } from "../decode";
import { mapOutcome, ok, type Outcome } from "../reading";
import { runDecoded } from "../source";
import { type CalendarPattern, cronPattern, everyValue } from "../views/calendar";
import type { RepoFailure } from "./ci-runs";
import { RunnerRepos } from "./runners";

export interface TimerSchedule {
  readonly kind: "timer";
  readonly name: string;
  readonly next: DateTime.Utc | undefined;
}

export interface AgentSchedule {
  readonly kind: "agent";
  readonly name: string;
  readonly calendar: ReadonlyArray<CalendarPattern>;
  readonly everySeconds: number | undefined;
}

export interface CronSchedule {
  readonly kind: "CI";
  readonly name: string;
  readonly repo: string;
  // Undefined when GitHub's cron line uses syntax this reader does not follow, so the line shows without a time.
  readonly pattern: CalendarPattern | undefined;
}

export type MachineSchedule = TimerSchedule | AgentSchedule | CronSchedule;

export type ScheduleSource = MachineSchedule["kind"];

export interface ScheduleRead {
  readonly source: ScheduleSource;
  readonly outcome: Outcome<ReadonlyArray<MachineSchedule>>;
  readonly unread: ReadonlyArray<RepoFailure>;
}

const TimerJson = Schema.Struct({ unit: Schema.String, next: Schema.optionalKey(Schema.NullOr(Schema.Finite)) });

const microsPerMilli = 1000;

const timerName = (unit: string): string => unit.replace(/\.timer$/u, "");

// systemd reports a timer with no next elapse as 0 or leaves the field out.
const timerOf = (timer: typeof TimerJson.Type): TimerSchedule => ({
  kind: "timer",
  name: timerName(timer.unit),
  next: timer.next === undefined || timer.next === null || timer.next <= 0 ? undefined : DateTime.makeUnsafe(Math.floor(timer.next / microsPerMilli)),
});

export const decodeTimers = (stdout: string): Decoded<ReadonlyArray<TimerSchedule>> =>
  flatMapDecoded(decodeJson(Schema.Array(TimerJson))(stdout), (timers) => decoded(timers.map(timerOf)));

const CalendarJson = Schema.Struct({
  Minute: Schema.optionalKey(Schema.Int),
  Hour: Schema.optionalKey(Schema.Int),
  Day: Schema.optionalKey(Schema.Int),
  Weekday: Schema.optionalKey(Schema.Int),
  Month: Schema.optionalKey(Schema.Int),
});

const AgentJson = Schema.Struct({
  Label: Schema.String,
  Disabled: Schema.optionalKey(Schema.Boolean),
  StartInterval: Schema.optionalKey(Schema.Int),
  StartCalendarInterval: Schema.optionalKey(Schema.Union([CalendarJson, Schema.Array(CalendarJson)])),
});

const only = (value: number | undefined, least: number, most: number): ReadonlySet<number> =>
  value === undefined ? everyValue(least, most) : new Set([value]);

// launchd reads a key a calendar interval leaves out as every value, and 7 as Sunday, as cron does.
const calendarOf = (calendar: typeof CalendarJson.Type): CalendarPattern => ({
  minutes: only(calendar.Minute, 0, 59),
  hours: only(calendar.Hour, 0, 23),
  days: only(calendar.Day, 1, 31),
  months: only(calendar.Month, 1, 12),
  weekDays: only(calendar.Weekday === undefined ? undefined : calendar.Weekday % 7, 0, 6),
  dayRule: calendar.Day !== undefined && calendar.Weekday !== undefined ? "either" : "both",
});

const isList = <A extends object>(value: A | ReadonlyArray<A>): value is ReadonlyArray<A> => Array.isArray(value);

const agentOf = (agent: typeof AgentJson.Type): ReadonlyArray<AgentSchedule> => {
  const intervals = agent.StartCalendarInterval;
  const calendar = intervals === undefined ? [] : (isList(intervals) ? intervals : [intervals]).map(calendarOf);
  if (agent.Disabled === true || (calendar.length === 0 && agent.StartInterval === undefined)) return [];
  return [{ kind: "agent", name: agent.Label, calendar, everySeconds: agent.StartInterval }];
};

const agentLines = recordLines(AgentJson);

export const decodeAgents = (stdout: string): Decoded<ReadonlyArray<AgentSchedule>> => decoded(agentLines(stdout).flatMap(agentOf));

const WorkflowsJson = Schema.Struct({
  workflows: Schema.Array(Schema.Struct({ path: Schema.String, state: Schema.String })),
});

const FolderJson = Schema.Array(Schema.Struct({ path: Schema.String, type: Schema.String }));

const ContentJson = Schema.Struct({ content: Schema.String, encoding: Schema.Literal("base64") });

const CronJson = Schema.Struct({ cron: Schema.String });

const WorkflowYaml = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  on: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Array(Schema.String), Schema.Struct({ schedule: Schema.optionalKey(Schema.NullOr(Schema.Array(CronJson))) })]),
  ),
});

const workflowFile = /\.ya?ml$/u;

export const decodeWorkflowFolder = (stdout: string): Decoded<ReadonlyArray<string>> =>
  flatMapDecoded(decodeJson(FolderJson)(stdout), (entries) =>
    decoded(entries.filter((entry) => entry.type === "file" && workflowFile.test(entry.path)).map((entry) => entry.path)),
  );

export const decodeInactiveWorkflows = (stdout: string): Decoded<ReadonlySet<string>> =>
  flatMapDecoded(decodeJson(WorkflowsJson)(stdout), ({ workflows }) =>
    decoded(new Set(workflows.filter((workflow) => workflow.state !== "active").map((workflow) => workflow.path))),
  );

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.ya?ml$/u, "");

export const decodeWorkflowCrons =
  (repo: string, path: string) =>
  (stdout: string): Decoded<ReadonlyArray<CronSchedule>> =>
    flatMapDecoded(decodeJson(ContentJson)(stdout), ({ content }) => {
      const parsed = Result.try((): unknown => Bun.YAML.parse(Buffer.from(content, "base64").toString("utf8")));
      if (Result.isFailure(parsed)) return rejected(`${path} is not YAML`);
      return flatMapDecoded(decodeValue(WorkflowYaml)(parsed.success), (workflow) => {
        const on = workflow.on;
        const crons = on !== undefined && typeof on === "object" && "schedule" in on ? (on.schedule ?? []) : [];
        return decoded(crons.map((line): CronSchedule => ({ kind: "CI", name: workflow.name ?? fileName(path), repo, pattern: cronPattern(line.cron) })));
      });
    });

const commandTimeout = Duration.seconds(20);

const timersCommand = {
  argv: ["systemctl", "--user", "list-timers", "--all", "--output=json", "--no-pager"],
  timeout: Duration.seconds(10),
} as const;

const agentsScript = 'for f in "$HOME"/Library/LaunchAgents/*.plist; do [ -e "$f" ] && plutil -convert json -o - -- "$f" 2>/dev/null && echo; done; true';

const agentsCommand = { argv: ["sh", "-c", agentsScript], timeout: commandTimeout } as const;

const workflowsCommand = (repo: string) => ({ argv: ["gh", "api", `repos/${repo}/actions/workflows?per_page=100`], timeout: commandTimeout }) as const;

const folderCommand = (repo: string) => ({ argv: ["gh", "api", `repos/${repo}/contents/.github/workflows`], timeout: commandTimeout }) as const;

const contentCommand = (repo: string, path: string) => ({ argv: ["gh", "api", `repos/${repo}/contents/${path}`], timeout: commandTimeout }) as const;

const filesAtOnce = 8;

interface RepoCrons {
  readonly repo: string;
  readonly crons: Outcome<ReadonlyArray<CronSchedule>>;
}

// GitHub runs a schedule only from the default branch, and lists a workflow first pushed on another branch that the default branch may lack.
const repoCrons = (repo: string): Effect.Effect<RepoCrons, never, CommandRunner> =>
  Effect.gen(function* () {
    const [folder, inactive] = yield* Effect.all([runDecoded(folderCommand(repo), decodeWorkflowFolder), runDecoded(workflowsCommand(repo), decodeInactiveWorkflows)], {
      concurrency: "unbounded",
    });
    if (folder.kind !== "ok") return { repo, crons: folder };
    if (inactive.kind !== "ok") return { repo, crons: inactive };
    const paths = folder.value.filter((path) => !inactive.value.has(path));
    const files = yield* Effect.forEach(paths, (path) => runDecoded(contentCommand(repo, path), decodeWorkflowCrons(repo, path)), { concurrency: filesAtOnce });
    const failed = files.find((file) => file.kind !== "ok");
    return { repo, crons: failed ?? ok(files.flatMap((file) => (file.kind === "ok" ? file.value : []))) };
  });

// One repository that does not answer leaves the others' schedules standing, and says which it is.
export const cronRead = (repos: ReadonlyArray<RepoCrons>): ScheduleRead => ({
  source: "CI",
  outcome: ok(repos.flatMap(({ crons }) => (crons.kind === "ok" ? crons.value : []))),
  unread: repos.flatMap(({ repo, crons }) => (crons.kind === "ok" ? [] : [{ repo, failure: crons }])),
});

export interface MachineSchedulesReading {
  readonly read: Effect.Effect<ReadonlyArray<ScheduleRead>>;
}

export class MachineSchedules extends Context.Service<MachineSchedules, MachineSchedulesReading>()("tui-dash/MachineSchedules") {}

// A workflow file changes far less often than once an hour, and reading every file of every repository costs dozens of GitHub calls.
const reuseCronsFor = Duration.hours(1);

// A repository that keeps failing would otherwise cost its calls on every paint, against the hourly limit the CI runs share.
const retryCronsAfter = Duration.minutes(1);

const keptFor = (crons: RepoCrons["crons"]): Duration.Duration => (crons.kind === "ok" ? reuseCronsFor : retryCronsAfter);

const reusedEachRepo = <R>(read: (repo: string) => Effect.Effect<RepoCrons, never, R>): Effect.Effect<(repo: string) => Effect.Effect<RepoCrons, never, R>> =>
  Effect.sync(() => {
    const kept = new Map<string, { readonly at: number; readonly crons: RepoCrons }>();
    return (repo) =>
      Effect.gen(function* () {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const last = kept.get(repo);
        if (last !== undefined && now - last.at < Duration.toMillis(keptFor(last.crons.crons))) return last.crons;
        const crons = yield* read(repo);
        kept.set(repo, { at: now, crons });
        return crons;
      });
  });

export type ScheduleHost = "linux" | "mac";

export const machineSchedulesLayer = (host: ScheduleHost): Layer.Layer<MachineSchedules, never, CommandRunner | RunnerRepos> =>
  Layer.effect(
    MachineSchedules,
    Effect.gen(function* () {
      const runner = yield* CommandRunner;
      const repos = yield* RunnerRepos;
      const machine: Effect.Effect<ScheduleRead, never, CommandRunner> =
        host === "linux"
          ? Effect.map(runDecoded(timersCommand, decodeTimers), (outcome) => ({ source: "timer", outcome, unread: [] }))
          : Effect.map(runDecoded(agentsCommand, decodeAgents), (outcome) => ({ source: "agent", outcome, unread: [] }));
      const eachRepo = yield* reusedEachRepo((repo) => Effect.provideService(repoCrons(repo), CommandRunner, runner));
      const crons = Option.match(repos, {
        onNone: () => Effect.succeed<ReadonlyArray<ScheduleRead>>([]),
        onSome: (listing) =>
          Effect.gen(function* () {
            const read = yield* listing.read;
            if (read.kind !== "ok") return [{ source: "CI" as const, outcome: mapOutcome(read, () => []), unread: [] }];
            return [cronRead(yield* Effect.forEach(read.value, eachRepo, { concurrency: "unbounded" }))];
          }),
      });
      return {
        read: Effect.map(Effect.all([Effect.provideService(machine, CommandRunner, runner), crons], { concurrency: "unbounded" }), ([own, ci]) => [own, ...ci]),
      };
    }),
  );
