import { Effect, FileSystem, Path, Result, Schema } from "effect"
import { AbsolutePath, ConfigError, duplicateOf, readJsonFile, readJsonFileIfPresent } from "./json-file"
import { ModelRef, ProviderId } from "./orc-config"
import { providerOfModel } from "./model-route"
import { DispatchRouting, readRouting } from "./dispatch-routing"
import { type Contribution, parsedUpstream } from "./contribution"
import { type DeliveryMode, isDeliveryMode, unknownMode } from "./delivery"
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

const ownProvider = {
  provider: Schema.optionalKey(ProviderId),
  models: Schema.optionalKey(Schema.Struct({ implementer: ModelRef, fixer: ModelRef }))
}

const TokenFileAccount = Schema.Struct({
  name: Name,
  ...ownProvider,
  kind: Schema.Literal("token-file"),
  tokenFile: AbsolutePath
})
const TokenCommandAccount = Schema.Struct({
  name: Name,
  ...ownProvider,
  kind: Schema.Literal("token-command"),
  tokenCommand: Command
})
const ClaudeConfigAccount = Schema.Struct({
  name: Name,
  ...ownProvider,
  kind: Schema.Literal("claude-config"),
  configDirs: Schema.Record(Name, AbsolutePath)
})
const NoneAccount = Schema.Struct({
  name: Name,
  ...ownProvider,
  kind: Schema.Literal("none")
})
const LegacyTokenFileAccount = Schema.Struct({
  name: Name,
  ...ownProvider,
  tokenFile: AbsolutePath
})
const LegacyTokenCommandAccount = Schema.Struct({
  name: Name,
  ...ownProvider,
  tokenCommand: Command
})

const AnyAccount = Schema.Union([TokenFileAccount, TokenCommandAccount, ClaudeConfigAccount, NoneAccount, LegacyTokenFileAccount, LegacyTokenCommandAccount])
type RawAccount = typeof AnyAccount.Type
export type Account = Extract<RawAccount, { readonly kind: "token-file" | "token-command" | "claude-config" | "none" }>

const tagAccount = (account: RawAccount): Account =>
  "kind" in account
    ? account
    : "tokenFile" in account
      ? { ...account, kind: "token-file" as const }
      : { ...account, kind: "token-command" as const }

const DispatchEnvelope = Schema.Struct({
  routing: Schema.optionalKey(Schema.Unknown),
  machines: Schema.Array(RawMachine),
  quota: Schema.Struct({
    provider: ProviderId,
    command: Command,
    accounts: Schema.Array(Schema.Unknown),
    floorPercent: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })))
  })
})

export type DispatchConfig = {
  readonly routing?: DispatchRouting
  readonly machines: ReadonlyArray<Machine>
  readonly quota: Omit<typeof DispatchEnvelope.Type["quota"], "accounts" | "floorPercent"> & {
    readonly floorPercent: number
    readonly accounts: ReadonlyArray<Account>
  }
}

const RawProject = Schema.Struct({
  name: Name,
  checkouts: Schema.Record(Name, AbsolutePath),
  mode: Schema.optionalKey(Schema.String),
  yolo: Schema.optionalKey(Schema.Unknown),
  instructions: Schema.optionalKey(Schema.Unknown),
  floor: Schema.optionalKey(Schema.Unknown),
  upstream: Schema.optionalKey(Schema.Unknown)
})
type RawProject = typeof RawProject.Type

export type Project = Omit<RawProject, "mode" | "yolo" | "instructions" | "floor" | "upstream"> & {
  readonly mode?: DeliveryMode
  readonly yolo?: boolean
  readonly floor?: number
  readonly instructions?: string
  readonly upstream?: ReadonlyArray<Contribution>
}

export const providerOf = (quota: { readonly provider: string }, account: { readonly provider?: string }): string => account.provider ?? quota.provider

export const modeOf = (project: Project): DeliveryMode => project.mode ?? "no-mistakes"

export const isYolo = (project: Project): boolean => project.yolo === true

type ParsedInstructions = { readonly name: string; readonly instructions?: string }

const parsedInstructions = (project: { readonly name: string; readonly instructions?: unknown }): ParsedInstructions | string => {
  const { name, instructions } = project
  if (instructions !== undefined && (typeof instructions !== "string" || instructions === "")) {
    return "the project " + name + " names instructions " + JSON.stringify(instructions) + ", which is not a file path"
  }
  return instructions === undefined ? { name } : { name, instructions }
}

const checkedProject = (project: RawProject): Project | string => {
  const { mode, yolo, floor } = project
  if (mode !== undefined && !isDeliveryMode(mode)) {
    return unknownMode(project.name, mode)
  }
  if (yolo !== undefined && typeof yolo !== "boolean") {
    return "the project " + project.name + " names yolo " + JSON.stringify(yolo) + ", which is not true or false"
  }
  if (floor !== undefined && (typeof floor !== "number" || !Number.isInteger(floor) || floor < 0 || floor > 4)) {
    return "the project " + project.name + " names the floor " + JSON.stringify(floor) + ", which is not a priority from 0 to 4"
  }
  const parsed = parsedInstructions(project)
  if (typeof parsed === "string") {
    return parsed
  }
  const upstream = project.upstream === undefined ? undefined : parsedUpstream(project.name, project.upstream)
  if (typeof upstream === "string") {
    return upstream
  }
  return {
    name: project.name,
    checkouts: project.checkouts,
    ...(mode === undefined ? {} : { mode }),
    ...(yolo === undefined ? {} : { yolo }),
    ...(floor === undefined ? {} : { floor }),
    ...(parsed.instructions === undefined ? {} : { instructions: parsed.instructions }),
    ...(upstream === undefined ? {} : { upstream })
  }
}

const instructionsFile = <T extends ParsedInstructions>(file: string, project: T): Effect.Effect<T, ConfigError, FileSystem.FileSystem | Path.Path> =>
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

const LooseProjectsFile = Schema.Struct({ projects: Schema.Array(Schema.Unknown) })

const looseInstructions = (entry: unknown): ParsedInstructions | string | null => {
  if (typeof entry !== "object" || entry === null || !("instructions" in entry)) {
    return null
  }
  const record = entry as { readonly name?: unknown; readonly instructions?: unknown }
  if (typeof record.name !== "string" || record.name === "") {
    return null
  }
  return parsedInstructions({ name: record.name, instructions: record.instructions })
}

const accountName = (entry: unknown): string | null =>
  typeof entry === "object" && entry !== null && "name" in entry && typeof entry.name === "string" && entry.name !== "" ? entry.name : null

const accountDetail = (name: string | null, reason: string): string =>
  (name === null ? "an account with no name" : "the account " + name) + " has an invalid configuration: " + reason

const readAccount = (file: string, entry: unknown): Effect.Effect<Account, ConfigError> =>
  Schema.decodeUnknownEffect(AnyAccount)(entry, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) => new ConfigError({ file, detail: accountDetail(accountName(entry), error.message) })),
    Effect.map(tagAccount)
  )

// A machine's config.json names one implementer and one fixer model, which serve the quota's provider only.
const accountModelsProblem = (provider: string, accounts: ReadonlyArray<Account>): string | null => {
  for (const account of accounts) {
    const own = providerOf({ provider }, account)
    if (account.models === undefined) {
      if (own !== provider) {
        return "the account " + account.name + " runs on the provider " + own + ", not the quota's provider " + provider + ", so name the implementer and fixer models from " + own + " in its models"
      }
      continue
    }
    const foreign = [account.models.implementer, account.models.fixer].find((model) => providerOfModel(model) !== own)
    if (foreign !== undefined) {
      return "the account " + account.name + " runs on the provider " + own + " and names the model " + foreign + ", which is not from " + own
    }
  }
  return null
}

// A kind none account names no login of its own, so a second account on its provider would spend that same login.
const sharedLoginProblem = (provider: string, accounts: ReadonlyArray<Account>): string | null => {
  const on = (account: Account): string => providerOf({ provider }, account)
  for (const account of accounts.filter((entry) => entry.kind === "none")) {
    const other = accounts.find((entry) => entry !== account && on(entry) === on(account))
    if (other !== undefined) return "the account " + account.name + " takes kind none and names no login, so no other account runs on its provider " + on(account) + ", but " + other.name + " does"
  }
  return null
}

const claudeConfigProblem = (accounts: ReadonlyArray<Account>, machines: ReadonlyArray<Machine>): string | null => {
  for (const account of accounts) {
    if (account.kind !== "claude-config") continue
    for (const machine of machines) {
      if (!Object.hasOwn(account.configDirs, machine.name)) {
        return "the account " + account.name + " names no Claude config directory for " + machine.name
      }
    }
  }
  return null
}

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
        const accountProblem = claudeConfigProblem(accounts, machines) ?? accountModelsProblem(config.quota.provider, accounts) ?? sharedLoginProblem(config.quota.provider, accounts)
        if (accountProblem !== null) return yield* new ConfigError({ file, detail: accountProblem })
        const tokenless = accounts.find((entry) => entry.kind === "none")
        const commandAccount = accounts.find((entry) => entry.kind === "token-command")
        const unrenewed = config.machines.find((entry) => entry.renew === undefined)
        if (commandAccount !== undefined && unrenewed !== undefined) {
          return yield* new ConfigError({ file, detail: "the machine " + unrenewed.name + " has no renew command, which the account " + commandAccount.name + " needs to carry its token past its expiry" })
        }
        const renewed = config.machines.find((entry) => entry.renew !== undefined)
        if (tokenless !== undefined && commandAccount === undefined && renewed !== undefined) return yield* new ConfigError({ file, detail: "the machine " + renewed.name + " names a renew command it never takes, because no account uses a token command" })
        const quota = { ...config.quota, floorPercent: config.quota.floorPercent ?? 0, accounts }
        if (config.routing === undefined) {
          return { machines, quota }
        }
        const routing = yield* readRouting(file, config.routing, accounts.map((account) => ({ name: account.name, provider: providerOf(quota, account) })))
        return { machines, quota, routing }
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
  readJsonFileIfPresent(file, LooseProjectsFile).pipe(
    Effect.catchTag("ConfigError", () => Effect.succeed(null)),
    Effect.flatMap((read) => {
      const list = read?.projects ?? []
      const parsed: Array<ParsedInstructions> = []
      for (const entry of list) {
        const found = looseInstructions(entry)
        if (found === null) {
          continue
        }
        if (typeof found === "string") {
          return Effect.fail(new ConfigError({ file, detail: found }))
        }
        parsed.push(found)
      }
      return Effect.forEach(parsed, (entry) => instructionsFile(file, entry)).pipe(
        Effect.flatMap((resolved) => {
          const decoded = Schema.decodeUnknownResult(ProjectsFile)({ projects: list })
          if (!Result.isSuccess(decoded)) {
            return Effect.succeed<ReadonlyArray<ProjectInstructions>>([])
          }
          if (duplicateOf(decoded.success.projects.map((project) => project.name)) !== null) {
            return Effect.succeed<ReadonlyArray<ProjectInstructions>>([])
          }
          for (const project of decoded.success.projects) {
            if (typeof checkedProject(project) === "string") {
              return Effect.succeed<ReadonlyArray<ProjectInstructions>>([])
            }
          }
          return Effect.succeed(resolved.flatMap((entry) => entry.instructions === undefined ? [] : [{ project: entry.name, file: entry.instructions }]))
        })
      )
    })
  )
