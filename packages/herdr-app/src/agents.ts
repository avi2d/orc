import type { Backlog, Run, Runs, ShownStep, Step, Task } from "./guard"

export const cardStatuses = ["Awaiting you", "Running", "Queued", "Failed", "Done"] as const
export type CardStatus = typeof cardStatuses[number]

export const railLabel = (card: Pick<Card, "id" | "runId">): string => {
  const id = card.runId ?? card.id
  return id.length > 10 ? id.slice(-6) : id
}

export type Standing =
  | { readonly status: "Awaiting you"; readonly waiting: { readonly on: "answer" } | { readonly on: "approval"; readonly pr: string; readonly link: string } }
  | { readonly status: Exclude<CardStatus, "Awaiting you"> }

export interface Card {
  readonly key: string
  readonly id: string
  readonly kind: string | null
  readonly delivery: string | null
  readonly title: string
  readonly project: string
  readonly known: boolean
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
  readonly allRuns: boolean
}

export type Mark = "✓" | "✗" | "●" | "◆" | "○"

export interface StepRow {
  readonly key: string
  readonly label: string
  readonly mark: Mark
  readonly stepId: number | null
}

const lastSegment = (path: string): string => path.split("/").filter((part) => part !== "").at(-1) ?? path

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? ""

const prNumber = (link: string): string => {
  const number = /\/pull\/(\d+)/.exec(link)?.[1]
  return number === undefined ? "PR" : `PR #${number}`
}

const questionsLabel = (count: number): string => count === 1 ? "Question 1" : `Questions 1-${count}`

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

const openQuestions = (task: Task): number => task.status === "closed" ? 0 : (task.parked ?? 0) + (task.hold ?? 0)

const queuedWhere = (task: Task): string => task.hold === null ? "Waiting to start" : "Held"

const awaitingAnswer = (count: number): { readonly standing: Standing; readonly where: string } =>
  ({ standing: { status: "Awaiting you", waiting: { on: "answer" } }, where: questionsLabel(count) })

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

const prPlace = (pr: string, link: string, runId: string, task: Task | undefined, merged: ReadonlySet<string>, newest: boolean): { readonly standing: Standing; readonly where: string } => {
  if (task === undefined) {
    return { standing: { status: "Done" }, where: pr }
  }
  if (task.status !== "closed" && task.parkedOrigin === runId) {
    return { standing: { status: "Done" }, where: `Sent back ${pr}` }
  }
  if (!newest) {
    return { standing: { status: "Done" }, where: `Sent back ${pr}` }
  }
  if (!merged.has(task.id)) {
    return { standing: { status: "Awaiting you", waiting: { on: "approval", pr, link } }, where: `Approve ${pr}` }
  }
  return { standing: { status: "Done" }, where: `Merged ${pr}` }
}

const settledPlace = (run: Run, task: Task | undefined, newest: boolean): { readonly standing: Standing; readonly where: string } | null => {
  if (run.prLink === null || !newest || task === undefined) {
    return null
  }
  const pr = prNumber(run.prLink)
  switch (task.prState) {
    case "merged":
      return { standing: { status: "Done" }, where: `Merged ${pr}` }
    case "closed":
      return { standing: { status: "Failed" }, where: `Closed ${pr}` }
    case "open":
    case null:
      return null
  }
}

const sendBackOf = (task: Task | undefined, standing: Standing): string | null =>
  task?.status === "closed" && standing.status === "Awaiting you" && standing.waiting.on === "approval" ? task.id : null

const runPlace = (run: Run, task: Task | undefined, merged: ReadonlySet<string>, newest: boolean): { readonly standing: Standing; readonly where: string } => {
  const questions = run.status === "running" ? run.questions : 0
  if (questions > 0) {
    return awaitingAnswer(questions)
  }
  if (run.status === "running") {
    return { standing: { status: "Running" }, where: run.step === null ? "Starting" : stepLabel(run.step) }
  }
  const settled = settledPlace(run, task, newest)
  if (settled !== null) {
    return settled
  }
  if (run.status === "succeeded") {
    return run.prLink === null ? { standing: { status: "Done" }, where: "Done" } : prPlace(prNumber(run.prLink), run.prLink, run.id, task, merged, newest)
  }
  return { standing: { status: "Failed" }, where: firstLine(run.endReason ?? task?.reason ?? run.status) }
}

export const buildCards = (runs: Runs, backlog: Backlog): ReadonlyArray<Card> => {
  const byBranch = new Map(backlog.tasks.flatMap((task) => taskBranches(task).map((branch) => [branch, task] as const)))
  const merged = new Set(backlog.merged)
  const approval = newestRun(runs)
  const known = (project: string): boolean => backlog.projects === null || backlog.projects.includes(project)
  const active = new Set<string>()
  const cards: Array<Card> = []
  for (const run of runs.runs) {
    const task = byBranch.get(run.branch)
    const place = runPlace(run, task, merged, approval.has(run.id))
    if (task !== undefined && (place.standing.status === "Running" || place.standing.status === "Awaiting you")) {
      active.add(task.id)
    }
    const project = task?.project ?? lastSegment(run.project)
    cards.push({
      key: run.id,
      id: task?.id ?? run.id,
      kind: run.kind ?? task?.kind ?? null,
      delivery: run.delivery,
      title: run.title ?? task?.title ?? run.branch,
      project,
      known: known(project),
      ...place,
      runId: place.standing.status === "Queued" ? null : run.id,
      checkout: run.worktree === null ? null : { worktree: run.worktree, branch: run.branch },
      sendBack: sendBackOf(task, place.standing)
    })
  }
  for (const task of backlog.tasks) {
    if (active.has(task.id) || task.status === "closed") {
      continue
    }
    const questions = openQuestions(task)
    const place = questions > 0 ? awaitingAnswer(questions) : { standing: { status: "Queued" } as const, where: queuedWhere(task) }
    cards.push({ key: task.id, id: task.id, kind: task.kind, delivery: null, title: task.title, project: task.project, known: known(task.project), ...place, runId: null, checkout: null, sendBack: null })
  }
  return sortCards(cards)
}

export const sendBackArgs = (card: Pick<Card, "sendBack">, words: string): ReadonlyArray<string> | null =>
  card.sendBack === null || words.trim() === "" ? null : ["backlog", "send-back", card.sendBack, words.trim()]

const sortCards = (cards: ReadonlyArray<Card>): ReadonlyArray<Card> =>
  cardStatuses.flatMap((status) => cards.filter((card) => card.standing.status === status))

export const filterCards = (cards: ReadonlyArray<Card>, filter: Filter): ReadonlyArray<Card> =>
  cards.filter((card) =>
    (filter.project === null ? filter.allRuns || card.known : card.project === filter.project) &&
    (filter.status === null || card.standing.status === filter.status))

export const projectsOf = (cards: ReadonlyArray<Card>): ReadonlyArray<string> =>
  [...new Set(cards.flatMap((card) => card.known ? [card.project] : []))].sort((a, b) => a.localeCompare(b))

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

export const stepRows = (standing: Standing, steps: ReadonlyArray<Step>, kind: string | null = null, delivery: string | null = null): ReadonlyArray<StepRow> => {
  const recorded = steps.map((step): StepRow => ({ key: `step-${step.id}`, label: stepLabel(step), mark: recordedMark(step, standing), stepId: step.id }))
  const toCome = goesOn(standing)
    ? stepsToCome(steps, kind, delivery).map((label): StepRow => ({ key: `next-${label}`, label, mark: "○", stepId: null }))
    : []
  const approval = standing.status === "Awaiting you" && standing.waiting.on === "approval"
    ? [{ key: approveRow, label: `Approve ${standing.waiting.pr}`, mark: "◆" as const, stepId: null }]
    : []
  return [...recorded, ...toCome, ...approval]
}

export const runAgent = (steps: ReadonlyArray<Pick<ShownStep, "name" | "model" | "thinking">>): RunAgent | null => {
  const agent = steps.find((step) => step.name === "implement")
  return agent === undefined ? null : { model: agent.model, effort: agent.thinking }
}

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
