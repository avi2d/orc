import { Effect, type FileSystem, Schema } from "effect"
import { AbsolutePath, ConfigError, duplicateOf, readJsonFile } from "../json-file"
import { ProviderId } from "../orc-config"

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

const CredentialKind = Schema.Literals(["token-file", "token-command", "none"])

const RawAccount = Schema.Struct({
  name: Name,
  kind: Schema.optional(CredentialKind),
  tokenFile: Schema.optional(AbsolutePath),
  tokenCommand: Schema.optional(Command)
})
type RawAccount = typeof RawAccount.Type

export type Account =
  | { readonly name: string; readonly kind: "token-file"; readonly tokenFile: string }
  | { readonly name: string; readonly kind: "token-command"; readonly tokenCommand: Command }
  | { readonly name: string; readonly kind: "none" }

const DispatchConfigFile = Schema.Struct({
  machines: Schema.Array(Machine),
  quota: Schema.Struct({
    provider: ProviderId,
    command: Command,
    accounts: Schema.NonEmptyArray(RawAccount),
    floorPercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))
  })
})

export interface DispatchConfig {
  readonly machines: ReadonlyArray<Machine>
  readonly quota: {
    readonly provider: typeof ProviderId.Type
    readonly command: Command
    readonly accounts: ReadonlyArray<Account>
    readonly floorPercent: number
  }
}

const Project = Schema.Struct({
  name: Name,
  checkouts: Schema.Record(Name, AbsolutePath)
})
export type Project = typeof Project.Type

export const checkoutOn = (project: Project, machine: string): string | null =>
  Object.hasOwn(project.checkouts, machine) ? (project.checkouts[machine] ?? null) : null

const ProjectsFile = Schema.Struct({ projects: Schema.Array(Project) })

const accountOf = (file: string, raw: RawAccount): Effect.Effect<Account, ConfigError> => {
  const refuse = (detail: string): Effect.Effect<never, ConfigError> => Effect.fail(new ConfigError({ file, detail }))
  const both = raw.tokenFile !== undefined && raw.tokenCommand !== undefined
  if (raw.kind === undefined) {
    if (both) {
      return refuse("the account " + raw.name + " names both a token file and a token command, so name one source")
    }
    if (raw.tokenFile !== undefined) {
      return Effect.succeed({ name: raw.name, kind: "token-file", tokenFile: raw.tokenFile })
    }
    if (raw.tokenCommand !== undefined) {
      return Effect.succeed({ name: raw.name, kind: "token-command", tokenCommand: raw.tokenCommand })
    }
    return refuse("the account " + raw.name + " names no token file, token command or kind, so its runs would start with no credential")
  }
  if (raw.kind === "token-file") {
    if (raw.tokenFile === undefined) {
      return refuse("the account " + raw.name + " takes kind token-file and names no token file, so its runs would start with no credential")
    }
    if (raw.tokenCommand !== undefined) {
      return refuse("the account " + raw.name + " takes kind token-file and also names a token command, so name one source")
    }
    return Effect.succeed({ name: raw.name, kind: "token-file", tokenFile: raw.tokenFile })
  }
  if (raw.kind === "token-command") {
    if (raw.tokenCommand === undefined) {
      return refuse("the account " + raw.name + " takes kind token-command and names no token command, so its runs would start with no credential")
    }
    if (raw.tokenFile !== undefined) {
      return refuse("the account " + raw.name + " takes kind token-command and also names a token file, so name one source")
    }
    return Effect.succeed({ name: raw.name, kind: "token-command", tokenCommand: raw.tokenCommand })
  }
  if (raw.tokenFile !== undefined || raw.tokenCommand !== undefined) {
    return refuse("the account " + raw.name + " takes kind none and also names a token source, so name no token source for it")
  }
  return Effect.succeed({ name: raw.name, kind: "none" })
}

export const readDispatchConfig = (file: string): Effect.Effect<DispatchConfig, ConfigError, FileSystem.FileSystem> =>
  readJsonFile(file, DispatchConfigFile).pipe(
    Effect.flatMap((config) =>
      Effect.gen(function*() {
        const machine = duplicateOf(config.machines.map((entry) => entry.name))
        if (machine !== null) {
          return yield* new ConfigError({ file, detail: "the machine " + machine + " is named twice" })
        }
        const duplicate = duplicateOf(config.quota.accounts.map((entry) => entry.name))
        if (duplicate !== null) {
          return yield* new ConfigError({ file, detail: "the account " + duplicate + " is named twice" })
        }
        const accounts = yield* Effect.forEach(config.quota.accounts, (entry) => accountOf(file, entry))
        const commandAccount = accounts.find((entry) => entry.kind === "token-command")
        const unrenewed = config.machines.find((entry) => entry.renew === undefined)
        if (commandAccount !== undefined && unrenewed !== undefined) {
          return yield* new ConfigError({ file, detail: "the machine " + unrenewed.name + " has no renew command, which the account " + commandAccount.name + " needs to carry its token past its expiry" })
        }
        const lone = accounts.find((entry) => entry.kind === "none")
        const renewed = config.machines.find((entry) => entry.renew !== undefined)
        if (lone !== undefined && renewed !== undefined) {
          return yield* new ConfigError({ file, detail: "the account " + lone.name + " takes kind none and holds no token, so the machine " + renewed.name + " names a renew command no account here uses" })
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
      for (const project of projects) {
        const unknown = Object.keys(project.checkouts).find((machine) => !known.has(machine))
        if (unknown !== undefined) {
          return Effect.fail(new ConfigError({ file, detail: "the project " + project.name + " names the unknown machine " + unknown }))
        }
      }
      return Effect.succeed(projects)
    })
  )
