import type { DateTime } from "effect";
import { type Failed, failureOf, type Reading } from "../../../shared/lib";
import type { OrcQuota, OrcQuotaAccount, OrcQuotaUnreadCause } from "../sources/orc-quota";
import type { QuotaAvailability, QuotaProvider, QuotaProviderId } from "../sources/quota";
import { type AccountRead, type QuotaRead, sourcedEntries } from "../sources/quota-read";
import type { SourcedEntry, SourcedProvider, SourcedWindow } from "../sources/window-sources";

export const accountStandings = ["next", "spare", "under-floor", "used-up"] as const;

// next is the account orc quota picks for the coming run, and under-floor and used-up are ones it skips for too little room.
export type AccountStanding = (typeof accountStandings)[number];

export type QuotaBlockBody =
  | {
      readonly kind: "live";
      readonly plan: string | undefined;
      readonly reportedAt: DateTime.Utc;
      readonly state: QuotaProvider["state"];
      readonly windows: ReadonlyArray<SourcedWindow>;
      readonly exhaustion: ReadonlyArray<QuotaAvailability>;
    }
  | {
      readonly kind: "account";
      readonly percentLeft: number;
      readonly resetsAt: DateTime.Utc | null;
      readonly standing: AccountStanding;
      readonly floorPercent: number;
    }
  | { readonly kind: "unusable"; readonly reason: string }
  | { readonly kind: "accounts-unread"; readonly cause: OrcQuotaUnreadCause; readonly reason: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unread" }
  | Failed;

export interface QuotaBlock {
  readonly provider: QuotaProviderId;
  readonly title: string;
  readonly body: QuotaBlockBody;
}

const liveBody = (entry: SourcedProvider): QuotaBlockBody => ({
  kind: "live",
  plan: entry.plan,
  reportedAt: entry.reportedAt,
  state: entry.state,
  windows: entry.windows,
  exhaustion: entry.quotaSemantics?.effectiveAvailability ?? [],
});

// quota-axi fills "default" for single-account providers once any provider expands.
const accountSuffix = (entry: SourcedEntry): string =>
  entry.accountKey === undefined || entry.accountKey === "default" ? "" : ` ${entry.accountKey}`;

const providerTitle = (provider: QuotaProviderId, activeClaude: string | null): string =>
  provider === "claude" && activeClaude !== null ? `claude ${activeClaude}` : provider;

export const accountTitle = (entry: SourcedEntry, activeClaude: string | null): string =>
  `${providerTitle(entry.provider, activeClaude)}${accountSuffix(entry)}`;

// orc quota names no provider for an account, so every account block takes the Claude tint.
const orcAccountProvider: QuotaProviderId = "claude";

const orcAccountsTitle = "accounts";

type ReadAccounts = Extract<OrcQuota, { readonly kind: "read" }>;

const standingOf = (account: Extract<OrcQuotaAccount, { readonly kind: "usable" }>, reading: ReadAccounts): AccountStanding => {
  if (reading.pick === account.account) return "next";
  if (account.remainingPercent <= 0) return "used-up";
  return account.remainingPercent >= reading.floorPercent ? "spare" : "under-floor";
};

const orcAccountBlock = (account: OrcQuotaAccount, reading: ReadAccounts): QuotaBlock => ({
  provider: orcAccountProvider,
  title: `account ${account.account}`,
  body:
    account.kind === "usable"
      ? {
          kind: "account",
          percentLeft: account.remainingPercent,
          resetsAt: account.resetsAt ?? null,
          standing: standingOf(account, reading),
          floorPercent: reading.floorPercent,
        }
      : { kind: "unusable", reason: account.reason },
});

const orcQuotaBlocks = (orcQuota: Reading<OrcQuota>): ReadonlyArray<QuotaBlock> => {
  if (orcQuota.kind !== "ok") return [{ provider: orcAccountProvider, title: orcAccountsTitle, body: failureOf(orcQuota) }];
  const reading = orcQuota.value;
  if (reading.kind === "unread") {
    return [{ provider: orcAccountProvider, title: orcAccountsTitle, body: { kind: "accounts-unread", cause: reading.cause, reason: reading.reason } }];
  }
  return reading.accounts.map((account) => orcAccountBlock(account, reading));
};

interface LiveContext {
  readonly entries: ReadonlyArray<SourcedEntry>;
  readonly notSetUp: ReadonlyArray<QuotaProviderId>;
  readonly title: (entry: SourcedEntry) => string;
}

const liveBlocks = (provider: QuotaProviderId, base: string, context: LiveContext): ReadonlyArray<QuotaBlock> => {
  const entries = context.entries.filter((candidate) => candidate.provider === provider);
  if (entries.length === 0) return context.notSetUp.includes(provider) ? [] : [{ provider, title: base, body: { kind: "absent" } }];
  return entries.map((entry) => ({
    provider,
    title: context.title(entry),
    body: "kind" in entry ? failureOf(entry) : liveBody(entry),
  }));
};

const accountBlock = (account: AccountRead): QuotaBlock => ({
  provider: "claude",
  title: `claude ${account.name}`,
  body: account.read === undefined ? { kind: "unread" } : liveBody(account.read),
});

export const quotaBlocks = (
  read: QuotaRead,
  orcQuota: Reading<OrcQuota>,
  now: DateTime.Utc,
): ReadonlyArray<QuotaBlock> => {
  const context: LiveContext = {
    entries: sourcedEntries(read, now),
    notSetUp: read.quotaAxi.kind === "ok" ? read.quotaAxi.value.notSetUp : [],
    title: (entry) => accountTitle(entry, null),
  };
  return [
    ...liveBlocks("claude", "claude", context),
    ...read.accounts.map(accountBlock),
    ...orcQuotaBlocks(orcQuota),
    ...liveBlocks("codex", "codex", context),
    ...liveBlocks("opencode-go", "opencode-go", context),
  ];
};
