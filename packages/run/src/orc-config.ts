import { Effect, type FileSystem, Schema } from "effect"
import { AbsolutePath, ConfigError, duplicateOf, readJsonFileIfPresent } from "./json-file"

export const ProviderId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/))

const EnvVarName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/))

const ModelRef = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*\/\S+$/))

const HeaderToken = Schema.String.check(Schema.makeFilter((value) => /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(value)))

const CredentialFormat = Schema.String.check(Schema.makeFilter((value) => value.length > 0 && value.indexOf("{}") !== -1 && value.indexOf("{}") === value.lastIndexOf("{}")))

const NonoEntry = Schema.Struct({
  upstream: Schema.String.check(Schema.isPattern(/^https:\/\/\S+$/)),
  injectHeader: Schema.optionalKey(HeaderToken),
  credentialFormat: Schema.optionalKey(CredentialFormat)
})

const LoginProvider = Schema.Struct({
  id: ProviderId,
  credential: Schema.Literal("pi-login"),
  nono: Schema.optional(NonoEntry)
})
export type LoginProvider = typeof LoginProvider.Type

const TokenFileLocation = Schema.Union([
  Schema.Struct({ env: EnvVarName }),
  Schema.Struct({ path: AbsolutePath })
])
export type TokenFileLocation = typeof TokenFileLocation.Type

// The nono sandbox captures a key only through a Pi login, so a token-file provider has no nono entry to name.
const TokenFileProvider = Schema.Struct({
  id: ProviderId,
  credential: Schema.Literal("token-file"),
  tokenFile: TokenFileLocation
})
export type TokenFileProvider = typeof TokenFileProvider.Type

// Pi resolves a relative local path against the settings file, which here sits in the run's own Pi folder.
const PiPackageSource = Schema.String.check(Schema.isPattern(/^(?:\/\S(?:.*\S)?|(?:npm:|git:|https?:\/\/|ssh:\/\/)\S+)$/))

const PackageProvider = Schema.Struct({
  id: ProviderId,
  credential: Schema.Literal("package"),
  packages: Schema.NonEmptyArray(PiPackageSource),
  env: Schema.optionalKey(Schema.Record(EnvVarName, Schema.String))
})
export type PackageProvider = typeof PackageProvider.Type

const Provider = Schema.Union([LoginProvider, TokenFileProvider, PackageProvider])
export type Provider = typeof Provider.Type

const OrcConfigFile = Schema.Struct({
  providers: Schema.Array(Provider),
  models: Schema.optional(Schema.Struct({
    implementer: Schema.optional(ModelRef),
    fixer: Schema.optional(ModelRef)
  }))
})
type OrcConfigFile = typeof OrcConfigFile.Type

export interface OrcConfig extends OrcConfigFile {
  readonly file: string
}

const orcConfigFile = (orcHome: string): string => orcHome + "/config.json"

export const readOrcConfig = (orcHome: string): Effect.Effect<OrcConfig, ConfigError, FileSystem.FileSystem> => {
  const file = orcConfigFile(orcHome)
  return readJsonFileIfPresent(file, OrcConfigFile, { onExcessProperty: "error" }).pipe(
    Effect.flatMap((config) => {
      const read = config ?? { providers: [] }
      const duplicate = duplicateOf(read.providers.map((provider) => provider.id))
      return duplicate === null
        ? Effect.succeed({ ...read, file })
        : Effect.fail(new ConfigError({ file, detail: "the provider " + duplicate + " is named twice" }))
    })
  )
}
