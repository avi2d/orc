import type { BoardTask } from "./board"

export interface Answer {
  readonly words: string
  readonly at: string
}

export interface Asked {
  readonly id: string
  readonly text: string
  readonly asked: string | null
  readonly answer: Answer | null
}

export interface HoldRecord {
  readonly reason: string
  readonly until: string | null
  readonly at: string | null
  readonly questions: ReadonlyArray<Asked>
  readonly answer: Answer | null
}

export interface TaskHold extends HoldRecord {
  readonly history: ReadonlyArray<HoldRecord>
}

export interface TaskParked {
  readonly branch: string
  readonly questions: ReadonlyArray<Asked>
}

export type TaskState =
  | { readonly status: "new" }
  | { readonly status: "taken"; readonly account: string | null }
  | { readonly status: "started"; readonly account: string; readonly started: string }
  | {
    readonly status: "closed"
    readonly account: string | null
    readonly started: string | null
    readonly outcome: string
    readonly pr: string | null
    readonly report: string | null
    readonly answer: Answer | null
    readonly closedAt: string
  }

export interface TaskDetail {
  readonly id: string
  readonly title: string
  readonly kind: BoardTask["kind"]
  readonly body: string
  readonly created: string
  readonly priority: number | null
  readonly dependsOn: ReadonlyArray<string>
  readonly prState: BoardTask["prState"]
  readonly hold: TaskHold | null
  readonly parked: TaskParked | null
  readonly state: TaskState
}

export interface TaskRun {
  readonly id: string
  readonly branch: string
  readonly machine: string | null
}

const empty = "—"

const taskBranch = (task: string): string => `orc/${task}`

export const runsOfTask = (runs: ReadonlyArray<TaskRun>, task: string): ReadonlyArray<TaskRun> =>
  runs.filter((run) => run.branch === taskBranch(task)).sort((a, b) => b.id.localeCompare(a.id))

// The Agents tab lists this machine's runs only, so a run on another machine has no card to open.
export const runToOpen = (runs: ReadonlyArray<TaskRun>): string | null =>
  runs.find((run) => run.machine === null)?.id ?? null

const twoDigits = (value: number): string => value.toString().padStart(2, "0")

export const shortTime = (iso: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) return iso
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) return iso
  return `${time.getFullYear()}-${twoDigits(time.getMonth() + 1)}-${twoDigits(time.getDate())} ${twoDigits(time.getHours())}:${twoDigits(time.getMinutes())}`
}

const infoLabels = ["Account", "Run", "Branch", "PR", "Depends on", "Created", "Started", "Closed", "Priority", "Assets"] as const
type InfoLabel = typeof infoLabels[number]

export interface InfoRow {
  readonly label: InfoLabel
  readonly value: string
}

const accountOf = (state: TaskState): string | null => state.status === "new" ? null : state.account

const startedOf = (state: TaskState): string | null =>
  state.status === "started" || state.status === "closed" ? state.started : null

const runValue = (runs: ReadonlyArray<TaskRun>): string | null => {
  const latest = runs.at(0)
  if (latest === undefined) return null
  const placed = latest.machine === null ? latest.id : `${latest.id} on ${latest.machine}`
  return runs.length === 1 ? placed : `${placed} (${runs.length - 1} earlier)`
}

const prValue = (task: TaskDetail): string | null => {
  const pr = task.state.status === "closed" ? task.state.pr : null
  if (pr === null) return null
  return task.prState === null ? pr : `${pr} (${task.prState})`
}

const infoValue = (task: TaskDetail, runs: ReadonlyArray<TaskRun>, label: InfoLabel): string | null => {
  switch (label) {
    case "Account": return accountOf(task.state)
    case "Run": return runValue(runs)
    case "Branch": return runs.length > 0 ? taskBranch(task.id) : task.parked?.branch ?? null
    case "PR": return prValue(task)
    case "Depends on": return task.dependsOn.length === 0 ? null : task.dependsOn.join(", ")
    case "Created": return shortTime(task.created)
    case "Started": {
      const started = startedOf(task.state)
      return started === null ? null : shortTime(started)
    }
    case "Closed": return task.state.status === "closed" ? `${shortTime(task.state.closedAt)} · ${task.state.outcome}` : null
    case "Priority": return task.priority === null ? null : `P${task.priority}`
    case "Assets": return task.state.status === "closed" ? task.state.report : null
  }
}

export const infoRows = (task: TaskDetail, runs: ReadonlyArray<TaskRun>): ReadonlyArray<InfoRow> =>
  infoLabels.map((label) => {
    const value = infoValue(task, runs, label)
    return { label, value: value === null || value === "" ? empty : value }
  })

export type AnswerTarget = { readonly kind: "question"; readonly id: string } | { readonly kind: "hold" }

export const answerArgv = (task: string, target: AnswerTarget, text: string): ReadonlyArray<string> | null => {
  const words = text.trim()
  if (words === "") return null
  return ["backlog", "answer", task, target.kind === "question" ? `${target.id}=${words}` : words]
}

export const mergeArgv = (task: string): ReadonlyArray<string> => ["merge", task, "--basis", "captain-word"]

export interface ThreadEntry {
  readonly key: string
  readonly who: string
  readonly what: string
  readonly at: string | null
  readonly text: string
  readonly reply: AnswerTarget | null
}

const answerEntry = (key: string, what: string, answer: Answer): ThreadEntry =>
  ({ key, who: "You", what, at: answer.at, text: answer.words, reply: null })

const questionEntries = (prefix: string, who: string, questions: ReadonlyArray<Asked>, at: string | null, open: boolean): ReadonlyArray<ThreadEntry> =>
  questions.flatMap((question) => {
    const key = `${prefix}-${question.id}`
    const asked: ThreadEntry = {
      key, who, what: `Question ${question.id}`, at: question.asked ?? at, text: question.text,
      reply: open && question.answer === null ? { kind: "question", id: question.id } : null
    }
    return question.answer === null ? [asked] : [asked, answerEntry(`${key}-answer`, `Answer to ${question.id}`, question.answer)]
  })

const holdEntries = (prefix: string, hold: HoldRecord): ReadonlyArray<ThreadEntry> => {
  const open = hold.answer === null
  const reason: ThreadEntry = {
    key: prefix, who: "orc", what: hold.until === null ? "Hold" : `Hold until ${shortTime(hold.until)}`, at: hold.at, text: hold.reason,
    reply: open && hold.questions.length === 0 ? { kind: "hold" } : null
  }
  // With questions, hold.answer only joins the answers the questions already show.
  const answer = hold.answer === null || hold.questions.length > 0 ? [] : [answerEntry(`${prefix}-answer`, "Answer", hold.answer)]
  return [reason, ...questionEntries(prefix, "orc", hold.questions, hold.at, open), ...answer]
}

export const threadEntries = (task: TaskDetail): ReadonlyArray<ThreadEntry> => {
  const holds = task.hold === null ? [] : [...task.hold.history, task.hold]
  const held = holds.flatMap((hold, index) => holdEntries(`hold-${index}`, hold))
  const parked = task.parked === null ? [] : questionEntries("parked", "Run", task.parked.questions, null, true)
  const decided = task.state.status === "closed" && task.state.answer !== null ? [answerEntry("decision-answer", "Answer", task.state.answer)] : []
  return [...held, ...parked, ...decided]
}
