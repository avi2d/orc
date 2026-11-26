import { scalar, splitRow, table, trimmedLines, workerCiInstructions } from "../../shared/lib/index"

export const askUserWord = "ask-user"
export type AllowWord = typeof askUserWord
export interface QuestionAnswer {
  readonly question: string
  readonly answer: string
}

export const holdReleaseId = "hold-release"
export const carriedHoldReleaseId = "hold-release-carried"

export const holdReleaseWordsOf = (answers: ReadonlyArray<QuestionAnswer>): ReadonlyArray<string> =>
  answers.filter((entry) => entry.question === holdReleaseId || entry.question === carriedHoldReleaseId).map((entry) => entry.answer)

export const isNewHoldRelease = (answers: ReadonlyArray<QuestionAnswer>): boolean =>
  answers.some((entry) => entry.question === holdReleaseId)

export const holdReleaseGuidance = (words: ReadonlyArray<string>): string =>
  "The captain released the repeat hold with: " + words.join("\nThe captain also wrote: ") + "\nFollow that guidance as you retry the task."

export interface OpenQuestion {
  readonly id: string
  readonly text: string
  readonly asked?: string | undefined
  readonly asking?: string | undefined
  readonly blocks?: boolean | undefined
  readonly options?: ReadonlyArray<{ readonly text: string; readonly outcome?: string | undefined; readonly picture?: string | undefined }> | undefined
  readonly recommendation?: string | undefined
  readonly asks?: string | undefined
  readonly owner?: "user" | undefined
}

export interface NoMistakesFinding {
  readonly id: string
  readonly severity: string
  readonly file: string
  readonly line: string
  readonly action: string
  readonly description: string
  readonly asks?: string | undefined
}

export type PendingFinding = NoMistakesFinding & Pick<OpenQuestion, "owner">

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
  | { readonly kind: "approve"; readonly followUps?: ReadonlyArray<string> }
  | { readonly kind: "refuse"; readonly reason: string }

export type GateResponse = Exclude<GateAnswer, { readonly kind: "refuse" }>

const terminalStatuses = new Set(["completed", "failed", "cancelled", "checks_passed"])

const askedOf = (asks: string): { readonly asks?: string } => asks === "" ? {} : { asks }

export const findingsTable = (output: string): ReadonlyArray<NoMistakesFinding> =>
  table(output, "findings").map((row) => ({
    id: row.get("id") ?? "",
    severity: row.get("severity") ?? "",
    file: row.get("file") ?? "",
    line: row.get("line") ?? "",
    action: row.get("action") ?? "",
    description: row.get("description") ?? "",
    ...askedOf((row.get("question_action") ?? "").trim())
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

type Classified = Pick<NoMistakesFinding, "id" | "action">

export const isQuestion = (finding: Pick<NoMistakesFinding, "id">): boolean => finding.id.startsWith("question-")

const orcActions = new Set(["auto-fix", "no-op"])

const isAskUser = (finding: Classified): boolean => !orcActions.has(finding.action) && !isQuestion(finding)

export const isUnknownAction = (finding: Classified): boolean => isAskUser(finding) && finding.action !== "ask-user"

export const askUserFindings = (findings: ReadonlyArray<NoMistakesFinding>, allow: ReadonlyArray<AllowWord>): ReadonlyArray<NoMistakesFinding> =>
  allow.includes(askUserWord) ? findings.filter(isUnknownAction) : findings.filter(isAskUser)

const questionReason = (question: NoMistakesFinding): string => {
  const quoted = question.description === "" ? "" : ` "${question.description}"`
  if (isQuestion(question)) {
    if (question.description.trim() === "") {
      return `no-mistakes omitted the question text for ${question.id}, so orc needs your answer on a rerun with --answer ${question.id}="<answer>"`
    }
    return `finding ${question.id} is a question${quoted} and needs your answer on a rerun with --answer ${question.id}="<answer>"`
  }
  return question.action === "ask-user"
    ? `finding ${question.id} is marked ask-user${quoted} and needs your word on a rerun with --answer ${question.id}="<answer>" or --allow ask-user`
    : `finding ${question.id}${quoted} needs an answer orc cannot give, so it needs your word on a rerun with --answer ${question.id}="<answer>"`
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
    .map((id): NoMistakesFinding => ({ id, severity: "", file: "", line: "", action: "", description: "", asks: "unknown" }))
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
  const fixable = [...rest.filter((finding) => finding.action === "auto-fix"), ...settled]
  const ignore = [...rest.filter((finding) => finding.action === "no-op"), ...worded].map((finding) => finding.id)
  const released = holdReleaseWordsOf(answers)
  const releasedGuidance = released.length === 0 ? null : holdReleaseGuidance(released)
  const instructionsOf = (resolved: ReadonlyArray<NoMistakesFinding>): string | undefined => {
    const parts = [...(resolved.length === 0 ? [] : [answeredGuidance(resolved, answers)]), ...(releasedGuidance === null ? [] : [releasedGuidance])]
    return parts.length === 0 ? undefined : parts.join("\n")
  }
  if (gate.stage === "fix-review") {
    if (settled.length === 0) {
      return { kind: "approve" }
    }
    const instructions = instructionsOf(settled)
    return {
      kind: "fix",
      ids: fixable.map((finding) => finding.id),
      ignore,
      ...(instructions === undefined ? {} : { instructions })
    }
  }
  if (fixable.length > 0) {
    const instructions = instructionsOf(settled)
    return {
      kind: "fix",
      ids: fixable.map((finding) => finding.id),
      ignore,
      ...(instructions === undefined ? {} : { instructions })
    }
  }
  if (rest.length > 0 || worded.length > 0) {
    return { kind: "approve" }
  }
  return { kind: "refuse", reason: "the " + gate.step + " gate names no finding orc can fix" }
}

export const respondArgs = (answer: GateResponse): ReadonlyArray<string> =>
  answer.kind === "approve"
    ? ["axi", "respond", "--action", "approve", ...(answer.followUps === undefined ? [] : ["--follow-ups", answer.followUps.join(",")])]
    : [
      "axi", "respond", "--action", "fix", "--findings", answer.ids.join(","),
      ...(answer.ignore.length === 0 ? [] : ["--ignore", answer.ignore.join(",")]),
      "--instructions", [workerCiInstructions, answer.instructions].filter((entry) => entry !== undefined).join("\n\n")
    ]
