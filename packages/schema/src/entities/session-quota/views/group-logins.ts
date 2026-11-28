import type { AccountView } from "./session-quota";

// A log account carries no accountKey and a peer's report may carry no credentialKey or accountKeys, so no one key names the login on both.
export const keysCarried = (account: AccountView): ReadonlyArray<string> => [
  ...(account.accountKey === undefined ? [] : [account.accountKey]),
  ...(account.credentialKey === undefined ? [] : [account.credentialKey]),
  ...account.accountKeys,
  ...account.joins.flatMap((join) => (join.kind === "credential-key" ? [join.key] : [])),
];

interface Member {
  readonly order: number;
  readonly provider: AccountView["provider"];
  readonly keys: ReadonlyArray<string>;
}

const sharesKey = <M extends Member>(login: ReadonlyArray<M>, member: M): boolean =>
  login.some(
    (known) =>
      known.provider === member.provider && known.keys.some((key) => member.keys.includes(key)),
  );

// Accounts sharing any key are one login, transitively. quota-axi leaves a provider's one account unkeyed, so an account with
// no key joins the provider's one keyed login, or the other keyless ones when none is keyed, and stands alone beside two.
export const groupLogins = <M extends Member>(found: ReadonlyArray<M>): ReadonlyArray<ReadonlyArray<M>> => {
  type Login = ReadonlyArray<M>;
  const keyed = found.reduce<ReadonlyArray<Login>>((known, member) => {
    if (member.keys.length === 0) return known;
    const shared = known.filter((login) => sharesKey(login, member));
    return [...known.filter((login) => !shared.includes(login)), [...shared.flat(), member]];
  }, []);
  const all = [...new Set(found.map((member) => member.provider))].flatMap((provider): ReadonlyArray<Login> => {
    const own = keyed.filter((login) => login.at(0)?.provider === provider);
    const keyless = found.filter((member) => member.provider === provider && member.keys.length === 0);
    const only = own.length === 1 ? own.at(0) : undefined;
    if (keyless.length === 0) return own;
    if (only !== undefined) return [[...only, ...keyless]];
    return own.length === 0 ? [keyless] : [...own, ...keyless.map((member) => [member])];
  });
  const firstOf = (login: Login): number => Math.min(...login.map(({ order }) => order));
  return all.map((login) => login.toSorted((left, right) => left.order - right.order)).toSorted((left, right) => firstOf(left) - firstOf(right));
};
