import { DateTime } from "effect";
import { type Failed, failureOf, type Reading } from "../reading";
import type { SavedProfile, SavedProfiles } from "../sources/saved-profiles";
import type { QuotaAvailability, QuotaProvider, QuotaProviderId } from "../sources/quota";
import { type AccountRead, type QuotaRead, type SavedAge, sourcedEntries } from "../sources/quota-read";
import type { SourcedEntry, SourcedProvider, SourcedWindow } from "./window-sources";

export type { SavedAge };

export interface SavedWindow {
  readonly label: string;
  readonly percentLeft: number;
  readonly resetsAt: DateTime.Utc | null;
}

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
      readonly kind: "saved";
      readonly plan: string | null;
      readonly stale: boolean;
      readonly age: SavedAge;
      readonly windows: ReadonlyArray<SavedWindow>;
    }
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

const savedAge = (fetchedAt: DateTime.Utc | null, now: DateTime.Utc): SavedAge =>
  fetchedAt === null
    ? { kind: "undated" }
    : {
        kind: "dated",
        fetchedAt,
        ageSeconds: Math.floor((DateTime.toEpochMillis(now) - DateTime.toEpochMillis(fetchedAt)) / 1000),
      };

const savedBlock = (profile: SavedProfile, now: DateTime.Utc): QuotaBlock => ({
  provider: "claude",
  title: `claude ${profile.name}`,
  body: {
    kind: "saved",
    plan: profile.tier,
    stale: profile.stale,
    age: savedAge(profile.fetched_at, now),
    windows: profile.windows.map((window) => ({
      label: window.label,
      percentLeft: 100 - window.utilization_pct,
      resetsAt: window.resets_at,
    })),
  },
});

const isOtherClaudeProfile = (status: SavedProfiles) => (profile: SavedProfile) =>
  profile.harness === "claude" && profile.provider === "anthropic" && profile.name !== status.active_profile;

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

export const quotaBlocks = (read: QuotaRead, savedProfiles: Reading<SavedProfiles>, now: DateTime.Utc): ReadonlyArray<QuotaBlock> => {
  const active = savedProfiles.kind === "ok" ? savedProfiles.value.active_profile : null;
  const saved =
    savedProfiles.kind === "ok"
      ? savedProfiles.value.profiles.filter(isOtherClaudeProfile(savedProfiles.value)).map((profile) => savedBlock(profile, now))
      : [{ provider: "claude" as const, title: "claude saved", body: failureOf(savedProfiles) }];
  const context: LiveContext = {
    entries: sourcedEntries(read, now),
    notSetUp: read.quotaAxi.kind === "ok" ? read.quotaAxi.value.notSetUp : [],
    title: (entry) => accountTitle(entry, active),
  };
  return [
    ...liveBlocks("claude", providerTitle("claude", active), context),
    ...read.accounts.map(accountBlock),
    ...saved,
    ...liveBlocks("codex", "codex", context),
    ...liveBlocks("opencode-go", "opencode-go", context),
  ];
};
