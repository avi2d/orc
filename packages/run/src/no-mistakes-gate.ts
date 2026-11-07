import { scalar, splitRow, table, trimmedLines } from "./toon"

export const askUserWord = "ask-user"
export type AllowWord = typeof askUserWord
export interface QuestionAnswer {
  readonly question: string
  readonly answer: string
}

export interface OpenQuestion {
  readonly id: string
  readonly text: string
  readonly asked?: string | undefined
}

export interface NoMistakesFinding {
  readonly id: string
  readonly severity: string
  readonly file: string
  readonly line: string
  readonly action: string
  readonly description: string
}

export interface ParkedGate {
  readonly step: string
  readonly stage: "approval" | "fix-review"
}

export interface ParsedRun {
  readonly status: string
  readonly outcome: string
  readonly error: string
  readonly prSkipReason: string
  readonly prLink: string
  readonly runId: string
  readonly gate: ParkedGate | null
  readonly terminal: boolean
  readonly findings: ReadonlyArray<NoMistakesFinding>
}

export type GateAnswer =
  | { readonly kind: "fix"; readonly ids: ReadonlyArray<string>; readonly ignore: ReadonlyArray<string>; readonly instructions?: string }
  | { readonly kind: "approve" }
  | { readonly kind: "refuse"; readonly reason: string }

export type GateResponse = Exclude<GateAnswer, { readonly kind: "refuse" }>

const terminalStatuses = new Set(["completed", "failed", "cancelled", "checks_passed"])

export const findingsTable = (output: string): ReadonlyArray<NoMistakesFinding> =>
  table(output, "findings").map((row) => ({
    id: row.get("id") ?? "",
    severity: row.get("severity") ?? "",
    file: row.get("file") ?? "",
    line: row.get("line") ?? "",
    action: row.get("action") ?? "",
    description: row.get("description") ?? ""
  }))

export const stepsWithFindings = (output: string): ReadonlyArray<string> =>
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
    error: scalar(output, "error"),
    prSkipReason: table(output, "automatic_skips").find((row) => row.get("step") === "pr")?.get("reason") ?? "",
    prLink: scalar(output, "pr"),
    runId: scalar(output, "id"),
    gate: readGate(output),
    terminal: outcome !== "" || terminalStatuses.has(status),
    findings: findingsTable(output)
  }
}

const isQuestion = (finding: NoMistakesFinding): boolean => finding.id.startsWith("question-")

const isAskUser = (finding: NoMistakesFinding): boolean => finding.action === "ask-user" && !isQuestion(finding)

export const askUserFindings = (findings: ReadonlyArray<NoMistakesFinding>, allow: ReadonlyArray<AllowWord>): ReadonlyArray<NoMistakesFinding> =>
  allow.includes(askUserWord) ? [] : findings.filter(isAskUser)

const questionReason = (question: NoMistakesFinding): string => {
  const quoted = question.description === "" ? "" : ` "${question.description}"`
  return isQuestion(question)
    ? `finding ${question.id} is a question${quoted} and needs your answer on a rerun with --answer ${question.id}="<answer>"`
    : `finding ${question.id} is marked ask-user${quoted} and needs your word on a rerun with --answer ${question.id}="<answer>" or --allow ask-user`
}

export const missingReason = (missing: ReadonlyArray<NoMistakesFinding>): string =>
  missing.map(questionReason).join("; ")

export const omittedQuestionIds = (output: string): ReadonlyArray<string> =>
  scalar(output, "review-questions-omitted").match(/question-[A-Za-z0-9-]+/g) ?? []

export const openQuestionsIn = (findings: ReadonlyArray<NoMistakesFinding>, omittedIds: ReadonlyArray<string>): ReadonlyArray<NoMistakesFinding> => {
  const rendered = findings.filter(isQuestion)
  const known = new Set(rendered.map((finding) => finding.id))
  const omitted = omittedIds
    .filter((id) => !known.has(id))
    .map((id): NoMistakesFinding => ({ id, severity: "", file: "", line: "", action: "", description: "" }))
  return [...rendered, ...omitted]
}

export const answerArgsFor = (question: string, answer: string): ReadonlyArray<string> =>
  ["axi", "answer", "--question", question, "--answer", answer]

const answeredGuidance = (settled: ReadonlyArray<NoMistakesFinding>, answers: ReadonlyArray<QuestionAnswer>): string =>
  ["The captain answered these findings; fix each as the answer says:",
    ...settled.map((finding) => finding.id + ": " + (answers.find((entry) => entry.question === finding.id)?.answer ?? ""))].join("\n")

export const answeredAskUser = (
  findings: ReadonlyArray<NoMistakesFinding>,
  answers: ReadonlyArray<QuestionAnswer>
): ReadonlyArray<NoMistakesFinding> =>
  findings.filter(isAskUser).filter((finding) => answers.some((entry) => entry.question === finding.id))

export const answerForGate = (
  gate: ParkedGate,
  findings: ReadonlyArray<NoMistakesFinding>,
  allow: ReadonlyArray<AllowWord> = [],
  answers: ReadonlyArray<QuestionAnswer> = []
): GateAnswer => {
  const open = findings.filter(isQuestion)
  if (open.length > 0) {
    return { kind: "refuse", reason: missingReason(open) }
  }
  const asked = findings.filter(isAskUser)
  const settled = answeredAskUser(findings, answers)
  const unsettled = askUserFindings(asked.filter((finding) => !answers.some((entry) => entry.question === finding.id)), allow)
  if (unsettled.length > 0) {
    return { kind: "refuse", reason: missingReason(unsettled) }
  }
  const worded = asked.filter((finding) => !answers.some((entry) => entry.question === finding.id))
  const rest = findings.filter((finding) => !isAskUser(finding))
  const other = rest.find((finding) => finding.action !== "auto-fix" && finding.action !== "no-op")
  if (other !== undefined) {
    return { kind: "refuse", reason: "finding " + other.id + " needs an answer orc cannot give" }
  }
  const fixable = [...rest.filter((finding) => finding.action === "auto-fix"), ...settled]
  const ignore = [...rest.filter((finding) => finding.action === "no-op"), ...worded].map((finding) => finding.id)
  if (gate.stage === "fix-review") {
    if (settled.length === 0) {
      return { kind: "approve" }
    }
    return {
      kind: "fix",
      ids: fixable.map((finding) => finding.id),
      ignore,
      instructions: answeredGuidance(settled, answers)
    }
  }
  if (fixable.length > 0) {
    return {
      kind: "fix",
      ids: fixable.map((finding) => finding.id),
      ignore,
      ...(settled.length === 0 ? {} : { instructions: answeredGuidance(settled, answers) })
    }
  }
  if (rest.length > 0 || worded.length > 0) {
    return { kind: "approve" }
  }
  return { kind: "refuse", reason: "the " + gate.step + " gate names no finding orc can fix" }
}

export const respondArgs = (answer: GateResponse): ReadonlyArray<string> =>
  answer.kind === "approve"
    ? ["axi", "respond", "--action", "approve"]
    : [
      "axi", "respond", "--action", "fix", "--findings", answer.ids.join(","),
      ...(answer.ignore.length === 0 ? [] : ["--ignore", answer.ignore.join(",")]),
      ...(answer.instructions === undefined ? [] : ["--instructions", answer.instructions])
    ]
