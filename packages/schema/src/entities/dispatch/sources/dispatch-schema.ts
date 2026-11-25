import { Result, Schema } from "effect";

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const Name = Schema.String.check(Schema.isPattern(namePattern));

const Command = Schema.NonEmptyArray(Schema.String.check(Schema.isNonEmpty()));

const AbsolutePath = Schema.String.check(Schema.isPattern(/^\//));

const Machine = Schema.Struct({
  name: Name,
  slots: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  start: Command,
  renew: Schema.optionalKey(Command),
});

const ModelRef = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*\/\S+$/));

const route = {
  provider: Schema.optionalKey(Name),
  models: Schema.optionalKey(Schema.Struct({ implementer: ModelRef, fixer: ModelRef })),
};

const Account = Schema.Union([
  Schema.Struct({ name: Name, ...route, kind: Schema.Literal("token-file"), tokenFile: AbsolutePath, tokenCommand: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ name: Name, ...route, kind: Schema.Literal("token-command"), tokenCommand: Command, tokenFile: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ name: Name, ...route, kind: Schema.Literal("claude-config"), configDirs: Schema.Record(Name, AbsolutePath) }),
  Schema.Struct({ name: Name, ...route, kind: Schema.Literal("none"), tokenFile: Schema.optionalKey(Schema.Never), tokenCommand: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ name: Name, ...route, tokenFile: AbsolutePath, tokenCommand: Schema.optionalKey(Schema.Never), kind: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ name: Name, ...route, tokenCommand: Command, tokenFile: Schema.optionalKey(Schema.Never), kind: Schema.optionalKey(Schema.Never) }),
]);

export const MachinesFile = Schema.Struct({
  machines: Schema.Array(Machine),
  quota: Schema.Struct({
    provider: Schema.String.check(Schema.isPattern(namePattern)),
    command: Command,
    accounts: Schema.NonEmptyArray(Account),
    floorPercent: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  }),
});

const Project = Schema.Struct({
  name: Name,
  checkouts: Schema.Record(Name, Schema.String.check(Schema.isPattern(/^\//)))
});

export const ProjectsFile = Schema.Struct({ projects: Schema.Array(Project) });

export const strictAccount = (entry: unknown): string | undefined => {
  const result = Schema.decodeUnknownResult(Account)(entry, { errors: "all", onExcessProperty: "error" });
  return Result.isSuccess(result) ? undefined : result.failure.message;
};

const AccountsEnvelope = Schema.Struct({ quota: Schema.Struct({ accounts: Schema.Array(Schema.Unknown) }) });

export const rawAccounts = (value: unknown): ReadonlyArray<unknown> => {
  const decoded = Schema.decodeUnknownResult(AccountsEnvelope)(value);
  return Result.isSuccess(decoded) ? decoded.success.quota.accounts : [];
};

type Quota = typeof MachinesFile.Type["quota"];

// A kind none account names no login of its own, so a second account on its provider would spend that same login.
export const sharedLoginProblem = (quota: Quota): string | null => {
  const providerOf = (account: Quota["accounts"][number]): string => account.provider ?? quota.provider;
  for (const account of quota.accounts) {
    if (!("kind" in account) || account.kind !== "none") continue;
    const own = providerOf(account);
    const other = quota.accounts.find((entry) => entry !== account && providerOf(entry) === own);
    if (other !== undefined) {
      return "the account " + account.name + " takes kind none and names no login, so no other account runs on its provider " + own + ", but " + other.name + " does";
    }
  }
  return null;
};

export const duplicateOf = (names: ReadonlyArray<string>): string | null => names.find((name, index) => names.indexOf(name) !== index) ?? null;