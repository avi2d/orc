import { Effect, FileSystem, Path, Result, Schema } from "effect"
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
const ClaudeConfigAccount = Schema.Struct({
  name: Name,
  kind: Schema.Literal("claude-config"),
  configDirs: Schema.Record(Name, AbsolutePath)
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
  machines: Schema.Array(RawMachine),
  quota: Schema.Struct({
    provider: ProviderId,
    command: Command,
    accounts: Schema.Array(Schema.Unknown),
    floorPercent: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })))
  })
})

export type DispatchConfig = Omit<typeof DispatchEnvelope.Type, "machines" | "quota"> & {
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
  upstream: Schema.optionalKey(Schema.Unknown)
})
type RawProject = typeof RawProject.Type

export interface Contribution {
  readonly url: string
  readonly owner: string
  readonly repo: string
  readonly number: number
}

export type Project = Omit<RawProject, "mode" | "yolo" | "instructions" | "upstream"> & {
  readonly mode?: DeliveryMode
  readonly yolo?: boolean
  readonly instructions?: string
  readonly upstream?: ReadonlyArray<Contribution>
}

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

// GitHub ignores case in owner and repository names and numbers issues and pull requests from one sequence, and an owner holds no dot.
export const contributionId = (contribution: Contribution): string =>
  contribution.owner.toLowerCase() + "." + contribution.repo.toLowerCase() + "." + String(contribution.number)

const contributionPattern = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/([1-9]\d*)$/

const notUpstream = (name: string, value: unknown): string =>
  "the project " + name + " names upstream " + JSON.stringify(value) + ", which is not a list of GitHub issue or pull request URLs"

const parsedUpstream = (name: string, upstream: unknown): ReadonlyArray<Contribution> | string => {
  if (!Array.isArray(upstream)) {
    return notUpstream(name, upstream)
  }
  const contributions: Array<Contribution> = []
  for (const entry of upstream) {
    const match = typeof entry === "string" ? contributionPattern.exec(entry) : null
    if (match === null) {
      return "the project " + name + " names the upstream entry " + JSON.stringify(entry) + ", which is not a GitHub issue or pull request URL such as https://github.com/owner/repo/pull/12"
    }
    contributions.push({ url: match[0], owner: match[1], repo: match[2], number: Number(match[3]) })
  }
  const ids = contributions.map(contributionId)
  const again = contributions.find((contribution, index) => ids.indexOf(contributionId(contribution)) !== index)
  return again === undefined ? contributions : "the project " + name + " names the upstream URL " + again.url + " twice"
}

const checkedProject = (project: RawProject): Project | string => {
  const { mode, yolo } = project
  if (mode !== undefined && !isDeliveryMode(mode)) {
    return unknownMode(project.name, mode)
  }
  if (yolo !== undefined && typeof yolo !== "boolean") {
    return "the project " + project.name + " names yolo " + JSON.stringify(yolo) + ", which is not true or false"
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
  (name === null ? "an account with no name" : "the account " + name) + " names a credential the beat cannot take: " + reason

const readAccount = (file: string, entry: unknown): Effect.Effect<Account, ConfigError> =>
  Schema.decodeUnknownEffect(AnyAccount)(entry, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) => new ConfigError({ file, detail: accountDetail(accountName(entry), error.message) })),
    Effect.map(tagAccount)
  )

const claudeConfigProblem = (accounts: ReadonlyArray<Account>, machines: ReadonlyArray<Machine>): string | null => {
  for (const account of accounts) {
    if (account.kind !== "claude-config") continue
    for (const machine of machines) {
      if (!Object.hasOwn(account.configDirs, machine.name)) {
        return "the account " + account.name + " names no Claude config directory for " + machine.name
      }
    }
  }
  for (const machine of machines) {
    const dirs = accounts.flatMap((account) => account.kind === "claude-config" ? [account.configDirs[machine.name]] : [])
    if (duplicateOf(dirs) !== null) {
      return "the machine " + machine.name + " uses the same Claude config directory for more than one account"
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
        const claudeProblem = claudeConfigProblem(accounts, machines)
        if (claudeProblem !== null) return yield* new ConfigError({ file, detail: claudeProblem })
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
        return { machines, quota: { ...config.quota, floorPercent: config.quota.floorPercent ?? 0, accounts } }
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
