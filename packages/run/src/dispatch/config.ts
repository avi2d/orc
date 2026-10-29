import { Effect, type FileSystem, Schema } from "effect"
import { AbsolutePath, ConfigError, duplicateOf, readJsonFile } from "../json-file"

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const Name = Schema.String.check(Schema.isPattern(namePattern))

const Machine = Schema.Struct({
  name: Name,
  slots: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  start: Schema.NonEmptyArray(Schema.String.check(Schema.isNonEmpty()))
})
export type Machine = typeof Machine.Type

const DispatchConfigFile = Schema.Struct({
  machines: Schema.Array(Machine),
  quota: Schema.Struct({
    accounts: Schema.NonEmptyArray(Name),
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
      const duplicate = duplicateOf(config.machines.map((machine) => machine.name))
      return duplicate === null
        ? Effect.succeed(config)
        : Effect.fail(new ConfigError({ file, detail: "the machine " + duplicate + " is named twice" }))
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
