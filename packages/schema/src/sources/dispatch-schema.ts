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

const Account = Schema.Union([
  Schema.Struct({ name: Name, kind: Schema.Literal("token-file"), tokenFile: AbsolutePath, tokenCommand: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ name: Name, kind: Schema.Literal("token-command"), tokenCommand: Command, tokenFile: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ name: Name, kind: Schema.Literal("none"), tokenFile: Schema.optionalKey(Schema.Never), tokenCommand: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ name: Name, tokenFile: AbsolutePath, tokenCommand: Schema.optionalKey(Schema.Never), kind: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ name: Name, tokenCommand: Command, tokenFile: Schema.optionalKey(Schema.Never), kind: Schema.optionalKey(Schema.Never) }),
]);

export const MachinesFile = Schema.Struct({
  machines: Schema.Array(Machine),
  quota: Schema.Struct({
    provider: Schema.String.check(Schema.isPattern(namePattern)),
    command: Command,
    accounts: Schema.NonEmptyArray(Account),
    floorPercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  }),
});

const Project = Schema.Struct({ name: Name, checkouts: Schema.Record(Name, Schema.String.check(Schema.isPattern(/^\//))) });

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

export const duplicateOf = (names: ReadonlyArray<string>): string | null => names.find((name, index) => names.indexOf(name) !== index) ?? null;