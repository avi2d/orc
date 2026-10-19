import { Data, Effect, FileSystem, type Path } from "effect"
import type { AgentFile } from "./agents"
import { orcCompletionLine } from "./pi"

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
}

export interface ChecksRound {
  readonly round: number
  readonly file: string
  readonly outcomes: ReadonlyArray<CheckOutcome>
}

export interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
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

const sectionOf = (outcome: CheckOutcome, stdout: string, stderr: string): string => {
  const output = (stdout + stderr).trim()
  return [
    "check " + outcome.name + ": " + outcome.command,
    output === "" ? "(no output)" : output,
    "exit " + outcome.exitCode + ": " + (outcome.passed ? "passed" : "failed")
  ].join("\n")
}

export const runChecksRound = (
  runCommand: (command: string) => Promise<CommandResult>,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  runDir: string,
  round: number,
  commands: ReadonlyArray<ChecksCommand>
): Effect.Effect<ChecksRound, ChecksError> =>
  Effect.gen(function*() {
    const outcomes: Array<CheckOutcome> = []
    const sections: Array<string> = []
    for (const check of commands) {
      const result = yield* Effect.tryPromise({
        try: () => runCommand(check.command),
        catch: (cause) => new ChecksError({ message: "orc: the " + check.name + " check failed to run: " + String(cause) })
      })
      const outcome: CheckOutcome = { name: check.name, command: check.command, exitCode: result.exitCode, passed: result.exitCode === 0 }
      outcomes.push(outcome)
      sections.push(sectionOf(outcome, result.stdout, result.stderr))
    }
    const file = path.join(runDir, checksFileName(round))
    yield* fs.writeFileString(file, sections.join("\n\n") + "\n").pipe(
      Effect.mapError((cause) => new ChecksError({ message: "orc: cannot write the checks evidence file: " + String(cause) }))
    )
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
