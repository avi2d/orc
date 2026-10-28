import type { QuotaProviderId } from "../sources/quota";
import type { Harness, LogRecord } from "./log-lines";
import { type Tokens, tokenTotal } from "./tokens";

export interface LogFile {
  readonly path: string;
  readonly harness: Harness;
  readonly modifiedAt: number;
  readonly records: ReadonlyArray<LogRecord>;
}

export interface CountedCall {
  readonly file: string;
  readonly harness: Harness;
  readonly at: number;
  readonly route: string;
  readonly quota: QuotaProviderId | undefined;
  readonly credentialKey: string | undefined;
  readonly model: string | undefined;
  readonly tokens: Tokens;
}

export interface Ledger {
  readonly calls: ReadonlyArray<CountedCall>;
  readonly bridgeCopiesDropped: number;
  readonly repeatedLinesDropped: number;
  readonly emptyRowsDropped: number;
  readonly forkCopiesDropped: number;
  readonly repeatedCountsDropped: number;
}

const bridgeProvider = "claude-bridge";

const bridgeSlackMillis = 5000;

// quota-axi's key for the login in Codex's own home, whose rollouts are the only Codex logs read.
export const nativeCodexKey = "codex-home";

const piQuota = (provider: string): QuotaProviderId | undefined => {
  if (provider === bridgeProvider || provider === "anthropic" || provider === "claude-agent-sdk") return "claude";
  if (provider === "openai-codex" || provider.startsWith("openai-codex-")) return "codex";
  if (provider === "opencode-go") return "opencode-go";
  return undefined;
};

export const usageKey = (tokens: Tokens): string => `${tokens.input} ${tokens.output} ${tokens.cacheRead} ${tokens.cacheWrite}`;

type Of<K extends LogRecord["kind"]> = Extract<LogRecord, { readonly kind: K }>;

const recordsOf = <K extends LogRecord["kind"]>(file: LogFile, kind: K): ReadonlyArray<Of<K>> =>
  file.records.filter((record): record is Of<K> => record.kind === kind);

const isSynthetic = (record: Of<"claude-code-call">): boolean =>
  record.model === "<synthetic>" || (record.messageId?.startsWith("msg_syn_") ?? false);

interface Kept<A> {
  readonly kept: ReadonlyArray<A>;
  readonly dropped: number;
}

// A fork copies earlier history into a new file, and Pi names files by start time, so the earliest file keeps the call.
const piCalls = (files: ReadonlyArray<LogFile>): Kept<CountedCall> => {
  const seen = new Set<string>();
  const kept: Array<CountedCall> = [];
  let dropped = 0;
  for (const file of files.filter((candidate) => candidate.harness === "pi").toSorted((a, b) => a.path.localeCompare(b.path))) {
    for (const record of recordsOf(file, "pi-call")) {
      if (tokenTotal(record.tokens) === 0) continue;
      const key = `${record.at} ${usageKey(record.tokens)}`;
      if (seen.has(key)) {
        dropped += 1;
        continue;
      }
      seen.add(key);
      const quota = piQuota(record.provider);
      kept.push({
        file: file.path,
        harness: "pi",
        at: record.at,
        route: record.provider,
        quota,
        credentialKey: quota === "codex" ? record.provider : undefined,
        model: record.model,
        tokens: record.tokens,
      });
    }
  }
  return { kept, dropped };
};

interface ClaudeCodeCalls {
  readonly unique: ReadonlyArray<CountedCall>;
  readonly repeated: number;
  readonly empty: number;
}

// Claude Code writes one line per content block, each carrying the whole message's usage.
const claudeCodeCalls = (files: ReadonlyArray<LogFile>): ClaudeCodeCalls => {
  const unique = new Map<string, CountedCall>();
  let lines = 0;
  let empty = 0;
  for (const file of files.filter((candidate) => candidate.harness === "claude-code")) {
    for (const record of recordsOf(file, "claude-code-call")) {
      if (tokenTotal(record.tokens) === 0 || isSynthetic(record)) {
        empty += 1;
        continue;
      }
      lines += 1;
      const key =
        record.messageId === undefined && record.requestId === undefined
          ? `${file.path} ${record.at}`
          : `${record.messageId ?? ""} ${record.requestId ?? ""}`;
      unique.set(key, {
        file: file.path,
        harness: "claude-code",
        at: record.at,
        route: "claude-code",
        quota: "claude",
        credentialKey: undefined,
        model: record.model,
        tokens: record.tokens,
      });
    }
  }
  return { unique: [...unique.values()], repeated: lines - unique.size, empty };
};

// The bridge's Claude Code process logs every call Pi logs, so one copy of each pair is dropped.
const withoutBridgeCopies = (pi: ReadonlyArray<CountedCall>, claudeCode: ReadonlyArray<CountedCall>): Kept<CountedCall> => {
  const byUsage = new Map<string, Array<CountedCall>>();
  for (const call of claudeCode) {
    const twins = byUsage.get(usageKey(call.tokens));
    if (twins === undefined) byUsage.set(usageKey(call.tokens), [call]);
    else twins.push(call);
  }
  const copies = new Set<CountedCall>();
  for (const call of pi.filter((candidate) => candidate.route === bridgeProvider)) {
    const twin = byUsage
      .get(usageKey(call.tokens))
      ?.find((candidate) => !copies.has(candidate) && Math.abs(candidate.at - call.at) <= bridgeSlackMillis);
    if (twin !== undefined) copies.add(twin);
  }
  return { kept: claudeCode.filter((call) => !copies.has(call)), dropped: copies.size };
};

const subtract = (total: Tokens, before: Tokens): Tokens => ({
  input: total.input - before.input,
  output: total.output - before.output,
  cacheRead: total.cacheRead - before.cacheRead,
  cacheWrite: total.cacheWrite - before.cacheWrite,
});

// Codex repeats a token_count with an unchanged cumulative total, and restarts the total from zero after a restart.
const codexFileCalls = (file: LogFile): Kept<CountedCall> => {
  const kept: Array<CountedCall> = [];
  let dropped = 0;
  let previous: Tokens | undefined;
  for (const record of recordsOf(file, "codex-count")) {
    const total = tokenTotal(record.total);
    if (previous !== undefined && total === tokenTotal(previous)) {
      dropped += 1;
      continue;
    }
    const tokens =
      record.last ??
      (previous === undefined || total < tokenTotal(previous) ? record.total : subtract(record.total, previous));
    previous = record.total;
    if (tokenTotal(tokens) === 0) continue;
    kept.push({
      file: file.path,
      harness: "codex",
      at: record.at,
      route: "codex",
      quota: "codex",
      credentialKey: nativeCodexKey,
      model: undefined,
      tokens,
    });
  }
  return { kept, dropped };
};

export const countedCalls = (files: ReadonlyArray<LogFile>): Ledger => {
  const pi = piCalls(files);
  const claudeCode = claudeCodeCalls(files);
  const native = withoutBridgeCopies(pi.kept, claudeCode.unique);
  const codex = files.filter((file) => file.harness === "codex").map(codexFileCalls);
  return {
    calls: [...pi.kept, ...native.kept, ...codex.flatMap((file) => file.kept)].toSorted((a, b) => a.at - b.at),
    bridgeCopiesDropped: native.dropped,
    repeatedLinesDropped: claudeCode.repeated,
    emptyRowsDropped: claudeCode.empty,
    forkCopiesDropped: pi.dropped,
    repeatedCountsDropped: codex.reduce((sum, file) => sum + file.dropped, 0),
  };
};
