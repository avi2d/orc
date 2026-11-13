import { Data, Effect, FileSystem, type Path } from "effect"
import { refusalsIn, type GateRefusal } from "../../entities/run-history/index"
import type { AgentFile } from "../../entities/agent/index"
import { orcCompletionLine } from "../../entities/agent/index"
import type { CommandResult } from "../../shared/sandbox/index"

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

export const prepareCommandOf = (commands: ReadonlyArray<ChecksCommand>): string | null =>
  commands.find((check) => check.name === "prepare")?.command ?? null

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
    },
    exit: (outcome: CheckOutcome): Effect.Effect<void, ChecksError> =>
      append((started ? "" : "\n(no output)") + "\nexit " + outcome.exitCode + ": " + (outcome.passed ? "passed" : "failed"))
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
    yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(
      Effect.andThen(() => fs.writeFileString(file, "")),
      Effect.mapError((cause) => new ChecksError({ message: "orc: cannot write the checks evidence file: " + String(cause) }))
    )
    const append = (text: string): Effect.Effect<void, ChecksError> =>
      fs.writeFileString(file, text, { flag: "a" }).pipe(
        Effect.mapError((cause) => new ChecksError({ message: "orc: cannot write the checks evidence file: " + String(cause) }))
      )
    const outcomes: Array<CheckOutcome> = []
    for (const check of commands) {
      yield* append((outcomes.length === 0 ? "" : "\n\n") + "check " + check.name + ": " + check.command)
      const section = sectionWriter(append)
      let streamed = false
      const result = yield* runCommand(check.command, (text) => {
        streamed = true
        return section.output(text)
      }).pipe(
        Effect.mapError((cause) => cause instanceof ChecksError ? cause : new ChecksError({ message: "orc: the " + check.name + " check failed to run: " + cause.message }))
      )
      // A runner that does not stream hands the whole output back only in its result.
      if (!streamed) {
        yield* section.output(result.stdout + result.stderr)
      }
      const passed = result.exitCode === 0
      const outcome: CheckOutcome = { name: check.name, command: check.command, exitCode: result.exitCode, passed, refusals: passed ? [] : refusalsIn(result.stdout + "\n" + result.stderr, check.name) }
      outcomes.push(outcome)
      yield* section.exit(outcome)
    }
    yield* append("\n")
    return { round, file, outcomes }
  })

export const buildFixPrompt = (agent: AgentFile, evidenceFile: string): string =>
  [
    agent.body,
    "",
    "The failed checks output sits in " + evidenceFile + ".",
    "Read that file and fix what failed, then run each check that failed and confirm that it passes.",
    "When the fix is committed on this branch, print " + orcCompletionLine + " on its own line and stop."
  ].join("\n")
