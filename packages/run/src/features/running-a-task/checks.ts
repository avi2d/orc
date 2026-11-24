import { Data, Effect, FileSystem, type Path, Schema } from "effect"
import { refusalsIn, type GateRefusal } from "../../entities/run-history/index"
import type { AgentFile } from "../../entities/agent/index"
import { orcCompletionLine } from "../../entities/agent/index"
import type { CommandResult } from "../../shared/sandbox/index"
import { readFailure } from "../../shared/config/index"
import { shellCalls } from "./shell-calls"
import { isTestExecutable, testTargetOf } from "./test-invocation"

export class ChecksError extends Data.TaggedError("ChecksError")<{
  readonly message: string
}> {}

export interface ChecksCommand {
  readonly name: string
  readonly command: string
}

interface CheckOutcome {
  readonly name: string
  readonly command: string
  readonly exitCode: number
  readonly passed: boolean
  readonly refusals: ReadonlyArray<GateRefusal>
}

export interface ChecksRound {
  readonly round: number
  readonly file: string
  readonly outcomes: ReadonlyArray<CheckOutcome>
}

export const maxFixAttempts = 3

export const checksFileName = (round: number): string => "checks-" + round + ".txt"

const fail = (message: string): Effect.Effect<never, ChecksError> => Effect.fail(new ChecksError({ message }))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const usableText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null

export const readChecksCommands = (
  yamlText: string,
  source: string
): Effect.Effect<ReadonlyArray<ChecksCommand>, ChecksError> =>
  Effect.gen(function*() {
    const parsed: unknown = yield* Effect.try({
      try: () => Bun.YAML.parse(yamlText),
      catch: () => new ChecksError({ message: "orc: " + source + " is no YAML orc can read" })
    })
    if (!isRecord(parsed) || !isRecord(parsed["commands"])) {
      return yield* fail("orc: " + source + " names no checks under commands")
    }
    const entries = Object.entries(parsed["commands"])
    if (entries.length === 0) {
      return yield* fail("orc: " + source + " names no checks under commands")
    }
    const commands: Array<ChecksCommand> = []
    for (const [rawName, rawCommand] of entries) {
      const name = usableText(rawName)
      const command = usableText(rawCommand)
      if (name === null || command === null) {
        return yield* fail("orc: " + source + " names a check with no usable name or command")
      }
      commands.push({ name: name.trim(), command: command.trim() })
    }
    return commands
  })

const packageManifest = Schema.fromJsonString(Schema.Struct({
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
}))
const decodePackage = Schema.decodeUnknownEffect(packageManifest)
type Scripts = NonNullable<typeof packageManifest.Type["scripts"]>

const readScripts = Effect.fnUntraced(function*(fs: FileSystem.FileSystem, file: string) {
  const text = yield* fs.readFileString(file).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
    Effect.mapError((cause) => new ChecksError({ message: "orc: cannot read " + file + ": " + String(cause) }))
  )
  if (text === null) return null
  const manifest = yield* decodePackage(text).pipe(
    Effect.mapError((cause) => new ChecksError({ message: "orc: cannot read scripts in " + file + ": " + cause.message }))
  )
  return manifest.scripts ?? {}
})

const localRunCommandNames = new Set(["prepare", "build", "lint", "typecheck"])

export const localRunCommands = Effect.fnUntraced(function*(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  commands: ReadonlyArray<ChecksCommand>
) {
  const packagesByDirectory = new Map<string, { readonly cwd: string; readonly scripts: Scripts } | null>()
  const packageAt = Effect.fnUntraced(function*(directory: string) {
    const searched: Array<string> = []
    let location = directory
    let found = packagesByDirectory.get(location)
    while (found === undefined) {
      searched.push(location)
      const scripts = yield* readScripts(fs, path.join(location, "package.json"))
      if (scripts !== null) {
        found = { cwd: location, scripts }
        break
      }
      const parent = path.dirname(location)
      if (parent === location) {
        found = null
        break
      }
      location = parent
      found = packagesByDirectory.get(location)
    }
    for (const dir of searched) packagesByDirectory.set(dir, found)
    return found
  })
  const testInScript = Effect.fnUntraced(function*(
    target: Extract<ReturnType<typeof testTargetOf>, { readonly kind: "script" }>,
    invocation: string,
    visited: Set<string>
  ): Effect.fn.Return<string | null, ChecksError> {
    const pkg = yield* packageAt(target.cwd)
    if (pkg === null || !Object.hasOwn(pkg.scripts, target.name)) {
      return target.executableFallback && isTestExecutable(target.name) ? invocation : null
    }
    const key = JSON.stringify([pkg.cwd, target.name])
    if (visited.has(key)) return null
    visited.add(key)
    for (const name of ["pre" + target.name, target.name, "post" + target.name]) {
      if (!Object.hasOwn(pkg.scripts, name)) continue
      const found = yield* testInvocation(pkg.scripts[name], pkg.cwd, visited)
      if (found !== null) return found
    }
    return null
  })

  const testInvocation = Effect.fnUntraced(function*(
    command: string,
    directory: string,
    visited: Set<string>
  ): Effect.fn.Return<string | null, ChecksError> {
    const calls = yield* Effect.try({
      try: () => shellCalls(command, directory, path),
      catch: (cause) => new ChecksError({ message: "orc: cannot read the shell command " + command + ": " + String(cause) })
    })
    for (const call of calls) {
      const target = testTargetOf(call, path)
      if (target === null) continue
      const display = call.words.map((word) => word ?? "<dynamic>").join(" ")
      if (target.kind === "suite") return display
      const found = yield* (target.kind === "shell"
        ? testInvocation(target.command, target.cwd, visited)
        : testInScript(target, display, visited))
      if (found !== null) return found
    }
    return null
  })

  const local: Array<ChecksCommand> = []
  for (const check of commands) {
    if (!localRunCommandNames.has(check.name)) continue
    const invocation = yield* testInvocation(check.command, cwd, new Set())
    if (invocation !== null) {
      return yield* fail("orc: refusing " + check.name + " command " + JSON.stringify(check.command) + " because it invokes local tests: " + invocation + ". Leave repository tests to GitHub CI.")
    }
    local.push(check)
  }
  return local
})

export const readProjectLocalChecks = Effect.fnUntraced(function*(fs: FileSystem.FileSystem, path: Path.Path, cwd: string) {
  const source = ".no-mistakes.yaml"
  const text = yield* fs.readFileString(path.join(cwd, source)).pipe(
    Effect.mapError((cause) => new ChecksError({ message: "orc: cannot read the checks config " + source + ": " + readFailure(cause) }))
  )
  const checks = (yield* readChecksCommands(text, source)).filter((check) => check.name !== "prepare")
  const commands = yield* localRunCommands(fs, path, cwd, checks)
  const skipped = checks.filter((check) => !commands.includes(check)).map((check) => check.name)
  return { commands, skipped }
})

export const prepareCommandOf = (commands: ReadonlyArray<ChecksCommand>): string | null =>
  commands.find((check) => check.name === "prepare")?.command ?? null

const sectionOf = (outcome: CheckOutcome, stdout: string, stderr: string): string => {
  const output = (stdout + stderr).trim()
  return [
    "check " + outcome.name + ": " + outcome.command,
    output === "" ? "(no output)" : output,
    "exit " + outcome.exitCode + ": " + (outcome.passed ? "passed" : "failed")
  ].join("\n")
}

// The section reads as the check's trimmed output between its header and exit lines, so leading whitespace is dropped and trailing whitespace is held until more output follows it.
const sectionWriter = (append: (text: string) => Effect.Effect<void, ChecksError>) => {
  let started = false
  let held = ""
  return {
    output: (text: string): Effect.Effect<void, ChecksError> => {
      const kept = started ? held + text : text.replace(/^\s+/, "")
      const body = kept.replace(/\s+$/, "")
      held = kept.slice(body.length)
      if (body === "") {
        return Effect.void
      }
      const prefix = started ? "" : "\n"
      started = true
      return append(prefix + body)
    }
  }
}

export const runChecksRound = (
  runCommand: (command: string, onOutput: (text: string) => Effect.Effect<void, ChecksError>) => Effect.Effect<CommandResult, { readonly message: string }>,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  runDir: string,
  round: number,
  commands: ReadonlyArray<ChecksCommand>
): Effect.Effect<ChecksRound, ChecksError> =>
  Effect.gen(function*() {
    const file = path.join(runDir, checksFileName(round))
    const writeFailed = (cause: unknown): ChecksError => new ChecksError({ message: "orc: cannot write the checks evidence file: " + String(cause) })
    yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(
      Effect.andThen(() => fs.writeFileString(file, "")),
      Effect.mapError(writeFailed)
    )
    const append = (text: string): Effect.Effect<void, ChecksError> =>
      fs.writeFileString(file, text, { flag: "a" }).pipe(Effect.mapError(writeFailed))
    const outcomes: Array<CheckOutcome> = []
    const finished: Array<string> = []
    const rewrite = (): Effect.Effect<void, ChecksError> =>
      fs.writeFileString(file, finished.join("\n\n")).pipe(Effect.mapError(writeFailed))
    for (const check of commands) {
      yield* append((outcomes.length === 0 ? "" : "\n\n") + "check " + check.name + ": " + check.command)
      const section = sectionWriter(append)
      const result = yield* runCommand(check.command, section.output).pipe(
        Effect.mapError((cause) => cause instanceof ChecksError ? cause : new ChecksError({ message: "orc: the " + check.name + " check failed to run: " + cause.message }))
      )
      const passed = result.exitCode === 0
      const outcome: CheckOutcome = { name: check.name, command: check.command, exitCode: result.exitCode, passed, refusals: passed ? [] : refusalsIn(result.stdout + "\n" + result.stderr, check.name) }
      outcomes.push(outcome)
      finished.push(sectionOf(outcome, result.stdout, result.stderr))
      yield* rewrite()
    }
    yield* append(outcomes.length === 0 ? "No local checks ran. GitHub CI decides completion.\n" : "\n")
    return { round, file, outcomes }
  })

export const buildFixPrompt = (agent: AgentFile, evidenceFile: string): string =>
  [
    agent.body,
    "",
    "The failed checks output sits in " + evidenceFile + ".",
    "Read that file and fix what failed. Rerun the failed build, lint, or typecheck command to confirm the fix.",
    "When the fix is committed on this branch, print " + orcCompletionLine + " on its own line and stop."
  ].join("\n")
