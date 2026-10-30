import { nativeCodexKey } from "../sessions/ledger";
import type { QuotaProviderId } from "../sources/quota";

export type AccountJoin =
  | { readonly kind: "credential-key"; readonly key: string }
  | { readonly kind: "only-account" }
  | { readonly kind: "default-account" };

interface Account {
  readonly provider: QuotaProviderId;
  readonly accountKey?: string | undefined;
  readonly accountKeys?: ReadonlyArray<string>;
}

interface Joined<E extends Account> {
  readonly entry: E;
  readonly join: AccountJoin;
}

interface Evidence {
  readonly provider: QuotaProviderId;
  readonly credentialKey: string | undefined;
}

export const keysOf = (entry: Account): ReadonlyArray<string> =>
  entry.accountKeys ?? (entry.accountKey === undefined ? [] : [entry.accountKey]);

// The key quota-axi gives the login each harness logs under: Codex's own home, and Claude's one undiscovered account.
export const nativeKeys = {
  claude: "default",
  codex: nativeCodexKey,
  "opencode-go": undefined,
} as const satisfies Record<QuotaProviderId, string | undefined>;

// quota-axi lists a coalesced row's winning key first, so a row holding the native login is named by it, as a log read of that login is.
export const credentialKeyOf = (entry: Account): string | undefined => {
  const keys = keysOf(entry);
  const native = nativeKeys[entry.provider];
  return native !== undefined && keys.includes(native) ? native : keys.at(0);
};

const keyedJoin = <E extends Account>(own: ReadonlyArray<E>, key: string): Joined<E> | undefined => {
  const keyed = own.find((entry) => keysOf(entry).includes(key));
  return keyed === undefined ? undefined : { entry: keyed, join: { kind: "credential-key", key } };
};

const assumedJoin = <E extends Account>(own: ReadonlyArray<E>): Joined<E> | undefined => {
  const only = own.length === 1 ? own.at(0) : undefined;
  if (only !== undefined) return { entry: only, join: { kind: "only-account" } };
  const fallback = own.find((entry) => entry.accountKey === undefined || entry.accountKey === "default");
  return fallback === undefined ? undefined : { entry: fallback, join: { kind: "default-account" } };
};

const ownEntries = <E extends Account>(evidence: Evidence, entries: ReadonlyArray<E>): ReadonlyArray<E> =>
  entries.filter((entry) => entry.provider === evidence.provider);

// Logs never name the account, so the credential a Pi key names, or else the provider's only or default account, stands in.
// An account read from a log stands for its own key alone, so a call keyed to another credential is never assumed onto it.
export const callJoin = <E extends Account>(
  evidence: Evidence,
  entries: ReadonlyArray<E>,
  keyedOnly: ReadonlyArray<E>,
): Joined<E> | undefined => {
  const own = ownEntries(evidence, entries);
  if (evidence.credentialKey === undefined) return assumedJoin(own);
  return keyedJoin(own, evidence.credentialKey) ?? assumedJoin(own.filter((entry) => !keyedOnly.includes(entry)));
};

// A vendor reading must not land on an account its own credential key rules out, so a key that matches nothing joins nothing.
export const readingJoin = <E extends Account>(evidence: Evidence, entries: ReadonlyArray<E>): Joined<E> | undefined => {
  const own = ownEntries(evidence, entries);
  return evidence.credentialKey === undefined ? assumedJoin(own) : keyedJoin(own, evidence.credentialKey);
};

export const sameJoin = (left: AccountJoin, right: AccountJoin): boolean =>
  left.kind === right.kind && (left.kind !== "credential-key" || (right.kind === "credential-key" && left.key === right.key));
