import { Effect, type FileSystem, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { type Command, type ConfigError, type Machine, ownedBySweep, throughFor } from "../../shared/config/index"
import { askMachine, readDispatchMachines } from "./other-machines"

const VersionJsonSchema = Schema.Struct({
  schema: Schema.Literal("orc.version.v1"),
  version: Schema.String
})

const MachinesJsonSchema = Schema.Struct({
  schema: Schema.Literal("orc.machines.v1"),
  machines: Schema.Array(Schema.Union([
    Schema.Struct({ machine: Schema.String, version: Schema.String }),
    Schema.Struct({ machine: Schema.String, error: Schema.String })
  ]))
})

type MachinesJsonDocument = typeof MachinesJsonSchema.Type
type MachineVersion = MachinesJsonDocument["machines"][number]

export const encodeVersionJson = (version: string): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(VersionJsonSchema)({ schema: "orc.version.v1", version }).pipe(Effect.map((encoded) => JSON.stringify(encoded)))

export const decodeVersionJson = (value: unknown): Effect.Effect<typeof VersionJsonSchema.Type, Schema.SchemaError> => Schema.decodeUnknownEffect(VersionJsonSchema)(value)

export const encodeMachinesJson = (document: MachinesJsonDocument): Effect.Effect<string, Schema.SchemaError> =>
  Schema.encodeEffect(MachinesJsonSchema)(document).pipe(Effect.map((encoded) => JSON.stringify(encoded)))

const localVersionOf = (through: Command): Command => [...through, "version", "--json", "--local"]

const versionOf = (machine: Machine, localVersion: string): Effect.Effect<ReadonlyArray<MachineVersion>, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const through = throughFor(machine)
  if (through === null) {
    return Effect.succeed(ownedBySweep(machine) ? [{ machine: machine.name, version: localVersion }] : [])
  }
  return askMachine(localVersionOf(through), decodeVersionJson).pipe(
    Effect.map((document): ReadonlyArray<MachineVersion> => [{ machine: machine.name, version: document.version }]),
    Effect.catch((error) => Effect.succeed([{ machine: machine.name, error: error.detail }]))
  )
}

export const readMachineVersions = (dispatchFile: string, localVersion: string): Effect.Effect<MachinesJsonDocument, ConfigError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> =>
  readDispatchMachines(dispatchFile).pipe(
    Effect.flatMap((machines) => Effect.forEach(machines, (machine) => versionOf(machine, localVersion), { concurrency: "unbounded" })),
    Effect.map((rows) => ({ schema: "orc.machines.v1", machines: rows.flat() }))
  )


