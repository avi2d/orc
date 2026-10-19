import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { OrcRunError } from "./run-session"

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

interface ParsedRun {
  readonly status: string
  readonly outcome: string
  readonly prLink: string
  readonly gate: string | null
  readonly parked: boolean
  readonly terminal: boolean
  readonly findings: ReadonlyArray<NoMistakesFinding>
}

type GateAnswer =
  | { readonly kind: "fix"; readonly ids: ReadonlyArray<string> }
  | { readonly kind: "refuse"; readonly reason: string }

const maxDriveRounds = 20

const trimmedLines = (output: string): Array<string> => output.split("\n").map((line) => line.trim())

const unquote = (value: string): string => {
  const text = value.trim()
  const quoted = text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")
  return quoted ? text.slice(1, -1) : text
}

const scalar = (output: string, key: string): string => {
  const line = trimmedLines(output).find((candidate) => candidate.startsWith(key + ":"))
  return line === undefined ? "" : unquote(line.slice(key.length + 1))
}

const splitRow = (row: string): Array<string> => {
  const cells: Array<string> = []
  let cell = ""
  let quoted = false
  for (const char of row.trim()) {
    if (char === "\"") {
      quoted = !quoted
      cell += char
      continue
    }
    if (char === "," && !quoted) {
      cells.push(cell)
      cell = ""
      continue
    }
    cell += char
  }
  cells.push(cell)
  return cells.map(unquote)
}
const gateFindings = (output: string): ReadonlyArray<NoMistakesFinding> => {
  const lines = trimmedLines(output)
  const headerIndex = lines.findIndex((line) => /^findings\[\d+\]\{[^}]*\}:$/.test(line))
  if (headerIndex === -1) {
    return []
  }
  const count = Number(lines[headerIndex].slice("findings[".length).split("]")[0])
  const header = lines[headerIndex] ?? ""
  const columns = header.slice(header.indexOf("{") + 1, header.indexOf("}")).split(",").map((name) => name.trim())
  const rows = lines.slice(headerIndex + 1).filter((line) => line !== "").slice(0, count)
  return rows.map((row) => {
    const cells = splitRow(row)
    const cell = (name: string): string => {
      const index = columns.indexOf(name)
      return index === -1 || index >= cells.length ? "" : cells[index] ?? ""
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

const readGate = (output: string): string | null => {
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

export const parseRun = (output: string): ParsedRun => {
  const status = scalar(output, "status")
  const gate = readGate(output)
  const parked = gate !== null ||
    trimmedLines(output).some((line) => line.startsWith("awaiting_agent:")) ||
    status === "awaiting_approval" ||
    status === "fix_review"
  return {
    status,
    outcome: scalar(output, "outcome"),
    prLink: scalar(output, "pr"),
    gate,
    parked,
    terminal: status === "completed" || status === "failed" || status === "cancelled",
    findings: gateFindings(output)
  }
}

export const answerForGate = (gate: string, findings: ReadonlyArray<NoMistakesFinding>): GateAnswer => {
  const question = findings.find((finding) => finding.id.startsWith("question-"))
  if (question !== undefined) {
    return { kind: "refuse", reason: "open review question " + question.id + " needs his word" }
  }
  const asked = findings.find((finding) => finding.action === "ask-user")
  if (asked !== undefined) {
    return { kind: "refuse", reason: "finding " + asked.id + " is marked ask-user and needs his word" }
  }
  const other = findings.find((finding) => finding.action !== "" && finding.action !== "auto-fix")
  if (other !== undefined) {
    return { kind: "refuse", reason: "finding " + other.id + " needs an answer orc cannot give" }
  }
  if (findings.length === 0) {
    return { kind: "refuse", reason: "the " + gate + " gate names no finding orc can fix" }
  }
  return { kind: "fix", ids: findings.map((finding) => finding.id) }
}

const remember = (
  seen: Array<NoMistakesFinding>,
  known: Set<string>,
  findings: ReadonlyArray<NoMistakesFinding>
): void => {
  for (const finding of findings) {
    if (!known.has(finding.id)) {
      known.add(finding.id)
      seen.push(finding)
    }
  }
}

const firstLine = (text: string): string => text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "the pipeline gave no reason"
const spawnNoMistakes = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  pathEnv: string,
  args: ReadonlyArray<string>,
  cwd: string
): Effect.Effect<NoMistakesCommand, OrcRunError> =>
  Effect.scoped(Effect.gen(function*() {
    const handle = yield* spawner.spawn(ChildProcess.make("no-mistakes", [...args], { cwd, env: { PATH: pathEnv }, extendEnv: true }))
    const [stdout, stderr, exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" })
    return { stdout, stderr, exitCode }
  })).pipe(
    Effect.mapError((cause) => cause instanceof OrcRunError ? cause : new OrcRunError({ message: "orc: no-mistakes failed to run: " + String(cause) }))
  )

const refused = (
  seen: ReadonlyArray<NoMistakesFinding>,
  gatesAnswered: number,
  gate: string | null,
  prLink: string | null,
  reason: string,
  started: string
): NoMistakesRecord => ({
  status: "refused",
  gate,
  findings: seen,
  gatesAnswered,
  prLink,
  result: "no-mistakes stopped" + (gate === null ? "." : " at the " + gate + " gate.") + " " + reason + ". No PR opens.",
  started,
  ended: new Date().toISOString()
})

const finished = (
  parsed: ParsedRun,
  seen: ReadonlyArray<NoMistakesFinding>,
  gatesAnswered: number,
  started: string
): NoMistakesRecord => {
  const ended = new Date().toISOString()
  if (parsed.status === "completed" && parsed.outcome !== "failed" && parsed.prLink !== "") {
    return {
      status: "passed",
      gate: null,
      findings: seen,
      gatesAnswered,
      prLink: parsed.prLink,
      result: "no-mistakes opened " + parsed.prLink + " and CI is green.",
      started,
      ended
    }
  }
  return {
    status: "failed",
    gate: null,
    findings: seen,
    gatesAnswered,
    prLink: parsed.prLink === "" ? null : parsed.prLink,
    result: "no-mistakes ended " + parsed.status + (parsed.outcome === "" ? "" : " with outcome " + parsed.outcome) + ". No PR opens.",
    started,
    ended
  }
}

const linkOrNull = (link: string): string | null => link === "" ? null : link

interface CollectedFindings {
  readonly seen: Array<NoMistakesFinding>
  readonly known: Set<string>
}

type DriveNext =
  | { readonly kind: "output"; readonly command: NoMistakesCommand; readonly answered: boolean }
  | { readonly kind: "record"; readonly record: NoMistakesRecord }

const answerGate = (
  input: NoMistakesInput,
  parsed: ParsedRun,
  collected: CollectedFindings,
  gatesAnswered: number,
  started: string
): Effect.Effect<DriveNext, OrcRunError> =>
  Effect.gen(function*() {
    const answer = answerForGate(parsed.gate ?? "unknown", parsed.findings)
    if (answer.kind === "refuse") {
      return { kind: "record", record: refused(collected.seen, gatesAnswered, parsed.gate, linkOrNull(parsed.prLink), answer.reason, started) }
    }
    const fixed = yield* spawnNoMistakes(input.spawner, input.pathEnv, ["axi", "respond", "--action", "fix", "--findings", answer.ids.join(",")], input.worktreeDir)
    if (fixed.exitCode !== 0) {
      return { kind: "record", record: refused(collected.seen, gatesAnswered, parsed.gate, linkOrNull(parsed.prLink), "no-mistakes refused the fix: " + firstLine(fixed.stderr), started) }
    }
    return { kind: "output", command: fixed, answered: true }
  })

const reattach = (
  input: NoMistakesInput,
  failed: NoMistakesCommand,
  collected: CollectedFindings,
  gatesAnswered: number,
  started: string
): Effect.Effect<DriveNext, OrcRunError> =>
  Effect.gen(function*() {
    const rerun = yield* spawnNoMistakes(input.spawner, input.pathEnv, ["axi", "run"], input.worktreeDir)
    if (rerun.exitCode === 0) {
      return { kind: "output", command: rerun, answered: false }
    }
    const status = yield* spawnNoMistakes(input.spawner, input.pathEnv, ["axi", "status"], input.worktreeDir)
    if (status.exitCode !== 0) {
      return yield* new OrcRunError({ message: "orc: no-mistakes left no gate and no outcome: " + firstLine(failed.stderr) })
    }
    const resting = parseRun(status.stdout)
    remember(collected.seen, collected.known, resting.findings)
    if (resting.terminal) {
      return { kind: "record", record: finished(resting, collected.seen, gatesAnswered, started) }
    }
    return yield* new OrcRunError({ message: "orc: no-mistakes left no gate and no outcome while the run is still " + (resting.status === "" ? "running" : resting.status) })
  })

export const driveNoMistakes = (input: NoMistakesInput): Effect.Effect<NoMistakesRecord, OrcRunError> =>
  Effect.gen(function*() {
    const started = new Date().toISOString()
    const collected: CollectedFindings = { seen: [], known: new Set<string>() }
    let gatesAnswered = 0
    let current = yield* spawnNoMistakes(input.spawner, input.pathEnv, ["axi", "run", "--intent-file", input.taskFile], input.worktreeDir)
    if (current.exitCode !== 0) {
      return yield* new OrcRunError({ message: "orc: no-mistakes refused to start: " + firstLine(current.stderr) })
    }
    for (let round = 0; ; round += 1) {
      if (round > maxDriveRounds) {
        return yield* new OrcRunError({ message: "orc: no-mistakes parked at " + maxDriveRounds.toString() + " gates without reaching an outcome" })
      }
      const parsed = parseRun(current.stdout)
      remember(collected.seen, collected.known, parsed.findings)
      if (parsed.terminal) {
        return finished(parsed, collected.seen, gatesAnswered, started)
      }
      const next = parsed.parked && parsed.gate !== null
        ? yield* answerGate(input, parsed, collected, gatesAnswered, started)
        : yield* reattach(input, current, collected, gatesAnswered, started)
      if (next.kind === "record") {
        return next.record
      }
      if (next.answered) {
        gatesAnswered += 1
      }
      current = next.command
    }
  })
