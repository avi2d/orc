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

const Account = Schema.Union([
  Schema.Struct({ name: Name, tokenFile: AbsolutePath, tokenCommand: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ name: Name, tokenCommand: Command, tokenFile: Schema.optionalKey(Schema.Never) })
])
export type Account = typeof Account.Type

const DispatchConfigFile = Schema.Struct({
  machines: Schema.Array(Machine),
  quota: Schema.Struct({
    provider: ProviderId,
    command: Command,
    accounts: Schema.NonEmptyArray(Account),
    floorPercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))
  })
})
export type DispatchConfig = typeof DispatchConfigFile.Type

const Project = Schema.Struct({
  name: Name,
  checkouts: Schema.Record(Name, AbsolutePath)
})
export type Project = typeof Project.Type

export const checkoutOn = (project: Project, machine: string): string | null =>
  Object.hasOwn(project.checkouts, machine) ? (project.checkouts[machine] ?? null) : null

const ProjectsFile = Schema.Struct({ projects: Schema.Array(Project) })

export const readDispatchConfig = (file: string): Effect.Effect<DispatchConfig, ConfigError, FileSystem.FileSystem> =>
  readJsonFile(file, DispatchConfigFile).pipe(
    Effect.flatMap((config) => {
      const machine = duplicateOf(config.machines.map((entry) => entry.name))
      if (machine !== null) {
        return Effect.fail(new ConfigError({ file, detail: "the machine " + machine + " is named twice" }))
      }
      const account = duplicateOf(config.quota.accounts.map((entry) => entry.name))
      if (account !== null) {
        return Effect.fail(new ConfigError({ file, detail: "the account " + account + " is named twice" }))
      }
      const commandAccount = config.quota.accounts.find((entry) => entry.tokenCommand !== undefined)
      const unrenewed = config.machines.find((entry) => entry.renew === undefined)
      return commandAccount !== undefined && unrenewed !== undefined
        ? Effect.fail(new ConfigError({ file, detail: "the machine " + unrenewed.name + " has no renew command, which the account " + commandAccount.name + " needs to carry its token past its expiry" }))
        : Effect.succeed(config)
    })
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
