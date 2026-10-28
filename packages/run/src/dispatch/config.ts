import { Data, Effect, FileSystem, Schema } from "effect"

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const Name = Schema.String.check(Schema.isPattern(namePattern))

const Machine = Schema.Struct({
  name: Name,
  slots: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  start: Schema.NonEmptyArray(Schema.String.check(Schema.isNonEmpty()))
})
export type Machine = typeof Machine.Type

const AbsolutePath = Schema.String.check(Schema.isPattern(/^\//))

const Account = Schema.Struct({
  name: Name,
  tokenFile: AbsolutePath
})
export type Account = typeof Account.Type

const DispatchConfigFile = Schema.Struct({
  machines: Schema.Array(Machine),
  quota: Schema.Struct({
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

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly file: string
  readonly detail: string
}> {}

const duplicateOf = (names: ReadonlyArray<string>): string | null =>
  names.find((name, index) => names.indexOf(name) !== index) ?? null

const readJsonFile = <S extends Schema.Top>(
  file: string,
  schema: S
): Effect.Effect<S["Type"], ConfigError, FileSystem.FileSystem | S["DecodingServices"]> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(file).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.fail(new ConfigError({ file, detail: "the file is missing" }))),
      Effect.mapError((error) => error instanceof ConfigError ? error : new ConfigError({ file, detail: error.message }))
    )
    const raw: unknown = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => new ConfigError({ file, detail: "the file is no JSON" })
    })
    return yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
      Effect.mapError((error) => new ConfigError({ file, detail: error.message }))
    )
  })

export const readDispatchConfig = (file: string): Effect.Effect<DispatchConfig, ConfigError, FileSystem.FileSystem> =>
  readJsonFile(file, DispatchConfigFile).pipe(
    Effect.flatMap((config) => {
      const machine = duplicateOf(config.machines.map((entry) => entry.name))
      if (machine !== null) {
        return Effect.fail(new ConfigError({ file, detail: "the machine " + machine + " is named twice" }))
      }
      const account = duplicateOf(config.quota.accounts.map((entry) => entry.name))
      return account === null
        ? Effect.succeed(config)
        : Effect.fail(new ConfigError({ file, detail: "the account " + account + " is named twice" }))
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
