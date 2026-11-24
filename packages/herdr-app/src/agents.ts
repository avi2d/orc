import type { Backlog, Run, Runs, ShownStep, Step, Task } from "./guard"
import { type InboxAnswer, type InboxApproval, type InboxItem, approvalItem } from "./inbox"

export const cardStatuses = ["Awaiting you", "Running", "Queued", "Failed", "Done"] as const
export type CardStatus = typeof cardStatuses[number]

export const railLabel = (card: Pick<Card, "id" | "runId">): string => {
  const id = card.runId ?? card.id
  return id.length > 10 ? id.slice(-6) : id
}

export type Standing =
  | { readonly status: "Awaiting you"; readonly waiting: { readonly on: "answer"; readonly items: readonly [InboxAnswer, ...InboxAnswer[]] } | { readonly on: "approval"; readonly item: InboxApproval } }
  | { readonly status: Exclude<CardStatus, "Awaiting you"> }

export interface Card {
  readonly key: string
  readonly id: string
  readonly kind: string | null
  readonly delivery: string | null
  readonly title: string
  readonly project: string
  readonly standing: Standing
  readonly where: string
  readonly runId: string | null
  readonly checkout: Checkout | null
  readonly sendBack: string | null
}

export interface Checkout {
  readonly worktree: string
  readonly branch: string
}

export interface RunAgent {
  readonly model: string | null
  readonly effort: string | null
}

export const approveRow = "approve"

export interface Filter {
  readonly project: string | null
  readonly status: CardStatus | null
}

export type Mark = "✓" | "✗" | "●" | "◆" | "○"

export interface StepRow {
  readonly key: string
  readonly label: string
  readonly mark: Mark | null
  readonly stepId: number | null
}

type ListedStep = Step & Pick<ShownStep, "from">

const lastSegment = (path: string): string => path.split("/").filter((part) => part !== "").at(-1) ?? path

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? ""

export const prNumber = (link: string): string => {
  const number = /\/pull\/(\d+)/.exec(link)?.[1]
  return number === undefined ? "PR" : `PR #${number}`
}

const answerLabel = (item: InboxAnswer): string => {
  switch (item.kind) {
    case "hold": return "Hold"
    case "decision": return "Decision"
    case "question": return "Question 1"
  }
}

const stepLabel = (step: Pick<Step, "name" | "attempt">): string => {
  switch (step.name) {
    case "implement":
      return "Agent"
    case "checks":
      return `Checks ${step.attempt}`
    case "fix":
      return `Fix ${step.attempt}`
    case "pr":
      return "PR"
    case "no-mistakes":
      return "No mistakes"
    default:
      return step.name
  }
}

const taskBranches = (task: Task): ReadonlyArray<string> => [`orc/${task.id}`, `orc/${task.id}-parent`]

const queuedWhere = (task: Task): string => task.hold === null ? "Waiting to start" : "Held"

type Place = Pick<Card, "standing" | "where">

const awaitingAnswer = (items: ReadonlyArray<InboxAnswer>): Place | null => {
  const first = items.at(0)
  return first === undefined ? null : {
    standing: { status: "Awaiting you", waiting: { on: "answer", items: [first, ...items.slice(1)] } },
    where: items.length === 1 ? answerLabel(first) : `${items.length} open items`
  }
}

const newestRun = (runs: Runs): ReadonlySet<string> => {
  const newest = new Map<string, string>()
  for (const run of runs.runs) {
    const prior = newest.get(run.branch)
    if (prior === undefined || prior < run.id) {
      newest.set(run.branch, run.id)
    }
  }
  return new Set(newest.values())
}

const awaitingApproval = (item: InboxApproval): Place => ({
  standing: { status: "Awaiting you", waiting: { on: "approval", item } },
  where: `Approve ${prNumber(item.link)}`
})

const prPlace = (runId: string, link: string, task: Task | undefined, merged: ReadonlySet<string>, newest: boolean, approval: InboxApproval | undefined): Place => {
  const pr = prNumber(link)
  if (task === undefined) {
    return { standing: { status: "Done" }, where: pr }
  }
  if (task.status !== "closed" && task.parkedOrigin === runId) {
    return { standing: { status: "Done" }, where: `Sent back ${pr}` }
  }
  if (!newest) {
    return { standing: { status: "Done" }, where: `Sent back ${pr}` }
  }
  if (merged.has(task.id)) {
    return { standing: { status: "Done" }, where: `Merged ${pr}` }
  }
  if (task.status !== "closed") return awaitingApproval(approvalItem(task, link, null))
  return approval?.link === link ? awaitingApproval(approval) : { standing: { status: "Done" }, where: pr }
}

const sendBackOf = (task: Task | undefined, standing: Standing): string | null =>
  task?.status === "closed" && standing.status === "Awaiting you" && standing.waiting.on === "approval" ? task.id : null

const runningPlace = (run: Run): Place =>
  ({ standing: { status: "Running" }, where: run.step === null ? "Starting" : stepLabel(run.step) })

const finishedPlace = (run: Run, task: Task | undefined, merged: ReadonlySet<string>, newest: boolean, approval: InboxApproval | undefined): Place => {
  if (run.status === "succeeded") {
    return run.prLink === null ? { standing: { status: "Done" }, where: "Done" } : prPlace(run.id, run.prLink, task, merged, newest, approval)
  }
  return { standing: { status: "Failed" }, where: firstLine(run.endReason ?? task?.reason ?? run.status) }
}

const waitingRunByTask = (runs: Runs, byBranch: ReadonlyMap<string, Task>): Map<string, string> => {
  const waiting = new Map<string, string>()
  for (const run of runs.runs) {
    const task = byBranch.get(run.branch)
    if (task === undefined || run.status !== "running" || run.questions === 0) continue
    const prior = waiting.get(task.id)
    if (prior === undefined || run.id > prior) waiting.set(task.id, run.id)
  }
  return waiting
}

const answersByTask = (items: ReadonlyArray<InboxItem>): Map<string, Array<InboxAnswer>> => {
  const byTask = new Map<string, Array<InboxAnswer>>()
  for (const item of items) {
    if (item.kind === "pr") continue
    const existing = byTask.get(item.task)
    if (existing === undefined) byTask.set(item.task, [item])
    else existing.push(item)
  }
  return byTask
}

const runCard = (run: Run, task: Task | undefined, place: Place): Card => ({
  key: run.id,
  id: task?.id ?? run.id,
  kind: run.kind ?? task?.kind ?? null,
  delivery: run.delivery,
  title: run.title ?? task?.title ?? run.branch,
  project: task?.project ?? lastSegment(run.project),
  ...place,
  runId: run.id,
  checkout: run.worktree === null ? null : { worktree: run.worktree, branch: run.branch },
  sendBack: sendBackOf(task, place.standing)
})

const taskCard = (task: Task, active: ReadonlySet<string>, pending: ReadonlyArray<InboxAnswer>, approval: InboxApproval | undefined): ReadonlyArray<Card> => {
  const waiting = approval === undefined ? awaitingAnswer(pending) : awaitingApproval(approval)
  if (task.status === "closed" && (active.has(task.id) || waiting === null)) return []
  if (waiting === null && active.has(task.id)) return []
  const place = waiting ?? { standing: { status: "Queued" } as const, where: queuedWhere(task) }
  return [{ key: task.id, id: task.id, kind: task.kind, delivery: null, title: task.title, project: task.project, ...place, runId: null, checkout: null, sendBack: sendBackOf(task, place.standing) }]
}

export const buildCards = (runs: Runs, backlog: Backlog, items: ReadonlyArray<InboxItem> = []): ReadonlyArray<Card> => {
  const byBranch = new Map(backlog.tasks.flatMap((task) => taskBranches(task).map((branch) => [branch, task] as const)))
  const merged = new Set(backlog.merged)
  const newest = newestRun(runs)
  const waitingRuns = waitingRunByTask(runs, byBranch)
  const answers = answersByTask(items)
  const approvals = new Map(items.filter((item) => item.kind === "pr").map((item) => [item.task, item]))
  const active = new Set<string>()
  const cards: Array<Card> = []
  for (const run of runs.runs) {
    const task = byBranch.get(run.branch)
    const id = task?.id ?? run.id
    const runAnswers = waitingRuns.get(id) === run.id ? (answers.get(id) ?? []).filter((item) => item.who === "worker") : []
    const place = run.status === "running"
      ? awaitingAnswer(runAnswers) ?? runningPlace(run)
      : finishedPlace(run, task, merged, newest.has(run.id), approvals.get(id))
    if (task !== undefined && (place.standing.status === "Running" || place.standing.status === "Awaiting you")) {
      active.add(task.id)
    }
    cards.push(runCard(run, task, place))
  }
  const queued = backlog.tasks.flatMap((task) =>
    taskCard(task, active, (answers.get(task.id) ?? []).filter((item) => item.who !== "worker" || !waitingRuns.has(task.id)), approvals.get(task.id)))
  return sortCards([...cards, ...queued])
}

export const cardAnswers = (card: Pick<Card, "standing"> | null): ReadonlyArray<InboxAnswer> =>
  card?.standing.status === "Awaiting you" && card.standing.waiting.on === "answer" ? card.standing.waiting.items : []

export const sendBackArgs = (card: Pick<Card, "sendBack">, words: string): ReadonlyArray<string> | null =>
  card.sendBack === null || words.trim() === "" ? null : ["backlog", "send-back", card.sendBack, words.trim()]

const sortCards = (cards: ReadonlyArray<Card>): ReadonlyArray<Card> =>
  cardStatuses.flatMap((status) => cards.filter((card) => card.standing.status === status))

export const filterCards = (cards: ReadonlyArray<Card>, filter: Filter): ReadonlyArray<Card> =>
  cards.filter((card) =>
    (filter.project === null || card.project === filter.project) &&
    (filter.status === null || card.standing.status === filter.status))

export const projectsOf = (cards: ReadonlyArray<Card>): ReadonlyArray<string> =>
  [...new Set(cards.map((card) => card.project))].sort((a, b) => a.localeCompare(b))

const recordedMark = (step: Step, standing: Standing): Mark => {
  switch (step.status) {
    case "passed":
      return "✓"
    case "failed":
      return "✗"
    case "skipped":
      return "○"
    case "running":
      if (standing.status === "Awaiting you" && standing.waiting.on === "answer") return "◆"
      if (standing.status === "Failed" || standing.status === "Done") return "✗"
      return "●"
  }
}

const delivers = (step: Step): boolean => step.name === "pr" || step.name === "no-mistakes"

const stepsToCome = (steps: ReadonlyArray<Step>, kind: string | null, delivery: string | null): ReadonlyArray<string> => {
  if (kind !== null && kind !== "ship") {
    return steps.length === 0 ? ["Agent"] : []
  }
  const last = steps.at(-1)
  const rounds = steps.filter((step) => step.name === "checks").at(-1)?.attempt ?? 0
  const fixes = steps.reduce((max, step) => step.name === "fix" ? Math.max(max, step.attempt) : max, 0)
  const finalStep = delivery === "direct-PR" ? "PR" : "No mistakes"
  if (last === undefined) {
    return ["Agent", "Checks 1", finalStep]
  }
  if (steps.some(delivers)) {
    return []
  }
  if (last.name === "checks") {
    return last.status === "failed" ? [`Fix ${fixes + 1}`, `Checks ${rounds + 1}`, finalStep] : [finalStep]
  }
  return [`Checks ${rounds + 1}`, finalStep]
}

export const goesOn = (standing: Standing): boolean =>
  standing.status === "Running" || standing.status === "Queued" || (standing.status === "Awaiting you" && standing.waiting.on === "answer")

export const stepRows = (standing: Standing, steps: ReadonlyArray<ListedStep>, kind: string | null = null, delivery: string | null = null): ReadonlyArray<StepRow> => {
  const carried = steps.filter((step) => step.from !== null)
  const own = steps.filter((step) => step.from === null)
  const ordered = [...carried, ...own]
  const recorded: Array<StepRow> = []
  let previous: string | null = null
  for (const step of carried) {
    if (step.from !== previous) {
      previous = step.from
      recorded.push({ key: `from-${step.from}`, label: `From run ${step.from}`, mark: null, stepId: null })
    }
    recorded.push({ key: `step-${step.id}`, label: stepLabel(step), mark: recordedMark(step, standing), stepId: step.id })
  }
  for (const step of own) {
    recorded.push({ key: `step-${step.id}`, label: stepLabel(step), mark: recordedMark(step, standing), stepId: step.id })
  }
  const toCome = goesOn(standing)
    ? stepsToCome(ordered, kind, delivery).map((label): StepRow => ({ key: `next-${label}`, label, mark: "○", stepId: null }))
    : []
  const approval = standing.status === "Awaiting you" && standing.waiting.on === "approval"
    ? [{ key: approveRow, label: `Approve ${prNumber(standing.waiting.item.link)}`, mark: "◆" as const, stepId: null }]
    : []
  return [...recorded, ...toCome, ...approval]
}

export const runAgent = (steps: ReadonlyArray<Pick<ShownStep, "name" | "model" | "thinking">>): RunAgent | null => {
  const agent = steps.find((step) => step.name === "implement")
  return agent === undefined ? null : { model: agent.model, effort: agent.thinking }
}

const piSteps: ReadonlySet<string> = new Set(["implement"])

export const opensTurns = (step: Pick<ShownStep, "name" | "piSessionFile">): boolean =>
  piSteps.has(step.name) || step.piSessionFile !== null

export const agentLabel = (agent: RunAgent | null): string | null => {
  const words = agent === null ? [] : [agent.model, agent.effort].filter((word) => word !== null)
  return words.length === 0 ? null : words.join(" ")
}

export const cardPlace = (card: Pick<Card, "where">, agent: RunAgent | null): string => {
  const label = agentLabel(agent)
  return label === null ? card.where : `${label} · ${card.where}`
}

export const namedModels = (steps: ReadonlyArray<Pick<ShownStep, "id" | "name" | "model" | "thinking">>): ReadonlyMap<number, string> => {
  const runModel = runAgent(steps)?.model ?? null
  return new Map(steps.flatMap((step) => step.model === null || step.model === runModel ? [] : [[step.id, step.model] as const]))
}
