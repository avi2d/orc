import type { QuotaProviderId } from "../sources/quota";
import { type LogFile, nativeCodexKey } from "./ledger";
import type { CodexLimitWindow, Harness, LogRecord } from "./log-lines";

export type HarvestHarness = Extract<Harness, "codex" | "claude-code">;

// Codex writes its readings only to its rollouts, while Claude Code also hands them to its statusline.
export type HarvestOrigin =
  | { readonly harness: "codex"; readonly via: "log" }
  | { readonly harness: "claude-code"; readonly via: "log" | "statusline" | "headless" };

export type HarvestedReading = HarvestOrigin & {
  readonly provider: Extract<QuotaProviderId, "claude" | "codex">;
  readonly credentialKey: string | undefined;
  readonly windowId: string;
  readonly cycleSeconds: number;
  readonly percentRemaining: number;
  readonly resetsAt: number;
  readonly observedAt: number;
  readonly file: string;
};

const minuteSeconds = 60;

const hourSeconds = 3600;

// quota-axi's own window identity for a Codex window of a given length, so a reading lands on the window quota-axi reports.
const codexWindowId = (windowMinutes: number): string => {
  const seconds = windowMinutes * minuteSeconds;
  if (seconds === 18_000) return "five_hour";
  if (seconds === 604_800) return "weekly";
  const hours = seconds / hourSeconds;
  return `window:${Number.isInteger(hours) ? hours : Number(hours.toFixed(2))}h`;
};

const percentLeft = (usedPercent: number): number => Math.min(100, Math.max(0, 100 - usedPercent));

const codexReading = (file: string, at: number, window: CodexLimitWindow): HarvestedReading => ({
  provider: "codex",
  harness: "codex",
  via: "log",
  credentialKey: nativeCodexKey,
  windowId: codexWindowId(window.windowMinutes),
  cycleSeconds: window.windowMinutes * minuteSeconds,
  percentRemaining: percentLeft(window.usedPercent),
  resetsAt: window.resetsAt,
  observedAt: at,
  file,
});

// The Agent SDK's rateLimitType names the window but not its length, so only the two account windows have a cycle to pace.
export const claudeCycles = { five_hour: 18_000, seven_day: 604_800 } as const;

const claudeCycleOf: Readonly<Partial<Record<string, number>>> = claudeCycles;

// A rejected request is the only Claude reading the logs keep, and it means the window had nothing left.
const readingsOf = (file: LogFile, record: LogRecord): ReadonlyArray<HarvestedReading> => {
  if (record.kind === "codex-limits") return record.windows.map((window) => codexReading(file.path, record.at, window));
  if (record.kind !== "claude-code-limit-hit") return [];
  const cycleSeconds = claudeCycleOf[record.window];
  if (cycleSeconds === undefined) return [];
  return [
    {
      provider: "claude",
      harness: "claude-code",
      via: "log",
      credentialKey: undefined,
      windowId: record.window,
      cycleSeconds,
      percentRemaining: 0,
      resetsAt: record.resetsAt,
      observedAt: record.at,
      file: file.path,
    },
  ];
};

const readingKey = (reading: HarvestedReading): string =>
  `${reading.provider} ${reading.credentialKey ?? ""} ${reading.windowId}`;

export const harvestedReadings = (
  files: ReadonlyArray<LogFile>,
  captured: ReadonlyArray<HarvestedReading> = [],
): ReadonlyArray<HarvestedReading> => {
  const newest = new Map<string, HarvestedReading>();
  for (const reading of [...files.flatMap((file) => file.records.flatMap((record) => readingsOf(file, record))), ...captured]) {
    const known = newest.get(readingKey(reading));
    if (known === undefined || reading.observedAt >= known.observedAt) newest.set(readingKey(reading), reading);
  }
  return [...newest.values()];
};
