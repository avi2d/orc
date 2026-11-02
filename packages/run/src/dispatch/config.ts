import { Effect, type FileSystem, Schema } from "effect"
import { AbsolutePath, ConfigError, duplicateOf, readJsonFile } from "../json-file"
import { ProviderId } from "../orc-config"
import { type DeliveryMode, isDeliveryMode, unknownMode } from "../delivery"

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const Name = Schema.String.check(Schema.isPattern(namePattern))

const Command = Schema.NonEmptyArray(Schema.String.check(Schema.isNonEmpty()))
export type Command = typeof Command.Type

const Machine = Schema.Struct({
  name: Name,
  slots: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  start: Command,
  renew: Schema.optionalKey(Command)
})
export type Machine = typeof Machine.Type

const TokenFileAccount = Schema.Struct({
  name: Name,
  kind: Schema.Literal("token-file"),
  tokenFile: AbsolutePath
})
const TokenCommandAccount = Schema.Struct({
  name: Name,
  kind: Schema.Literal("token-command"),
  tokenCommand: Command
})
const NoneAccount = Schema.Struct({
  name: Name,
  kind: Schema.Literal("none")
})
const LegacyTokenFileAccount = Schema.Struct({
  name: Name,
  tokenFile: AbsolutePath
})
const LegacyTokenCommandAccount = Schema.Struct({
  name: Name,
  tokenCommand: Command
})

const AnyAccount = Schema.Union([TokenFileAccount, TokenCommandAccount, NoneAccount, LegacyTokenFileAccount, LegacyTokenCommandAccount])
type RawAccount = typeof AnyAccount.Type
export type Account = Extract<RawAccount, { readonly kind: "token-file" | "token-command" | "none" }>

const tagAccount = (account: RawAccount): Account =>
  "kind" in account
    ? account
    : "tokenFile" in account
      ? { ...account, kind: "token-file" as const }
      : { ...account, kind: "token-command" as const }

const DispatchEnvelope = Schema.Struct({
  machines: Schema.Array(Machine),
  quota: Schema.Struct({
    provider: ProviderId,
    command: Command,
    accounts: Schema.Array(Schema.Unknown),
    floorPercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))
  })
})

export type DispatchConfig = Omit<typeof DispatchEnvelope.Type, "quota"> & {
  readonly quota: Omit<typeof DispatchEnvelope.Type["quota"], "accounts"> & {
    readonly accounts: ReadonlyArray<Account>
  }
}

const RawProject = Schema.Struct({
  name: Name,
  checkouts: Schema.Record(Name, AbsolutePath),
  mode: Schema.optionalKey(Schema.String)
})
type RawProject = typeof RawProject.Type
export type Project = Omit<RawProject, "mode"> & { readonly mode?: DeliveryMode }

export const modeOf = (project: Project): DeliveryMode => project.mode ?? "no-mistakes"

const checkedMode = (project: RawProject): Project | null => {
  const { mode, ...rest } = project
  if (mode === undefined) {
    return rest
  }
  return isDeliveryMode(mode) ? { ...rest, mode } : null
}

export const checkoutOn = (project: Project, machine: string): string | null =>
  Object.hasOwn(project.checkouts, machine) ? (project.checkouts[machine] ?? null) : null

const ProjectsFile = Schema.Struct({ projects: Schema.Array(RawProject) })

const accountName = (entry: unknown): string | null =>
  typeof entry === "object" && entry !== null && "name" in entry && typeof entry.name === "string" && entry.name !== "" ? entry.name : null

const accountDetail = (name: string | null, reason: string): string =>
  (name === null ? "an account with no name" : "the account " + name) + " names a credential the beat cannot take: " + reason

const readAccount = (file: string, entry: unknown): Effect.Effect<Account, ConfigError> =>
  Schema.decodeUnknownEffect(AnyAccount)(entry, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) => new ConfigError({ file, detail: accountDetail(accountName(entry), error.message) })),
    Effect.map(tagAccount)
  )

export const readDispatchConfig = (file: string): Effect.Effect<DispatchConfig, ConfigError, FileSystem.FileSystem> =>
  readJsonFile(file, DispatchEnvelope).pipe(
    Effect.flatMap((config) =>
      Effect.gen(function*() {
        const machine = duplicateOf(config.machines.map((entry) => entry.name))
        if (machine !== null) {
          return yield* new ConfigError({ file, detail: "the machine " + machine + " is named twice" })
        }
        if (config.quota.accounts.length === 0) {
          return yield* new ConfigError({ file, detail: "the quota names no account" })
        }
        const names = config.quota.accounts.map(accountName)
        const duplicate = duplicateOf(names.filter((name) => name !== null))
        if (duplicate !== null) {
          return yield* new ConfigError({ file, detail: "the account " + duplicate + " is named twice" })
        }
        const accounts = yield* Effect.forEach(config.quota.accounts, (entry) => readAccount(file, entry))
        const single = accounts.find((entry) => entry.kind === "none")
        if (single !== undefined && accounts.length > 1) {
          return yield* new ConfigError({ file, detail: "the account " + single.name + " takes kind none and names no login, so the quota names no other account beside it" })
        }
        const commandAccount = accounts.find((entry) => entry.kind === "token-command")
        const unrenewed = config.machines.find((entry) => entry.renew === undefined)
        if (commandAccount !== undefined && unrenewed !== undefined) {
          return yield* new ConfigError({ file, detail: "the machine " + unrenewed.name + " has no renew command, which the account " + commandAccount.name + " needs to carry its token past its expiry" })
        }
        const renewed = config.machines.find((entry) => entry.renew !== undefined)
        if (single !== undefined && renewed !== undefined) {
          return yield* new ConfigError({ file, detail: "the account " + single.name + " takes kind none and holds no token, so the machine " + renewed.name + " names a renew command it never takes" })
        }
        return { machines: config.machines, quota: { ...config.quota, accounts } }
      })
    )
  )

export const readProjects = (
  file: string,
  machines: ReadonlyArray<Machine>
): Effect.Effect<ReadonlyArray<Project>, ConfigError, FileSystem.FileSystem> =>
  readJsonFile(file, ProjectsFile).pipe(
    Effect.flatMap(({ projects }) => {
      const duplicate = duplicateOf(projects.map((project) => project.name))
      if (duplicate !== null) {
        return Effect.fail(new ConfigError({ file, detail: "the project " + duplicate + " is named twice" }))
      }
      const known = new Set(machines.map((machine) => machine.name))
      const checked: Array<Project> = []
      for (const project of projects) {
        const unknown = Object.keys(project.checkouts).find((machine) => !known.has(machine))
        if (unknown !== undefined) {
          return Effect.fail(new ConfigError({ file, detail: "the project " + project.name + " names the unknown machine " + unknown }))
        }
        const moded = checkedMode(project)
        if (moded === null) {
          return Effect.fail(new ConfigError({ file, detail: unknownMode(project.name, project.mode ?? "") }))
        }
        checked.push(moded)
      }
      return Effect.succeed(checked)
    })
  )
