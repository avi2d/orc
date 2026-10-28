import { Schema } from "effect";
import { outcomeOf } from "../contract/outcome";
import type { Reading } from "../reading";
import { ActionRun } from "../sources/actions";
import type { CiReport } from "../sources/ci-runs";
import { PueueStatus } from "../sources/pueue";
import { QuotaAvailability, QuotaProviderState, QuotaWindow, shownQuotaProviders } from "../sources/quota";
import type { QueueReadings } from "../views/queues";
import type { QuotaBlock } from "../views/quotas";
import type { MachinesView } from "../views/resources";
import type { SessionQuotaView } from "../views/session-quota";

const Failed = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unreachable"), reason: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("invalid"), issue: Schema.String }),
]);

const Instant = Schema.DateTimeUtc;

const Provider = Schema.Literals(shownQuotaProviders);

const AccountJoin = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("credential-key"), key: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("only-account") }),
  Schema.Struct({ kind: Schema.Literal("default-account") }),
]);

const harvested = { kind: Schema.Literal("harvested"), observedAt: Instant, file: Schema.String, join: AccountJoin };

const WindowSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("quota-axi"), readAt: Instant }),
  Schema.Struct({ ...harvested, harness: Schema.Literal("codex"), via: Schema.Literal("log") }),
  Schema.Struct({ ...harvested, harness: Schema.Literal("claude-code"), via: Schema.Literals(["log", "statusline", "headless"]) }),
]);

const [ShownWindow, SharedWindow] = QuotaWindow.members;

const SourcedWindow = Schema.Union([
  Schema.Struct({ ...ShownWindow.fields, source: WindowSource }),
  Schema.Struct({ ...SharedWindow.fields, source: WindowSource }),
]);

export const QuotaBlocksCodec: Schema.Codec<ReadonlyArray<QuotaBlock>, unknown> = Schema.Array(
  Schema.Struct({
    provider: Provider,
    title: Schema.String,
    body: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("live"),
        plan: Schema.UndefinedOr(Schema.String),
        reportedAt: Instant,
        state: QuotaProviderState,
        windows: Schema.Array(SourcedWindow),
        exhaustion: Schema.Array(QuotaAvailability),
      }),
      Schema.Struct({
        kind: Schema.Literal("saved"),
        plan: Schema.NullOr(Schema.String),
        stale: Schema.Boolean,
        age: Schema.Union([
          Schema.Struct({ kind: Schema.Literal("dated"), fetchedAt: Instant, ageSeconds: Schema.Finite }),
          Schema.Struct({ kind: Schema.Literal("undated") }),
        ]),
        windows: Schema.Array(Schema.Struct({ label: Schema.String, percentLeft: Schema.Finite, resetsAt: Schema.NullOr(Instant) })),
      }),
      Schema.Struct({ kind: Schema.Literal("absent") }),
      Schema.Struct({ kind: Schema.Literal("unread") }),
      ...Failed.members,
    ]),
  }),
);

const Tokens = Schema.Struct({ input: Schema.Finite, output: Schema.Finite, cacheRead: Schema.Finite, cacheWrite: Schema.Finite });

const Estimate = Schema.Struct({ share: Schema.Finite, contributionPoints: Schema.Finite, pointsPerHour: Schema.Finite });

const Harness = Schema.Literals(["pi", "claude-code", "codex"]);

const Session = Schema.Struct({
  id: Schema.String,
  identity: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("pane"), pane: Schema.String, status: Schema.UndefinedOr(Schema.String) }),
    Schema.Struct({ kind: Schema.Literal("process"), pid: Schema.Finite }),
    Schema.Struct({ kind: Schema.Literal("ended") }),
  ]),
  harness: Harness,
  cwd: Schema.UndefinedOr(Schema.String),
  place: Schema.String,
  files: Schema.Array(Schema.String),
  machine: Schema.optionalKey(Schema.String),
});

const SessionShare = Schema.Struct({
  session: Session,
  label: Schema.String,
  calls: Schema.Finite,
  tokens: Tokens,
  trailingHourTokens: Tokens,
  raw: Estimate,
  priced: Estimate,
  models: Schema.Array(
    Schema.Struct({ model: Schema.UndefinedOr(Schema.String), calls: Schema.Finite, tokens: Tokens, trailingHourTokens: Tokens, priced: Estimate }),
  ),
  flagged: Schema.Boolean,
});

const WindowView = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: ShownWindow.fields.kind,
  source: WindowSource,
  cycleSeconds: Schema.Finite,
  startsAt: Instant,
  resetsAt: Instant,
  usedPoints: Schema.Finite,
  leftPoints: Schema.Finite,
  pace: Schema.Literals(["ahead", "on_pace", "behind", "unknown"]),
  elapsedFraction: Schema.Finite,
  aheadOfPace: Schema.Boolean,
  pastFirstTenth: Schema.Boolean,
  exhaustsBeforeReset: Schema.Boolean,
  verdict: Schema.NullOr(Schema.Boolean),
  sustainablePointsPerHour: Schema.NullOr(Schema.Finite),
  activeSessions: Schema.Finite,
  fairPointsPerHour: Schema.NullOr(Schema.Finite),
  observedCalls: Schema.Finite,
  observedTokens: Tokens,
  unattributedPoints: Schema.Finite,
  sessions: Schema.Array(SessionShare),
  otherCycle: Schema.Array(Schema.String),
});

const accountRef = {
  provider: Provider,
  accountKey: Schema.UndefinedOr(Schema.String),
  credentialKey: Schema.UndefinedOr(Schema.String),
  title: Schema.String,
};

const sourceFailures = { quota: Schema.UndefinedOr(Failed), panes: Schema.UndefinedOr(Failed), processes: Schema.UndefinedOr(Failed) };

export const SessionsCodec: Schema.Codec<SessionQuotaView, unknown> = Schema.Struct({
  now: Instant,
  ...sourceFailures,
  accounts: Schema.Array(
    Schema.Struct({
      ...accountRef,
      accountKeys: Schema.Array(Schema.String),
      joins: Schema.Array(AccountJoin),
      body: Schema.Union([Schema.Struct({ kind: Schema.Literal("windows"), windows: Schema.Array(WindowView) }), ...Failed.members]),
    }),
  ),
  sessions: Schema.Array(Session),
  modelsSinceMidnight: Schema.Array(
    Schema.Struct({
      session: Session,
      models: Schema.Array(
        Schema.Struct({
          model: Schema.UndefinedOr(Schema.String),
          tokens: Tokens,
          provider: Schema.UndefinedOr(Provider),
        }),
      ),
      firstCallAt: Schema.UndefinedOr(Instant),
    }),
  ),
  unmatched: Schema.Array(
    Schema.Struct({
      harness: Harness,
      cwd: Schema.String,
      place: Schema.String,
      pids: Schema.Array(Schema.Finite),
      machine: Schema.optionalKey(Schema.String),
    }),
  ),
  ledger: Schema.Struct({
    bridgeCopiesDropped: Schema.Finite,
    repeatedLinesDropped: Schema.Finite,
    emptyRowsDropped: Schema.Finite,
    forkCopiesDropped: Schema.Finite,
    repeatedCountsDropped: Schema.Finite,
  }),
  unmetered: Schema.Array(Schema.Struct({ route: Schema.String, calls: Schema.Finite, tokens: Tokens })),
  unjoinedCalls: Schema.Finite,
  composition: Schema.optionalKey(
    Schema.Struct({
      local: Schema.String,
      remotes: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          state: Schema.Union([
            Schema.Struct({ kind: Schema.Literal("ok"), generatedAt: Instant, ...sourceFailures }),
            Schema.Struct({ kind: Schema.Literal("stale"), generatedAt: Instant }),
            ...Failed.members,
          ]),
        }),
      ),
      failedAccounts: Schema.Array(Schema.Struct({ machine: Schema.String, account: Schema.Struct(accountRef), failure: Failed })),
    }),
  ),
});

const Measured = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("value"), value: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literal("not-reported") }),
]);

const ResourcesView = Schema.Struct({
  machine: Schema.Struct({
    cpu: outcomeOf(Schema.Struct({ percent: Schema.Finite, cores: Schema.Finite })),
    memory: outcomeOf(Schema.Struct({ usedBytes: Schema.Finite, totalBytes: Schema.Finite })),
    disk: Schema.UndefinedOr(outcomeOf(Schema.Struct({ usedBytes: Schema.Finite, totalBytes: Schema.Finite }))),
    load: outcomeOf(Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite])),
    processes: outcomeOf(
      Schema.Array(Schema.Struct({ pid: Schema.Finite, program: Schema.String, cpuPercent: Schema.Finite, residentBytes: Schema.Finite })),
    ),
  }),
  gpu: Schema.UndefinedOr(
    outcomeOf(
      Schema.Struct({
        gpus: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            utilizationPercent: Measured,
            memoryUsedMiB: Measured,
            memoryTotalMiB: Measured,
            temperatureC: Measured,
          }),
        ),
        apps: outcomeOf(Schema.Array(Schema.Struct({ pid: Schema.Finite, program: Schema.UndefinedOr(Schema.String), memoryUsedMiB: Measured }))),
      }),
    ),
  ),
});

const NamedMachine = Schema.Struct({
  name: Schema.String,
  state: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("ok"), view: ResourcesView }),
    Schema.Struct({ kind: Schema.Literal("pending") }),
    Schema.Struct({ kind: Schema.Literal("stale"), generatedAt: Instant }),
    ...Failed.members,
  ]),
});

export const MachinesCodec: Schema.Codec<MachinesView, unknown> = Schema.Struct({
  now: Instant,
  machines: Schema.TupleWithRest(Schema.Tuple([NamedMachine]), [NamedMachine]),
});

export const QueuesCodec: Schema.Codec<QueueReadings, unknown> = Schema.Struct({
  machines: Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.Option(outcomeOf(PueueStatus)) })),
  actions: Schema.Struct({ repo: Schema.String, runs: Schema.Option(outcomeOf(Schema.Array(ActionRun))) }),
});

const JobSpan = Schema.Struct({ startedAt: Instant, endedAt: Schema.UndefinedOr(Instant) });

const CiReportCodec = Schema.Struct({
  repos: Schema.Array(Schema.String),
  runs: Schema.Array(
    Schema.Struct({
      repo: Schema.String,
      id: Schema.Finite,
      workflow: Schema.String,
      branch: Schema.UndefinedOr(Schema.String),
      createdAt: Instant,
      updatedAt: Instant,
      status: Schema.Literals(["waiting", "running", "done"]),
      conclusion: Schema.UndefinedOr(Schema.String),
      jobs: Schema.UndefinedOr(JobSpan),
    }),
  ),
  failures: Schema.Array(Schema.Struct({ repo: Schema.String, failure: Failed })),
});

export const CiCodec: Schema.Codec<Reading<CiReport>, unknown> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ok"), value: CiReportCodec, capturedAt: Instant }),
  Schema.Struct({ kind: Schema.Literal("unreachable"), reason: Schema.String, capturedAt: Instant }),
  Schema.Struct({ kind: Schema.Literal("invalid"), issue: Schema.String, capturedAt: Instant }),
]);
