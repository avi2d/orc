import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

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

export interface NoMistakesInput {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly pathEnv: string
  readonly taskFile: string
  readonly worktreeDir: string
}

interface ParkedGate {
  readonly step: string
  readonly stage: "approval" | "fix-review"
}

interface ParsedRun {
  readonly status: string
  readonly outcome: string
  readonly prLink: string
  readonly gate: ParkedGate | null
  readonly terminal: boolean
  readonly findings: ReadonlyArray<NoMistakesFinding>
  readonly fixes: ReadonlyArray<NoMistakesFinding>
}

type GateAnswer =
  | { readonly kind: "fix"; readonly ids: ReadonlyArray<string>; readonly ignore: ReadonlyArray<string> }
  | { readonly kind: "approve" }
  | { readonly kind: "refuse"; readonly reason: string }

type Sent =
  | { readonly kind: "start" }
  | { readonly kind: "respond"; readonly gate: ParkedGate }
  | { readonly kind: "reattach" }

const maxGatesAnswered = 20

const terminalStatuses = new Set(["completed", "failed", "cancelled", "checks_passed"])

const greenOutcomes = new Set(["checks-passed", "passed"])

const escapes: Readonly<Record<string, string>> = { "\\": "\\", "\"": "\"", n: "\n", r: "\r", t: "\t" }

const trimmedLines = (output: string): Array<string> => output.split("\n").map((line) => line.trim())

const decode = (value: string): string => {
  const text = value.trim()
  const quoted = text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")
  return quoted ? text.slice(1, -1).replace(/\\(.)/g, (_, char: string) => escapes[char] ?? char) : text
}

const scalar = (output: string, key: string): string => {
  const line = trimmedLines(output).find((candidate) => candidate.startsWith(key + ":"))
  return line === undefined ? "" : decode(line.slice(key.length + 1))
}

const splitRow = (row: string): Array<string> => {
  const cells: Array<string> = []
  let cell = ""
  let quoted = false
  let escaped = false
  for (const char of row.trim()) {
    if (escaped) {
      escaped = false
    } else if (quoted && char === "\\") {
      escaped = true
    } else if (char === "\"") {
      quoted = !quoted
    } else if (char === "," && !quoted) {
      cells.push(cell)
      cell = ""
      continue
    }
    cell += char
  }
  cells.push(cell)
  return cells.map(decode)
}

const findingsTable = (output: string, name: "findings" | "fixes"): ReadonlyArray<NoMistakesFinding> => {
  const lines = trimmedLines(output)
  const header = new RegExp("^" + name + "\\[(\\d+)\\]\\{([^}]*)\\}:$")
  const headerIndex = lines.findIndex((line) => header.test(line))
  const match = header.exec(lines[headerIndex] ?? "")
  if (match === null) {
    return []
  }
  const columns = match[2].split(",").map((column) => column.trim())
  const rows = lines.slice(headerIndex + 1).filter((line) => line !== "").slice(0, Number(match[1]))
  return rows.map((row) => {
    const cells = splitRow(row)
    const cell = (column: string): string => {
      const index = columns.indexOf(column)
      return index === -1 ? "" : cells[index] ?? ""
    }
    return {
      id: cell("id"),
      severity: cell("severity"),
      file: cell("file"),
      line: cell("line"),
      action: cell("action"),
      description: cell("description")
    }
  })
}

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
    gate: readGate(output),
    terminal: outcome !== "" || terminalStatuses.has(status),
    findings: findingsTable(output, "findings"),
    fixes: findingsTable(output, "fixes")
  }
}

export const answerForGate = (gate: ParkedGate, findings: ReadonlyArray<NoMistakesFinding>): GateAnswer => {
  const question = findings.find((finding) => finding.id.startsWith("question-"))
  if (question !== undefined) {
    return { kind: "refuse", reason: "open review question " + question.id + " needs his word" }
  }
  const asked = findings.find((finding) => finding.action === "ask-user")
  if (asked !== undefined) {
    return { kind: "refuse", reason: "finding " + asked.id + " is marked ask-user and needs his word" }
  }
  const other = findings.find((finding) => finding.action !== "auto-fix" && finding.action !== "no-op")
  if (other !== undefined) {
    return { kind: "refuse", reason: "finding " + other.id + " needs an answer orc cannot give" }
  }
  if (gate.stage === "fix-review") {
    return { kind: "approve" }
  }
  const fixable = findings.filter((finding) => finding.action === "auto-fix")
  if (fixable.length > 0) {
    return {
      kind: "fix",
      ids: fixable.map((finding) => finding.id),
      ignore: findings.filter((finding) => finding.action === "no-op").map((finding) => finding.id)
    }
  }
  if (findings.length > 0) {
    return { kind: "approve" }
  }
  return { kind: "refuse", reason: "the " + gate.step + " gate names no finding orc can fix" }
}

const respondArgs = (answer: Exclude<GateAnswer, { readonly kind: "refuse" }>): ReadonlyArray<string> =>
  answer.kind === "approve"
    ? ["axi", "respond", "--action", "approve"]
    : ["axi", "respond", "--action", "fix", "--findings", answer.ids.join(","), ...(answer.ignore.length === 0 ? [] : ["--ignore", answer.ignore.join(",")])]

const findingKey = (finding: NoMistakesFinding): string =>
  finding.id === "" ? finding.file + "\n" + finding.description : finding.id

const firstLine = (text: string): string => text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "the pipeline gave no reason"

const errorDetail = (command: NoMistakesCommand): string => {
  const reported = scalar(command.stdout, "error")
  return reported === "" ? firstLine(command.stderr + "\n" + command.stdout) : reported
}

const prNote = (prLink: string | null): string => prLink === null ? "No PR opens." : "The PR " + prLink + " is open but not ready."

const spawnNoMistakes = (input: NoMistakesInput, args: ReadonlyArray<string>): Effect.Effect<NoMistakesCommand> =>
  Effect.scoped(Effect.gen(function*() {
    const handle = yield* input.spawner.spawn(ChildProcess.make("no-mistakes", [...args], { cwd: input.worktreeDir, env: { PATH: input.pathEnv }, extendEnv: true }))
    const [stdout, stderr, exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" })
    return { stdout, stderr, exitCode }
  })).pipe(
    Effect.catch((cause) => Effect.succeed({ stdout: "", stderr: "no-mistakes failed to run: " + String(cause), exitCode: -1 }))
  )

interface DriveLog {
  readonly read: (output: string) => ParsedRun
  readonly gatesAnswered: () => number
  readonly countGate: () => void
  readonly refuse: (gate: ParkedGate | null, reason: string) => NoMistakesRecord
  readonly fail: (reason: string) => NoMistakesRecord
  readonly finish: (parsed: ParsedRun) => NoMistakesRecord
}

const openDriveLog = (started: string): DriveLog => {
  const findings: Array<NoMistakesFinding> = []
  const known = new Set<string>()
  let gatesAnswered = 0
  let prLink: string | null = null
  const close = (status: NoMistakesStatus, gate: ParkedGate | null, result: string): NoMistakesRecord => ({
    status,
    gate: gate === null ? null : gate.step,
    findings,
    gatesAnswered,
    prLink,
    result,
    started,
    ended: new Date().toISOString()
  })
  const fail = (reason: string): NoMistakesRecord => close("failed", null, reason + ". " + prNote(prLink))
  return {
    read: (output) => {
      const parsed = parseRun(output)
      for (const finding of [...parsed.findings, ...parsed.fixes]) {
        if (!known.has(findingKey(finding))) {
          known.add(findingKey(finding))
          findings.push(finding)
        }
      }
      prLink = parsed.prLink === "" ? prLink : parsed.prLink
      return parsed
    },
    gatesAnswered: () => gatesAnswered,
    countGate: () => {
      gatesAnswered += 1
    },
    refuse: (gate, reason) =>
      close("refused", gate, "no-mistakes stopped" + (gate === null ? "." : " at the " + gate.step + " gate.") + " " + reason + ". " + prNote(prLink)),
    fail,
    finish: (parsed) =>
      greenOutcomes.has(parsed.outcome) && prLink !== null
        ? close("passed", null, "no-mistakes opened " + prLink + " and CI is green.")
        : fail("no-mistakes ended " + (parsed.outcome === "" ? parsed.status : "with outcome " + parsed.outcome))
  }
}

const stopWithoutGate = (input: NoMistakesInput, log: DriveLog, sent: Sent, command: NoMistakesCommand): Effect.Effect<NoMistakesRecord> => {
  if (sent.kind === "start") {
    return Effect.succeed(log.fail("no-mistakes refused to start: " + errorDetail(command)))
  }
  if (sent.kind === "respond") {
    return Effect.succeed(log.refuse(sent.gate, "no-mistakes refused the answer: " + errorDetail(command)))
  }
  return spawnNoMistakes(input, ["axi", "status"]).pipe(Effect.map((status) => {
    const resting = log.read(status.stdout)
    return resting.terminal ? log.finish(resting) : log.fail("no-mistakes left no gate and no outcome: " + errorDetail(command))
  }))
}

const gateAnswer = (log: DriveLog, gate: ParkedGate, findings: ReadonlyArray<NoMistakesFinding>): GateAnswer =>
  log.gatesAnswered() >= maxGatesAnswered
    ? { kind: "refuse", reason: "orc answered " + maxGatesAnswered.toString() + " gates without reaching an outcome" }
    : answerForGate(gate, findings)

export const driveNoMistakes = (input: NoMistakesInput): Effect.Effect<NoMistakesRecord> =>
  Effect.gen(function*() {
    const log = openDriveLog(new Date().toISOString())
    let sent: Sent = { kind: "start" }
    let current = yield* spawnNoMistakes(input, ["axi", "run", "--intent-file", input.taskFile])
    for (;;) {
      const parsed = log.read(current.stdout)
      if (parsed.terminal) {
        return log.finish(parsed)
      }
      if (parsed.gate !== null) {
        const answer = gateAnswer(log, parsed.gate, parsed.findings)
        if (answer.kind === "refuse") {
          return log.refuse(parsed.gate, answer.reason)
        }
        current = yield* spawnNoMistakes(input, respondArgs(answer))
        sent = { kind: "respond", gate: parsed.gate }
        log.countGate()
      } else if (current.exitCode === 0) {
        current = yield* spawnNoMistakes(input, ["axi", "run"])
        sent = { kind: "reattach" }
      } else {
        return yield* stopWithoutGate(input, log, sent, current)
      }
    }
  })
