import { Effect, FileSystem, Path, Schema } from "effect"
import { AbsolutePath, ConfigError, duplicateOf, readJsonFile, readJsonFileIfPresent } from "../json-file"
import { ProviderId } from "../orc-config"
import { type DeliveryMode, isDeliveryMode, unknownMode } from "../delivery"
import { ownedBySweep } from "./machine-reach"

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const Name = Schema.String.check(Schema.isPattern(namePattern))

const Command = Schema.NonEmptyArray(Schema.String.check(Schema.isNonEmpty()))
export type Command = typeof Command.Type

const RawMachine = Schema.Struct({
  name: Name,
  slots: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  start: Command,
  renew: Schema.optionalKey(Command),
  loadLimit: Schema.optionalKey(Schema.Unknown)
})
type RawMachine = typeof RawMachine.Type
export type Machine = Omit<RawMachine, "loadLimit"> & { readonly loadLimit?: number }

const checkedMachine = (machine: RawMachine): Machine | string => {
  const { loadLimit, ...rest } = machine
  if (loadLimit === undefined) {
    return rest
  }
  if (typeof loadLimit !== "number" || loadLimit <= 0) {
    return "the machine " + machine.name + " names the load limit " + JSON.stringify(loadLimit) + ", which is not a number above 0"
  }
  return ownedBySweep(rest)
    ? { ...rest, loadLimit }
    : "the machine " + machine.name + " names a load limit, but its start does not run orc runner start, which the beat reads its load through"
}

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
  machines: Schema.Array(RawMachine),
  quota: Schema.Struct({
    provider: ProviderId,
    command: Command,
    accounts: Schema.Array(Schema.Unknown),
    floorPercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))
  })
})

export type DispatchConfig = Omit<typeof DispatchEnvelope.Type, "machines" | "quota"> & {
  readonly machines: ReadonlyArray<Machine>
  readonly quota: Omit<typeof DispatchEnvelope.Type["quota"], "accounts"> & {
    readonly accounts: ReadonlyArray<Account>
  }
}

const RawProject = Schema.Struct({
  name: Name,
  checkouts: Schema.Record(Name, AbsolutePath),
  mode: Schema.optionalKey(Schema.String),
  yolo: Schema.optionalKey(Schema.Unknown),
  instructions: Schema.optionalKey(Schema.Unknown)
})
type RawProject = typeof RawProject.Type
export type Project = Omit<RawProject, "mode" | "yolo" | "instructions"> & { readonly mode?: DeliveryMode; readonly yolo?: boolean; readonly instructions?: string }

export const modeOf = (project: Project): DeliveryMode => project.mode ?? "no-mistakes"

export const isYolo = (project: Project): boolean => project.yolo === true

const checkedProject = (project: RawProject): Project | string => {
  const { mode, yolo, instructions, ...rest } = project
  if (mode !== undefined && !isDeliveryMode(mode)) {
    return unknownMode(project.name, mode)
  }
  if (yolo !== undefined && typeof yolo !== "boolean") {
    return "the project " + project.name + " names yolo " + JSON.stringify(yolo) + ", which is not true or false"
  }
  if (instructions !== undefined && (typeof instructions !== "string" || instructions === "")) {
    return "the project " + project.name + " names instructions " + JSON.stringify(instructions) + ", which is not a file path"
  }
  return { ...rest, ...(mode === undefined ? {} : { mode }), ...(yolo === undefined ? {} : { yolo }), ...(instructions === undefined ? {} : { instructions }) }
}

const instructionsFile = (file: string, project: Project): Effect.Effect<Project, ConfigError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    if (project.instructions === undefined) {
      return project
    }
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const resolved = path.resolve(path.dirname(file), project.instructions)
    const info = yield* fs.stat(resolved).pipe(Effect.orElseSucceed(() => null))
    if (info?.type !== "File") {
      return yield* new ConfigError({ file, detail: "the project " + project.name + " names the instructions file " + resolved + ", which is no file" })
    }
    return { ...project, instructions: resolved }
  })

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
        const machines: Array<Machine> = []
        for (const entry of config.machines) {
          const checked = checkedMachine(entry)
          if (typeof checked === "string") {
            return yield* new ConfigError({ file, detail: checked })
          }
          machines.push(checked)
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
        return { machines, quota: { ...config.quota, accounts } }
      })
    )
  )

const checkedProjects = (
  file: string,
  projects: ReadonlyArray<RawProject>,
  machines: ReadonlyArray<Machine>
): Effect.Effect<ReadonlyArray<Project>, ConfigError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const duplicate = duplicateOf(projects.map((project) => project.name))
    if (duplicate !== null) {
      return yield* new ConfigError({ file, detail: "the project " + duplicate + " is named twice" })
    }
    const known = new Set(machines.map((machine) => machine.name))
    const checked: Array<Project> = []
    for (const project of projects) {
      const unknown = Object.keys(project.checkouts).find((machine) => !known.has(machine))
      if (unknown !== undefined) {
        return yield* new ConfigError({ file, detail: "the project " + project.name + " names the unknown machine " + unknown })
      }
      const read = checkedProject(project)
      if (typeof read === "string") {
        return yield* new ConfigError({ file, detail: read })
      }
      checked.push(yield* instructionsFile(file, read))
    }
    return checked
  })

export const readProjects = (
  file: string,
  machines: ReadonlyArray<Machine>
): Effect.Effect<ReadonlyArray<Project>, ConfigError, FileSystem.FileSystem | Path.Path> =>
  readJsonFile(file, ProjectsFile).pipe(Effect.flatMap(({ projects }) => checkedProjects(file, projects, machines)))

export interface ProjectInstructions {
  readonly project: string
  readonly file: string
}

export const readProjectInstructions = (file: string): Effect.Effect<ReadonlyArray<ProjectInstructions>, ConfigError, FileSystem.FileSystem | Path.Path> =>
  readJsonFileIfPresent(file, ProjectsFile).pipe(
    Effect.catchTag("ConfigError", () => Effect.succeed(null)),
    Effect.flatMap((read) => {
      const checked = (read?.projects ?? []).map((project) => checkedProject(project))
      const invalid = checked.find((entry): entry is string => typeof entry === "string" && entry.includes(" names instructions "))
      if (invalid !== undefined) {
        return Effect.fail(new ConfigError({ file, detail: invalid }))
      }
      if (checked.some((entry) => typeof entry === "string")) {
        return Effect.succeed<ReadonlyArray<Project>>([])
      }
      return Effect.forEach(
        checked.filter((entry): entry is Project => typeof entry !== "string"),
        (project) => instructionsFile(file, project)
      ).pipe(
        Effect.map((projects) => projects.flatMap((project) => project.instructions === undefined ? [] : [{ project: project.name, file: project.instructions }]))
      )
    })
  )
