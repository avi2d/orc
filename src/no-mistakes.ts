import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { collectOutput } from "./git-run"
import { hostGitSafetyEnv } from "./host"
import {
  answerArgsFor,
  answerForGate,
  findingsTable,
  missingReason,
  omittedQuestionIds,
  openQuestionsIn,
  parseRun,
  respondArgs,
  stepsWithFindings,
  type AllowWord,
  type GateAnswer,
  type NoMistakesFinding,
  type ParkedGate,
  type ParsedRun,
  type QuestionAnswer
} from "./no-mistakes-gate"
import { hasTable, scalar } from "./toon"
export { answerArgsFor, answerForGate, askUserWord, omittedQuestionIds, parseRun } from "./no-mistakes-gate"
export type { AllowWord, NoMistakesFinding, QuestionAnswer } from "./no-mistakes-gate"
type NoMistakesStatus = "passed" | "refused" | "failed"

export interface NoMistakesRecord {
  readonly status: NoMistakesStatus
  readonly gate: string | null
  readonly findings: ReadonlyArray<NoMistakesFinding>
  readonly gatesAnswered: number
  readonly prLink: string | null
  readonly result: string
  readonly started: string
  readonly ended: string
}

interface NoMistakesCommand {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface NoMistakesInput {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly pathEnv: string
  readonly git: string
  readonly taskFile: string
  readonly worktreeDir: string
  readonly allow?: ReadonlyArray<AllowWord> | undefined
  readonly answers?: ReadonlyArray<QuestionAnswer> | undefined
}

interface Ending {
  readonly status: NoMistakesStatus
  readonly gate: ParkedGate | null
  readonly result: string
}

type Sent =
  | { readonly kind: "start" }
  | { readonly kind: "respond"; readonly gate: ParkedGate }
  | { readonly kind: "answer"; readonly gate: ParkedGate }
  | { readonly kind: "reattach" }

const maxGatesAnswered = 20

const greenOutcomes = new Set(["checks-passed", "passed"])

const findingKey = (step: string, finding: NoMistakesFinding): string =>
  step + "\n" + (finding.id === "" ? finding.file + "\n" + finding.description : finding.id)

const firstLine = (text: string): string => text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "the pipeline gave no reason"

const errorDetail = (command: NoMistakesCommand): string => {
  const reported = scalar(command.stdout, "error")
  return reported === "" ? firstLine(command.stderr + "\n" + command.stdout) : reported
}

const waitElapsed = (command: NoMistakesCommand): boolean => /^wait of \S+ elapsed/.test(scalar(command.stdout, "error"))

const rejected = (command: NoMistakesCommand, parsed: ParsedRun): boolean =>
  !parsed.terminal && !waitElapsed(command) && (command.exitCode !== 0 || scalar(command.stdout, "error") !== "")

const prNote = (prLink: string | null): string => prLink === null ? "No PR opens." : "The PR " + prLink + " is open but not ready."

const spawnNoMistakes = (input: NoMistakesInput, args: ReadonlyArray<string>): Effect.Effect<NoMistakesCommand> =>
  Effect.scoped(Effect.gen(function*() {
    const handle = yield* input.spawner.spawn(ChildProcess.make("no-mistakes", [...args], {
      cwd: input.worktreeDir,
      env: { ...hostGitSafetyEnv, PATH: input.git.slice(0, input.git.lastIndexOf("/")) + ":" + input.pathEnv },
      extendEnv: true
    }))
    return yield* collectOutput(handle)
  })).pipe(
    Effect.catch((cause) => Effect.succeed({ stdout: "", stderr: "no-mistakes failed to run: " + String(cause), exitCode: -1 }))
  )

interface DriveLog {
  readonly read: (output: string) => ParsedRun
  readonly remember: (step: string, findings: ReadonlyArray<NoMistakesFinding>) => void
  readonly runId: () => string
  readonly gatesAnswered: () => number
  readonly countGate: () => void
  readonly refuse: (gate: ParkedGate | null, reason: string) => Ending
  readonly fail: (reason: string) => Ending
  readonly finish: (parsed: ParsedRun) => Ending
  readonly close: (ending: Ending) => NoMistakesRecord
}

const openDriveLog = (started: string): DriveLog => {
  const findings: Array<NoMistakesFinding> = []
  const known = new Set<string>()
  let gatesAnswered = 0
  let prLink: string | null = null
  let runId = ""
  const remember = (step: string, seen: ReadonlyArray<NoMistakesFinding>): void => {
    for (const finding of seen) {
      if (!known.has(findingKey(step, finding))) {
        known.add(findingKey(step, finding))
        findings.push(finding)
      }
    }
  }
  const fail = (reason: string): Ending => ({ status: "failed", gate: null, result: reason + ". " + prNote(prLink) })
  return {
    read: (output) => {
      const parsed = parseRun(output)
      remember(parsed.gate?.step ?? "", parsed.findings)
      prLink = parsed.prLink === "" ? prLink : parsed.prLink
      runId = parsed.runId === "" ? runId : parsed.runId
      return parsed
    },
    remember,
    runId: () => runId,
    gatesAnswered: () => gatesAnswered,
    countGate: () => {
      gatesAnswered += 1
    },
    refuse: (gate, reason) => ({
      status: "refused",
      gate,
      result: "no-mistakes stopped" + (gate === null ? "." : " at the " + gate.step + " gate.") + " " + reason + ". " + prNote(prLink)
    }),
    fail,
    finish: (parsed) =>
      greenOutcomes.has(parsed.outcome) && prLink !== null
        ? { status: "passed", gate: null, result: "no-mistakes opened " + prLink + " and CI is green." }
        : fail("no-mistakes ended " + (parsed.outcome === "" ? parsed.status : "with outcome " + parsed.outcome)),
    close: (ending) => ({
      status: ending.status,
      gate: ending.gate === null ? null : ending.gate.step,
      findings,
      gatesAnswered,
      prLink,
      result: ending.result,
      started,
      ended: new Date().toISOString()
    })
  }
}

const stopOnRejection = (input: NoMistakesInput, log: DriveLog, sent: Sent, command: NoMistakesCommand): Effect.Effect<Ending> => {
  if (sent.kind === "start") {
    return Effect.succeed(log.fail("no-mistakes refused to start: " + errorDetail(command)))
  }
  if (sent.kind === "respond" || sent.kind === "answer") {
    return Effect.succeed(log.refuse(sent.gate, "no-mistakes refused the answer: " + errorDetail(command)))
  }
  return spawnNoMistakes(input, ["axi", "status"]).pipe(Effect.map((status) => {
    const resting = log.read(status.stdout)
    return resting.terminal ? log.finish(resting) : log.fail("no-mistakes left no gate and no outcome: " + errorDetail(command))
  }))
}

const gateAnswer = (input: NoMistakesInput, log: DriveLog, gate: ParkedGate, findings: ReadonlyArray<NoMistakesFinding>): GateAnswer =>
  log.gatesAnswered() >= maxGatesAnswered
    ? { kind: "refuse", reason: "orc answered " + maxGatesAnswered.toString() + " gates without reaching an outcome" }
    : answerForGate(gate, findings, input.allow ?? [])

type CurrentStep =
  | { readonly kind: "stop"; readonly ending: Ending }
  | { readonly kind: "reattach"; readonly command: NoMistakesCommand }
  | { readonly kind: "parked"; readonly parsed: ParsedRun; readonly gate: ParkedGate }

const stepCurrent = (input: NoMistakesInput, log: DriveLog, sent: Sent, current: NoMistakesCommand): Effect.Effect<CurrentStep> =>
  Effect.gen(function*() {
    const parsed = log.read(current.stdout)
    const refused = rejected(current, parsed)
    if ((sent.kind === "respond" || sent.kind === "answer") && !refused) {
      log.countGate()
    }
    if (parsed.terminal) {
      return { kind: "stop", ending: log.finish(parsed) }
    }
    if (refused) {
      const ending = yield* stopOnRejection(input, log, sent, current)
      return { kind: "stop", ending }
    }
    if (parsed.gate === null) {
      const command = yield* spawnNoMistakes(input, ["axi", "run"])
      return { kind: "reattach", command }
    }
    return { kind: "parked", parsed, gate: parsed.gate }
  })

type OpenOutcome =
  | { readonly kind: "ending"; readonly ending: Ending }
  | { readonly kind: "answered"; readonly command: NoMistakesCommand }

const serveOpenQuestions = (input: NoMistakesInput, log: DriveLog, gate: ParkedGate, open: ReadonlyArray<NoMistakesFinding>): Effect.Effect<OpenOutcome> =>
  Effect.gen(function*() {
    const supplied = new Map((input.answers ?? []).map((entry) => [entry.question, entry.answer] as const))
    const missing = open.filter((finding) => !supplied.has(finding.id))
    if (missing.length > 0) {
      return { kind: "ending", ending: log.refuse(gate, missingReason(missing)) }
    }
    for (let index = 0; index < open.length - 1; index += 1) {
      const pending = open[index] ?? { id: "", description: "" }
      const reply = yield* spawnNoMistakes(input, answerArgsFor(pending.id, supplied.get(pending.id) ?? ""))
      if (reply.exitCode !== 0 || scalar(reply.stdout, "error") !== "") {
        const ending = yield* stopOnRejection(input, log, { kind: "answer", gate }, reply)
        return { kind: "ending", ending }
      }
    }
    const last = open[open.length - 1] ?? { id: "", description: "" }
    const command = yield* spawnNoMistakes(input, answerArgsFor(last.id, supplied.get(last.id) ?? ""))
    return { kind: "answered", command }
  })

const drive = (input: NoMistakesInput, log: DriveLog): Effect.Effect<Ending> =>
  Effect.gen(function*() {
    let sent: Sent = { kind: "start" }
    let current = yield* spawnNoMistakes(input, ["axi", "run", "--intent-file", input.taskFile])
    for (;;) {
      const step: CurrentStep = yield* stepCurrent(input, log, sent, current)
      if (step.kind === "stop") {
        return step.ending
      }
      if (step.kind === "reattach") {
        current = step.command
        sent = { kind: "reattach" }
        continue
      }
      const open = openQuestionsIn(step.parsed.findings, omittedQuestionIds(current.stdout))
      if (open.length > 0) {
        const outcome: OpenOutcome = yield* serveOpenQuestions(input, log, step.gate, open)
        if (outcome.kind === "ending") {
          return outcome.ending
        }
        current = outcome.command
        sent = { kind: "answer", gate: step.gate }
        continue
      }
      const answer = gateAnswer(input, log, step.gate, step.parsed.findings)
      if (answer.kind === "refuse") {
        return log.refuse(step.gate, answer.reason)
      }
      current = yield* spawnNoMistakes(input, respondArgs(answer))
      sent = { kind: "respond", gate: step.gate }
    }
  })

const unreadable = (command: NoMistakesCommand, name: string, args: ReadonlyArray<string>): string | null => {
  if (command.exitCode !== 0 || scalar(command.stdout, "error") !== "") {
    return "no-mistakes " + args.join(" ") + " failed: " + errorDetail(command)
  }
  return hasTable(command.stdout, name) ? null : "no-mistakes " + args.join(" ") + " printed no " + name + " table"
}

const collectRecordedFindings = (input: NoMistakesInput, log: DriveLog, runId: string): Effect.Effect<string | null> =>
  Effect.gen(function*() {
    const statusArgs = ["axi", "status", "--run", runId]
    const status = yield* spawnNoMistakes(input, statusArgs)
    const statusFailure = unreadable(status, "steps", statusArgs)
    if (statusFailure !== null) {
      return statusFailure
    }
    for (const step of stepsWithFindings(status.stdout)) {
      const logsArgs = ["axi", "logs", "--run", runId, "--step", step]
      const logs = yield* spawnNoMistakes(input, logsArgs)
      const logsFailure = unreadable(logs, "findings", logsArgs)
      if (logsFailure !== null) {
        return logsFailure
      }
      log.remember(step, findingsTable(logs.stdout))
    }
    return null
  })

const withUnreadFindings = (ending: Ending, failure: string): Ending => ({
  status: ending.status === "passed" ? "failed" : ending.status,
  gate: ending.gate,
  result: ending.result + " orc could not read the findings no-mistakes recorded: " + failure + "."
})

export const driveNoMistakes = (input: NoMistakesInput): Effect.Effect<NoMistakesRecord> =>
  Effect.gen(function*() {
    const log = openDriveLog(new Date().toISOString())
    const ending = yield* drive(input, log)
    const failure = log.runId() === "" ? null : yield* collectRecordedFindings(input, log, log.runId())
    return log.close(failure === null ? ending : withUnreadFindings(ending, failure))
  })