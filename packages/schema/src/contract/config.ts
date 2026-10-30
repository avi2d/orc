import { Effect, Result, Schema } from "effect";
import { type Decoded, decoded, rejected } from "../decode";

const accountNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

// One spelling for each folder, so two accounts on one folder are two equal strings.
const AccountFolder = Schema.String.check(
  Schema.isPattern(/^(?:\/(?!\.\.?(?:\/|$))[^/]+)+$/u, { expected: "an absolute folder path with no trailing slash and no ., .. or empty part" }),
);

const misnamedAccount = (accounts: Readonly<Record<string, string>>): string | undefined => {
  const misnamed = Object.keys(accounts).find((name) => !accountNamePattern.test(name));
  return misnamed === undefined
    ? undefined
    : `account name ${JSON.stringify(misnamed)} must start with a letter or digit and hold only letters, digits, dots, dashes and underscores`;
};

const sharedFolder = (accounts: Readonly<Record<string, string>>): string | undefined => {
  const entries = Object.entries(accounts);
  const shared = entries.find(([name, folder]) => entries.some(([other, otherFolder]) => other !== name && otherFolder === folder));
  if (shared === undefined) return undefined;
  const names = entries.filter(([, folder]) => folder === shared[1]).map(([name]) => name);
  return `accounts ${names.join(" and ")} name the one folder ${shared[1]}, and each account needs a Claude config folder of its own`;
};

const Accounts = Schema.Record(Schema.String, AccountFolder).check(Schema.makeFilter(misnamedAccount), Schema.makeFilter(sharedFolder));

// Each section is decoded by the package that owns it, so this file knows only the top-level keys.
export const DashConfig = Schema.Struct({
  appearance: Schema.optionalKey(Schema.Unknown),
  accounts: Schema.optionalKey(Accounts),
  panels: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  layout: Schema.optionalKey(Schema.Unknown),
});

export type DashConfig = typeof DashConfig.Type;

export interface ClaudeAccount {
  readonly name: string;
  readonly folder: string;
}

export const claudeAccountsOf = (config: DashConfig): ReadonlyArray<ClaudeAccount> =>
  Object.entries(config.accounts ?? {}).map(([name, folder]) => ({ name, folder }));

export const emptyConfig: DashConfig = { panels: {} };

// A misspelt key would otherwise leave its section on the default without a word.
export const strictly = { errors: "all", onExcessProperty: "error" } as const;

export const parsedJson = (text: string): Decoded<unknown> => {
  const parsed = Result.try((): unknown => JSON.parse(text));
  return Result.isSuccess(parsed) ? decoded(parsed.success) : rejected("the text is not JSON");
};

export const decodeDashConfig = (raw: unknown): Decoded<DashConfig> => {
  const config = Schema.decodeUnknownResult(DashConfig)(raw, strictly);
  return Result.isSuccess(config) ? decoded(config.success) : rejected(config.failure.message);
};
