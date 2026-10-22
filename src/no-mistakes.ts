import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { collectOutput } from "./git-run"
import { hostGitSafetyEnv } from "./host"
import { hasTable, scalar, splitRow, table, trimmedLines } from "./toon"

export interface NoMistakesFinding {
  readonly id: string
  readonly severity: string
  readonly file: string
  readonly line: string
  readonly action: string
  readonly description: string
}

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

export const askUserWord = "ask-user"
export interface QuestionAnswer {
  readonly question: string
  readonly answer: string
}
export interface NoMistakesInput {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly pathEnv: string
  readonly git: string
  readonly taskFile: string
  readonly worktreeDir: string
  readonly allow?: ReadonlyArray<string> | undefined
  readonly answers?: ReadonlyArray<QuestionAnswer> | undefined
}

interface ParkedGate {
  readonly step: string
  readonly stage: "approval" | "fix-review"
}

interface ParsedRun {
  readonly status: string
  readonly outcome: string
  readonly prLink: string
  readonly runId: string
  readonly gate: ParkedGate | null
  readonly terminal: boolean
  readonly findings: ReadonlyArray<NoMistakesFinding>
}

interface Ending {
  readonly status: NoMistakesStatus
  readonly gate: ParkedGate | null
  readonly result: string
}

type GateAnswer =
  | { readonly kind: "fix"; readonly ids: ReadonlyArray<string>; readonly ignore: ReadonlyArray<string> }
  | { readonly kind: "approve" }
  | { readonly kind: "refuse"; readonly reason: string }

type Sent =
  | { readonly kind: "start" }
  | { readonly kind: "respond"; readonly gate: ParkedGate }
  | { readonly kind: "answer"; readonly gate: ParkedGate }
  | { readonly kind: "reattach" }

const maxGatesAnswered = 20

const terminalStatuses = new Set(["completed", "failed", "cancelled", "checks_passed"])

const greenOutcomes = new Set(["checks-passed", "passed"])

const findingsTable = (output: string): ReadonlyArray<NoMistakesFinding> =>
  table(output, "findings").map((row) => ({
    id: row.get("id") ?? "",
    severity: row.get("severity") ?? "",
    file: row.get("file") ?? "",
    line: row.get("line") ?? "",
    action: row.get("action") ?? "",
    description: row.get("description") ?? ""
  }))

const stepsWithFindings = (output: string): ReadonlyArray<string> =>
  table(output, "steps")
    .filter((row) => Number.parseInt(row.get("findings") ?? "", 10) > 0)
    .map((row) => row.get("step") ?? "")
    .filter((step) => step !== "")

const parkedStep = (output: string): string | null => {
  for (const line of trimmedLines(output)) {
    const cells = splitRow(line)
    if (cells.length >= 2 && (cells[1] === "awaiting_approval" || cells[1] === "fix_review")) {
      return cells[0] === "" ? null : (cells[0] ?? null)
    }
  }
  return null
}

const gateStep = (output: string): string | null => {
  const named = scalar(output, "gate")
  if (named !== "") {
    return named
  }
  if (trimmedLines(output).some((line) => line === "gate:")) {
    const step = scalar(output, "step")
    return step === "" ? "unknown" : step
  }
  return parkedStep(output)
}

const inFixReview = (output: string, step: string): boolean =>
  trimmedLines(output).some((line) => {
    const cells = splitRow(line)
    return line === "status: fix_review" || (cells[0] === step && cells[1] === "fix_review")
  })

const readGate = (output: string): ParkedGate | null => {
  const step = gateStep(output)
  return step === null ? null : { step, stage: inFixReview(output, step) ? "fix-review" : "approval" }
}

export const parseRun = (output: string): ParsedRun => {
  const status = scalar(output, "status")
  const outcome = scalar(output, "outcome")
  return {
    status,
    outcome,
    prLink: scalar(output, "pr"),
    runId: scalar(output, "id"),
    gate: readGate(output),
    terminal: outcome !== "" || terminalStatuses.has(status),
    findings: findingsTable(output)
  }
}

const isQuestion = (finding: NoMistakesFinding): boolean => finding.id.startsWith("question-")

const questionReason = (question: NoMistakesFinding): string => {
  const quoted = question.description === "" ? "" : ` "${question.description}"`
  return `finding ${question.id} is a question${quoted} and needs your answer on a rerun with --answer ${question.id}="<answer>"`
}

const missingReason = (missing: ReadonlyArray<NoMistakesFinding>): string =>
  missing.map(questionReason).join("; ")

export const omittedQuestionIds = (output: string): ReadonlyArray<string> => {
  const scalarIds = scalar(output, "review-questions-omitted").match(/question-[A-Za-z0-9-]+/g) ?? []
  const noticeIds = trimmedLines(output)
    .filter((line) => /further review question\(s\) omitted for length/i.test(line))
    .flatMap((line) => line.match(/question-[A-Za-z0-9-]+/g) ?? [])
  const seen = new Set<string>()
  return [...scalarIds, ...noticeIds].filter((id) => {
    if (seen.has(id)) {
      return false
    }
    seen.add(id)
    return true
  })
}

const openQuestionsIn = (findings: ReadonlyArray<NoMistakesFinding>, omittedIds: ReadonlyArray<string>): ReadonlyArray<NoMistakesFinding> => {
  const rendered = findings.filter(isQuestion)
  const known = new Set(rendered.map((finding) => finding.id))
  const omitted = omittedIds
    .filter((id) => !known.has(id))
    .map((id): NoMistakesFinding => ({ id, severity: "", file: "", line: "", action: "", description: "" }))
  return [...rendered, ...omitted]
}

export const answerArgsFor = (question: string, answer: string): ReadonlyArray<string> =>
  ["axi", "answer", "--question", question, "--answer", answer]

export const answerForGate = (gate: ParkedGate, findings: ReadonlyArray<NoMistakesFinding>, allow: ReadonlyArray<string> = [], omittedIds: ReadonlyArray<string> = []): GateAnswer => {
  const open = openQuestionsIn(findings, omittedIds)
  if (open.length > 0) {
    return { kind: "refuse", reason: missingReason(open) }
  }
  const askUserAllowed = allow.includes(askUserWord)
  const asked = findings.find((finding) => finding.action === "ask-user")
  if (asked !== undefined && !askUserAllowed) {
    return { kind: "refuse", reason: "finding " + asked.id + " is marked ask-user and needs your word on a rerun with --allow ask-user" }
  }
  const worded = askUserAllowed ? findings.filter((finding) => finding.action === "ask-user") : []
  const rest = askUserAllowed ? findings.filter((finding) => finding.action !== "ask-user") : findings
  const other = rest.find((finding) => finding.action !== "auto-fix" && finding.action !== "no-op")
  if (other !== undefined) {
    return { kind: "refuse", reason: "finding " + other.id + " needs an answer orc cannot give" }
  }
  if (gate.stage === "fix-review") {
    return { kind: "approve" }
  }
  const fixable = rest.filter((finding) => finding.action === "auto-fix")
  if (fixable.length > 0) {
    return {
      kind: "fix",
      ids: fixable.map((finding) => finding.id),
      ignore: [...rest.filter((finding) => finding.action === "no-op"), ...worded].map((finding) => finding.id)
    }
  }
  if (rest.length > 0 || worded.length > 0) {
    return { kind: "approve" }
  }
  return { kind: "refuse", reason: "the " + gate.step + " gate names no finding orc can fix" }
}

const respondArgs = (answer: Exclude<GateAnswer, { readonly kind: "refuse" }>): ReadonlyArray<string> =>
  answer.kind === "approve"
    ? ["axi", "respond", "--action", "approve"]
    : ["axi", "respond", "--action", "fix", "--findings", answer.ids.join(","), ...(answer.ignore.length === 0 ? [] : ["--ignore", answer.ignore.join(",")])]

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

const gateAnswer = (input: NoMistakesInput, log: DriveLog, gate: ParkedGate, findings: ReadonlyArray<NoMistakesFinding>, omittedIds: ReadonlyArray<string>): GateAnswer =>
  log.gatesAnswered() >= maxGatesAnswered
    ? { kind: "refuse", reason: "orc answered " + maxGatesAnswered.toString() + " gates without reaching an outcome" }
    : answerForGate(gate, findings, input.allow ?? [], omittedIds)

const drive = (input: NoMistakesInput, log: DriveLog): Effect.Effect<Ending> =>
  Effect.gen(function*() {
    let sent: Sent = { kind: "start" }
    let current = yield* spawnNoMistakes(input, ["axi", "run", "--intent-file", input.taskFile])
    for (;;) {
      const parsed = log.read(current.stdout)
      const refused = rejected(current, parsed)
      if ((sent.kind === "respond" || sent.kind === "answer") && !refused) {
        log.countGate()
      }
      if (parsed.terminal) {
        return log.finish(parsed)
      }
      if (refused) {
        return yield* stopOnRejection(input, log, sent, current)
      }
      if (parsed.gate === null) {
        current = yield* spawnNoMistakes(input, ["axi", "run"])
        sent = { kind: "reattach" }
        continue
      }
      const omitted = omittedQuestionIds(current.stdout)
      const open = openQuestionsIn(parsed.findings, omitted)
      if (open.length > 0) {
        const supplied = new Map((input.answers ?? []).map((entry) => [entry.question, entry.answer] as const))
        const missing = open.filter((finding) => !supplied.has(finding.id))
        if (missing.length > 0) {
          return log.refuse(parsed.gate, missingReason(missing))
        }
        for (let index = 0; index < open.length; index += 1) {
          const pending = open[index] ?? { id: "", description: "" }
          const reply = yield* spawnNoMistakes(input, answerArgsFor(pending.id, supplied.get(pending.id) ?? ""))
          if (index < open.length - 1) {
            if (reply.exitCode !== 0 || scalar(reply.stdout, "error") !== "") {
              return yield* stopOnRejection(input, log, { kind: "answer", gate: parsed.gate }, reply)
            }
            continue
          }
          current = reply
          sent = { kind: "answer", gate: parsed.gate }
        }
        continue
      }
      const answer = gateAnswer(input, log, parsed.gate, parsed.findings, omitted)
      if (answer.kind === "refuse") {
        return log.refuse(parsed.gate, answer.reason)
      }
      current = yield* spawnNoMistakes(input, respondArgs(answer))
      sent = { kind: "respond", gate: parsed.gate }
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
