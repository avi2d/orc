import { DateTime, Option, Result, Schema } from "effect";
import { Tokens } from "./tokens";

export type Harness = "pi" | "claude-code" | "codex";

export type SinceByHarness = Readonly<Partial<Record<Harness, number>>>;

const CodexLimitWindow = Schema.Struct({ usedPercent: Schema.Finite, windowMinutes: Schema.Finite, resetsAt: Schema.Finite });

export type CodexLimitWindow = typeof CodexLimitWindow.Type;

export const LogRecord = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("pi-session"), cwd: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("pi-call"),
    at: Schema.Finite,
    messageAt: Schema.UndefinedOr(Schema.Finite),
    provider: Schema.String,
    model: Schema.String,
    tokens: Tokens,
  }),
  Schema.Struct({
    kind: Schema.Literal("claude-code-call"),
    at: Schema.Finite,
    cwd: Schema.UndefinedOr(Schema.String),
    messageId: Schema.UndefinedOr(Schema.String),
    requestId: Schema.UndefinedOr(Schema.String),
    model: Schema.UndefinedOr(Schema.String),
    tokens: Tokens,
  }),
  Schema.Struct({ kind: Schema.Literal("claude-code-limit-hit"), at: Schema.Finite, window: Schema.String, resetsAt: Schema.Finite }),
  Schema.Struct({ kind: Schema.Literal("codex-session"), cwd: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("codex-count"), at: Schema.Finite, total: Tokens, last: Schema.UndefinedOr(Tokens) }),
  Schema.Struct({ kind: Schema.Literal("codex-limits"), at: Schema.Finite, windows: Schema.Array(CodexLimitWindow) }),
]);

export type LogRecord = typeof LogRecord.Type;

const Instant = Schema.DateTimeUtcFromString;
const Count = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const PiSession = Schema.Struct({ type: Schema.Literal("session"), cwd: Schema.String });

const PiAssistant = Schema.Struct({
  type: Schema.Literal("message"),
  timestamp: Instant,
  message: Schema.Struct({
    role: Schema.Literal("assistant"),
    provider: Schema.String,
    model: Schema.String,
    timestamp: Schema.optionalKey(Count),
    usage: Schema.Struct({ input: Count, output: Count, cacheRead: Count, cacheWrite: Count }),
  }),
});

const PiLine = Schema.Union([PiSession, PiAssistant]);

const ClaudeCodeAssistant = Schema.Struct({
  type: Schema.Literal("assistant"),
  timestamp: Instant,
  cwd: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
  message: Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
    usage: Schema.Struct({
      input_tokens: Schema.optionalKey(Count),
      output_tokens: Schema.optionalKey(Count),
      cache_read_input_tokens: Schema.optionalKey(Count),
      cache_creation_input_tokens: Schema.optionalKey(Count),
    }),
  }),
});

const ClaudeCodeLimitHit = Schema.Struct({
  type: Schema.Literal("assistant"),
  timestamp: Instant,
  quotaLimits: Schema.Struct({ status: Schema.Literal("rejected"), rateLimitType: Schema.String, resetsAt: Schema.Finite }),
});

const CodexUsage = Schema.Struct({
  input_tokens: Count,
  cached_input_tokens: Schema.optionalKey(Count),
  output_tokens: Count,
});

const CodexSession = Schema.Struct({
  type: Schema.Literal("session_meta"),
  payload: Schema.Struct({ cwd: Schema.String }),
});

const CodexTokenCount = Schema.Struct({
  type: Schema.Literal("event_msg"),
  timestamp: Instant,
  payload: Schema.Struct({
    type: Schema.Literal("token_count"),
    info: Schema.NullOr(
      Schema.Struct({ total_token_usage: CodexUsage, last_token_usage: Schema.optionalKey(CodexUsage) }),
    ),
  }),
});

const CodexLine = Schema.Union([CodexSession, CodexTokenCount]);

const CodexLimitWindowJson = Schema.Struct({
  used_percent: Schema.Finite,
  window_minutes: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  resets_at: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
});

const CodexRateLimits = Schema.Struct({
  type: Schema.Literal("event_msg"),
  timestamp: Instant,
  payload: Schema.Struct({
    type: Schema.Literal("token_count"),
    rate_limits: Schema.Struct({
      limit_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
      primary: Schema.optionalKey(Schema.NullOr(CodexLimitWindowJson)),
      secondary: Schema.optionalKey(Schema.NullOr(CodexLimitWindowJson)),
    }),
  }),
});

const millis = (instant: DateTime.Utc): number => DateTime.toEpochMillis(instant);

const piRecord = (line: typeof PiLine.Type): ReadonlyArray<LogRecord> => [
  line.type === "session"
    ? { kind: "pi-session", cwd: line.cwd }
    : {
        kind: "pi-call",
        at: millis(line.timestamp),
        messageAt: line.message.timestamp,
        provider: line.message.provider,
        model: line.message.model,
        tokens: line.message.usage,
      },
];

const claudeCodeRecord = (line: typeof ClaudeCodeAssistant.Type): ReadonlyArray<LogRecord> => {
  const usage = line.message.usage;
  return [{
    kind: "claude-code-call",
    at: millis(line.timestamp),
    cwd: line.cwd,
    messageId: line.message.id,
    requestId: line.requestId,
    model: line.message.model,
    tokens: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    },
  }];
};

const secondMillis = 1000;

const claudeCodeLimitHit = (line: typeof ClaudeCodeLimitHit.Type): ReadonlyArray<LogRecord> => [
  {
    kind: "claude-code-limit-hit",
    at: millis(line.timestamp),
    window: line.quotaLimits.rateLimitType,
    resetsAt: line.quotaLimits.resetsAt * secondMillis,
  },
];

// Codex counts cached input inside input_tokens, so only the rest is uncached input.
const codexTokens = (usage: typeof CodexUsage.Type): Tokens => {
  const cached = usage.cached_input_tokens ?? 0;
  return { input: usage.input_tokens - cached, output: usage.output_tokens, cacheRead: cached, cacheWrite: 0 };
};

const codexRecord = (line: typeof CodexLine.Type): ReadonlyArray<LogRecord> => {
  if (line.type === "session_meta") return [{ kind: "codex-session", cwd: line.payload.cwd }];
  const info = line.payload.info;
  if (info === null) return [];
  return [{
    kind: "codex-count",
    at: millis(line.timestamp),
    total: codexTokens(info.total_token_usage),
    last: info.last_token_usage === undefined ? undefined : codexTokens(info.last_token_usage),
  }];
};

const codexLimitWindow = (window: typeof CodexLimitWindowJson.Type | null | undefined): ReadonlyArray<CodexLimitWindow> =>
  window?.window_minutes === undefined || window.window_minutes === null || window.resets_at === undefined || window.resets_at === null
    ? []
    : [{ usedPercent: window.used_percent, windowMinutes: window.window_minutes, resetsAt: window.resets_at * secondMillis }];

// Codex names only its extra per-model limits, so a named snapshot meters something other than the account.
const codexLimits = (line: typeof CodexRateLimits.Type): ReadonlyArray<LogRecord> => {
  const limits = line.payload.rate_limits;
  if (limits.limit_name !== undefined && limits.limit_name !== null) return [];
  const windows = [...codexLimitWindow(limits.primary), ...codexLimitWindow(limits.secondary)];
  return windows.length === 0 ? [] : [{ kind: "codex-limits", at: millis(line.timestamp), windows }];
};

const readerOf = <A>(schema: Schema.Decoder<A>, records: (line: A) => ReadonlyArray<LogRecord>) => {
  const decode = Schema.decodeUnknownOption(schema);
  return (parsed: unknown): ReadonlyArray<LogRecord> => Option.match(decode(parsed), { onNone: () => [], onSome: records });
};

interface LineReader {
  // A line holding none of these carries no record, so it is never parsed.
  readonly markers: ReadonlyArray<string>;
  readonly records: (line: string) => ReadonlyArray<LogRecord>;
}

// Each reader decodes the line on its own, so a quota reading that does not decode never costs the line its usage.
const lineReader = (markers: ReadonlyArray<string>, readers: ReadonlyArray<(parsed: unknown) => ReadonlyArray<LogRecord>>): LineReader => ({
  markers,
  records: (line) => {
    const parsed = Result.try((): unknown => JSON.parse(line));
    if (Result.isFailure(parsed)) return [];
    return readers.flatMap((read) => read(parsed.success));
  },
});

const lineReaders = {
  pi: lineReader(['"usage"', '"session"'], [readerOf(PiLine, piRecord)]),
  "claude-code": lineReader(['"usage"', '"quotaLimits"'], [
    readerOf(ClaudeCodeAssistant, claudeCodeRecord),
    readerOf(ClaudeCodeLimitHit, claudeCodeLimitHit),
  ]),
  codex: lineReader(['"token_count"', '"session_meta"'], [readerOf(CodexLine, codexRecord), readerOf(CodexRateLimits, codexLimits)]),
} satisfies Record<Harness, LineReader>;

// A line that is not a usage record, or not JSON, carries nothing to count, so it is skipped rather than failing the file.
export const logRecords = (harness: Harness, text: string): ReadonlyArray<LogRecord> => {
  const { markers, records } = lineReaders[harness];
  return text
    .split("\n")
    .filter((line) => markers.some((marker) => line.includes(marker)))
    .flatMap(records);
};

const newline = 10;

const startDecoder = new TextDecoder();
const lineDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

// Every marker is ASCII, which UTF-8 encodes as itself and as no part of any other character, so the bytes hold a marker where the text does.
// Most of a log's bytes sit on lines with no marker, and decoding them all to text first was most of a session read.
const markedLines = (bytes: Uint8Array, markers: ReadonlyArray<string>): ReadonlyArray<string> => {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ends = new Map<number, number>();
  for (const marker of markers) {
    for (let at = buffer.indexOf(marker); at !== -1; ) {
      const start = buffer.lastIndexOf(newline, at) + 1;
      const found = buffer.indexOf(newline, at);
      const end = found === -1 ? buffer.length : found;
      ends.set(start, end);
      at = buffer.indexOf(marker, end);
    }
  }
  // Decoding the bytes whole drops a byte order mark only at their start, so only the first line's decoder drops one.
  return [...ends]
    .toSorted(([left], [right]) => left - right)
    .map(([start, end]) => (start === 0 ? startDecoder : lineDecoder).decode(bytes.subarray(start, end)));
};

// The same records as logRecords over the bytes decoded as text.
export const markedLogRecords = (harness: Harness, bytes: Uint8Array): ReadonlyArray<LogRecord> => {
  const { markers, records } = lineReaders[harness];
  return markedLines(bytes, markers).flatMap(records);
};
