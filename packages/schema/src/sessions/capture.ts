import { DateTime, Effect, Schema } from "effect";
import type { ClaudeAccount } from "../contract/config";
import { recordLines } from "../decode";
import { claudeCycles, type HarvestedReading } from "./harvest";
import { type LogFile, usageKey } from "./ledger";
import type { LogRecord, SinceByHarness } from "./log-lines";
import { type Tokens, tokenTotal } from "./tokens";

const Count = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const Instant = Schema.DateTimeUtcFromString;

const TokenCounts = Schema.Struct({ input: Count, output: Count, cacheRead: Count, cacheWrite: Count });

const PiCallRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("pi-call"),
  at: Instant,
  sessionId: Schema.String,
  sessionFile: Schema.NullOr(Schema.String),
  cwd: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  messageAt: Instant,
  tokens: TokenCounts,
});

const ClaudeWindowReading = Schema.Struct({
  window: Schema.Literals(["five_hour", "seven_day"]),
  usedPercent: Schema.Finite,
  resetsAt: Instant,
});

const ClaudeCodeReadingRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("claude-code-reading"),
  at: Instant,
  sessionId: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  claudeHome: Schema.String,
  totalApiDurationMs: Schema.NullOr(Count),
  windows: Schema.NonEmptyArray(ClaudeWindowReading),
});

const ClaudeHeadlessReadingRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("claude-headless-reading"),
  at: Instant,
  sessionId: Schema.String,
  claudeHome: Schema.String,
  windows: Schema.NonEmptyArray(ClaudeWindowReading),
});

export const CaptureRecord = Schema.Union([PiCallRecord, ClaudeCodeReadingRecord, ClaudeHeadlessReadingRecord]);

export type CaptureRecord = typeof CaptureRecord.Type;

type PiCallRecord = typeof PiCallRecord.Type;

export type ClaudeCodeReadingRecord = typeof ClaudeCodeReadingRecord.Type;

export type ClaudeHeadlessReadingRecord = typeof ClaudeHeadlessReadingRecord.Type;

// Pi's own names for the assistant message's fields, so the extension passes them through as Pi holds them.
export const PiCallInput = Schema.Struct({
  sessionId: Schema.String,
  sessionFile: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cwd: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  timestamp: Count,
  usage: TokenCounts,
});

export type PiCallInput = typeof PiCallInput.Type;

const StatuslineWindow = Schema.Struct({ used_percentage: Schema.Finite, resets_at: Schema.Finite });

// Claude Code's own statusline input, of which only the session, the API time and the rate limits are kept.
export const ClaudeStatuslineInput = Schema.Struct({
  session_id: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  cost: Schema.optionalKey(Schema.Struct({ total_api_duration_ms: Schema.optionalKey(Count) })),
  rate_limits: Schema.optionalKey(
    Schema.Struct({
      five_hour: Schema.optionalKey(StatuslineWindow),
      seven_day: Schema.optionalKey(StatuslineWindow),
    }),
  ),
});

export type ClaudeStatuslineInput = typeof ClaudeStatuslineInput.Type;

export const encodeCaptureRecord = (record: CaptureRecord): Effect.Effect<string, Schema.SchemaError> =>
  Effect.map(Schema.encodeEffect(CaptureRecord)(record), (encoded) => JSON.stringify(encoded));

// A call with no usage spends nothing, so it is left out as the log reader leaves it out.
export const piCallRecord = (input: PiCallInput, at: DateTime.Utc): CaptureRecord | undefined =>
  tokenTotal(input.usage) === 0
    ? undefined
    : {
        schemaVersion: 1,
        kind: "pi-call",
        at,
        sessionId: input.sessionId,
        sessionFile: input.sessionFile ?? null,
        cwd: input.cwd,
        provider: input.provider,
        model: input.model,
        messageAt: DateTime.makeUnsafe(input.timestamp),
        tokens: input.usage,
      };

const secondMillis = 1000;

const statuslineWindows = ["five_hour", "seven_day"] as const;

const claudeHomeOf = (directory: string): string => directory.replace(/\/+$/u, "");

// Claude Code holds no rate limits until its first response, so a statusline without them is no reading.
export const statuslineRecord = (
  input: ClaudeStatuslineInput,
  at: DateTime.Utc,
  claudeHome: string,
): CaptureRecord | undefined => {
  const limits = input.rate_limits;
  const windows = statuslineWindows.flatMap((window) => {
    const reading = limits?.[window];
    return reading === undefined
      ? []
      : [{ window, usedPercent: reading.used_percentage, resetsAt: DateTime.makeUnsafe(reading.resets_at * secondMillis) }];
  });
  const first = windows.at(0);
  if (first === undefined) return undefined;
  return {
    schemaVersion: 1,
    kind: "claude-code-reading",
    at,
    sessionId: input.session_id,
    cwd: input.cwd ?? null,
    claudeHome: claudeHomeOf(claudeHome),
    totalApiDurationMs: input.cost?.total_api_duration_ms ?? null,
    windows: [first, ...windows.slice(1)],
  };
};

export const captureRecords: (text: string) => ReadonlyArray<CaptureRecord> = recordLines(CaptureRecord);

const dayMillis = 86_400_000;

// A monthly window reaches back at most 31 days, and the day file holding its start must outlive that day.
export const retainedDays = 32;

const dayFilePattern = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;

const dayOf = (at: number): string => DateTime.formatIsoDateUtc(DateTime.makeUnsafe(at));

export const dayFileOf = (at: number): string => `${dayOf(at)}.jsonl`;

const datedFiles = (names: ReadonlyArray<string>): ReadonlyArray<{ readonly name: string; readonly day: string }> =>
  names.flatMap((name) => {
    const day = dayFilePattern.exec(name)?.[1];
    return day === undefined ? [] : [{ name, day }];
  });

export const expiredDayFiles = (names: ReadonlyArray<string>, now: number, keptDays = retainedDays): ReadonlyArray<string> => {
  const oldest = dayOf(now - keptDays * dayMillis);
  return datedFiles(names).filter(({ day }) => day < oldest).map(({ name }) => name);
};

export const dayFiles = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  datedFiles(names.toSorted()).map(({ name }) => name);

export const currentAndPreviousDayFiles = (names: ReadonlyArray<string>, at: number): ReadonlyArray<string> => {
  const today = dayOf(at);
  const dated = datedFiles(names.toSorted());
  const current = dated.find(({ day }) => day === today);
  const previous = dated.findLast(({ day }) => day < today);
  return [current, previous].flatMap((file) => (file === undefined ? [] : [file.name]));
};

export interface CapturedCall {
  readonly at: number;
  readonly messageAt: number;
  readonly file: string;
  readonly cwd: string;
  readonly provider: string;
  readonly model: string;
  readonly tokens: Tokens;
}

// Every configured account is listed, with or without a reading.
export interface AccountCaptured {
  readonly name: string;
  readonly readings: ReadonlyArray<HarvestedReading>;
}

export interface Captured {
  readonly calls: ReadonlyArray<CapturedCall>;
  readonly readings: ReadonlyArray<HarvestedReading>;
  readonly accounts: ReadonlyArray<AccountCaptured>;
}

export const nothingCaptured: Captured = { calls: [], readings: [], accounts: [] };

export interface LedgerFile {
  readonly path: string;
  readonly records: ReadonlyArray<CaptureRecord>;
}

const millis = (instant: DateTime.Utc): number => DateTime.toEpochMillis(instant);

// A Pi session kept in memory has no file, so its id stands in for the file that would name the session.
const capturedCall = (record: PiCallRecord): CapturedCall => ({
  at: millis(record.at),
  messageAt: millis(record.messageAt),
  file: record.sessionFile ?? `pi-session:${record.sessionId}`,
  cwd: record.cwd,
  provider: record.provider,
  model: record.model,
  tokens: record.tokens,
});

interface DatedClaudeReading {
  readonly at: DateTime.Utc;
  readonly sessionId: string;
  readonly claudeHome: string;
  readonly totalApiDurationMs?: number | null;
  readonly windows: ReadonlyArray<typeof ClaudeWindowReading.Type>;
}

const readingSignature = (record: DatedClaudeReading): string =>
  JSON.stringify([
    record.totalApiDurationMs ?? null,
    record.windows.map((window) => [window.window, window.usedPercent, millis(window.resetsAt)]),
  ]);

// A session repeats its last numbers while it idles, so a repeat is dated by the first time it was seen.
const firstSightings = <R extends DatedClaudeReading>(records: ReadonlyArray<{ readonly path: string; readonly record: R }>) => {
  const last = new Map<string, string>();
  return records
    .toSorted((left, right) => millis(left.record.at) - millis(right.record.at))
    .filter(({ record }) => {
      const session = `${record.claudeHome} ${record.sessionId}`;
      const signature = readingSignature(record);
      const repeated = last.get(session) === signature;
      last.set(session, signature);
      return !repeated;
    });
};

export const lastReadingOf = (
  records: ReadonlyArray<CaptureRecord>,
  record: ClaudeCodeReadingRecord,
): ClaudeCodeReadingRecord | undefined =>
  records.findLast(
    (candidate): candidate is ClaudeCodeReadingRecord =>
      candidate.kind === "claude-code-reading" &&
      candidate.sessionId === record.sessionId &&
      candidate.claudeHome === record.claudeHome,
  );

export const sameReading = (left: DatedClaudeReading, right: DatedClaudeReading): boolean =>
  readingSignature(left) === readingSignature(right);

const percentLeft = (usedPercent: number): number => Math.min(100, Math.max(0, 100 - usedPercent));

const capturedReadings = (path: string, record: DatedClaudeReading, via: "statusline" | "headless", credentialKey: string | undefined):
  ReadonlyArray<HarvestedReading> =>
  record.windows.map((window) => ({
    provider: "claude",
    harness: "claude-code",
    via,
    credentialKey,
    windowId: window.window,
    cycleSeconds: claudeCycles[window.window],
    percentRemaining: percentLeft(window.usedPercent),
    resetsAt: millis(window.resetsAt),
    observedAt: millis(record.at),
    file: path,
  }));

// Neither reader names an account, so a reading counts only for the Claude home or account folder it was taken under.
export const capturedOf = (
  files: ReadonlyArray<LedgerFile>,
  since: SinceByHarness,
  claudeProjects: string,
  accounts: ReadonlyArray<ClaudeAccount>,
): Captured => {
  const entries = files.flatMap((file) => file.records.map((record) => ({ path: file.path, record })));
  const piSince = since.pi;
  const claudeSince = since["claude-code"];
  const home = claudeHomeOf(claudeProjects.replace(/\/+projects\/*$/u, ""));
  const calls =
    piSince === undefined
      ? []
      : entries.flatMap(({ record }) =>
          record.kind === "pi-call" && millis(record.at) >= piSince ? [capturedCall(record)] : [],
        );
  const readingsUnder = (folder: string, credentialKey: string | undefined): ReadonlyArray<HarvestedReading> => {
    if (claudeSince === undefined) return [];
    const under = entries.flatMap(({ path, record }) =>
      (record.kind === "claude-code-reading" || record.kind === "claude-headless-reading") && record.claudeHome === folder
        ? [{ path, record }]
        : [],
    );
    const statusline = firstSightings(under.filter(({ record }) => record.kind === "claude-code-reading")).filter(
      ({ record }) => millis(record.at) >= claudeSince,
    );
    const headless = under.filter(({ record }) => record.kind === "claude-headless-reading" && millis(record.at) >= claudeSince);
    return [...statusline, ...headless]
      .toSorted((left, right) => millis(left.record.at) - millis(right.record.at))
      .flatMap(({ path, record }) =>
        capturedReadings(path, record, record.kind === "claude-headless-reading" ? "headless" : "statusline", credentialKey),
      );
  };
  return {
    calls,
    readings: readingsUnder(home, undefined),
    accounts: accounts.map((account) => ({ name: account.name, readings: readingsUnder(account.folder, account.name) })),
  };
};

const callIdentity = (messageAt: number, tokens: Tokens): string => `${messageAt} ${usageKey(tokens)}`;

const capturedRecord = (call: CapturedCall): LogRecord => ({
  kind: "pi-call",
  at: call.at,
  messageAt: call.messageAt,
  provider: call.provider,
  model: call.model,
  tokens: call.tokens,
});

const byFile = (calls: ReadonlyArray<CapturedCall>): ReadonlyMap<string, ReadonlyArray<CapturedCall>> => {
  const groups = new Map<string, Array<CapturedCall>>();
  for (const call of calls) {
    const group = groups.get(call.file);
    if (group === undefined) groups.set(call.file, [call]);
    else group.push(call);
  }
  return groups;
};

const lastAt = (calls: ReadonlyArray<CapturedCall>, floor: number): number =>
  Math.max(floor, ...calls.map((call) => call.at));

// Pi stamps its log line when a message ends and the message when it starts, so only the message's stamp and usage name one call in both.
export const withCaptured = (files: ReadonlyArray<LogFile>, calls: ReadonlyArray<CapturedCall>): ReadonlyArray<LogFile> => {
  if (calls.length === 0) return files;
  const held = new Set(calls.map((call) => callIdentity(call.messageAt, call.tokens)));
  const notHeld = (record: LogRecord): boolean =>
    record.kind !== "pi-call" || record.messageAt === undefined || !held.has(callIdentity(record.messageAt, record.tokens));
  const grouped = byFile(calls);
  const scanned = files.map((file): LogFile => {
    if (file.harness !== "pi") return file;
    const own = grouped.get(file.path) ?? [];
    return {
      ...file,
      modifiedAt: lastAt(own, file.modifiedAt),
      records: [...file.records.filter(notHeld), ...own.map(capturedRecord)],
    };
  });
  const paths = new Set(files.map((file) => file.path));
  const unscanned = [...grouped].flatMap(([path, own]): ReadonlyArray<LogFile> => {
    const cwd = own.at(0)?.cwd;
    if (paths.has(path) || cwd === undefined) return [];
    return [{ path, harness: "pi", modifiedAt: lastAt(own, 0), records: [{ kind: "pi-session", cwd }, ...own.map(capturedRecord)] }];
  });
  return [...scanned, ...unscanned];
};
