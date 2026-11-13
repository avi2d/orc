import type { Backlog, Run, Runs, Step, Task } from "./guard"

export const cardStatuses = ["Awaiting you", "Running", "Queued", "Failed", "Done"] as const
export type CardStatus = typeof cardStatuses[number]

export type Standing =
  | { readonly status: "Awaiting you"; readonly waiting: { readonly on: "answer" } | { readonly on: "approval"; readonly pr: string } }
  | { readonly status: Exclude<CardStatus, "Awaiting you"> }

export interface Card {
  readonly key: string
  readonly id: string
  readonly type: string
  readonly title: string
  readonly project: string
  readonly standing: Standing
  readonly where: string
  readonly runId: string | null
}

export interface Filter {
  readonly project: string | null
  readonly status: CardStatus | null
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

export const stepLabel = (step: Pick<Step, "name" | "attempt">): string => {
  switch (step.name) {
    case "implement":
      return "Agent"
    case "checks":
      return `Checks ${step.attempt}`
    case "fix":
      return `Fix ${step.attempt}`
    case "pr":
      return "PR"
    default:
      return step.name
  }
}

const taskBranches = (task: Task): ReadonlyArray<string> => [`orc/${task.id}`, `orc/${task.id}-parent`]

const openQuestions = (task: Task): number => task.status === "closed" ? 0 : (task.parked ?? 0) + (task.hold ?? 0)

const queuedWhere = (task: Task): string => task.hold === null ? "Waiting to start" : "Held"

const awaitingAnswer = (count: number): { readonly standing: Standing; readonly where: string } =>
  ({ standing: { status: "Awaiting you", waiting: { on: "answer" } }, where: questionsLabel(count) })

const runPlace = (run: Run, task: Task | undefined, merged: ReadonlySet<string>): { readonly standing: Standing; readonly where: string } => {
  const questions = run.status === "running" ? run.questions : task === undefined ? 0 : openQuestions(task)
  if (questions > 0) {
    return awaitingAnswer(questions)
  }
  if (run.status === "running") {
    return { standing: { status: "Running" }, where: run.step === null ? "Starting" : stepLabel(run.step) }
  }
  if (task !== undefined && task.status !== "closed") {
    return { standing: { status: "Queued" }, where: queuedWhere(task) }
  }
  if (run.status === "succeeded") {
    if (run.prLink === null) {
      return { standing: { status: "Done" }, where: "Done" }
    }
    const pr = prNumber(run.prLink)
    if (task !== undefined && !merged.has(task.id)) {
      return { standing: { status: "Awaiting you", waiting: { on: "approval", pr } }, where: `Approve ${pr}` }
    }
    return { standing: { status: "Done" }, where: task === undefined ? pr : `Merged ${pr}` }
  }
  return { standing: { status: "Failed" }, where: firstLine(run.endReason ?? task?.reason ?? run.status) }
}

export const buildCards = (runs: Runs, backlog: Backlog): ReadonlyArray<Card> => {
  const byBranch = new Map(backlog.tasks.flatMap((task) => taskBranches(task).map((branch) => [branch, task] as const)))
  const merged = new Set(backlog.events.filter((key) => key.endsWith(".merged")).map((key) => key.slice(0, -".merged".length)))
  const shown = new Set<string>()
  const cards: Array<Card> = []
  const newestFirst = [...runs.runs].sort((a, b) => b.id.localeCompare(a.id))
  for (const run of newestFirst) {
    const task = byBranch.get(run.branch)
    if (task !== undefined && shown.has(task.id)) {
      continue
    }
    if (task !== undefined) {
      shown.add(task.id)
    }
    const place = runPlace(run, task, merged)
    cards.push({
      key: run.id,
      id: task?.id ?? run.id,
      type: task?.kind ?? "run",
      title: run.title ?? task?.title ?? run.branch,
      project: task?.project ?? lastSegment(run.project),
      ...place,
      runId: place.standing.status === "Queued" ? null : run.id
    })
  }
  for (const task of backlog.tasks) {
    if (shown.has(task.id) || task.status === "closed") {
      continue
    }
    const questions = openQuestions(task)
    const place = questions > 0 ? awaitingAnswer(questions) : { standing: { status: "Queued" } as const, where: queuedWhere(task) }
    cards.push({ key: task.id, id: task.id, type: task.kind, title: task.title, project: task.project, ...place, runId: null })
  }
  return sortCards(cards)
}

export const sortCards = (cards: ReadonlyArray<Card>): ReadonlyArray<Card> =>
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
      return standing.status === "Awaiting you" && standing.waiting.on === "answer" ? "◆" : "●"
  }
}

const delivers = (step: Step): boolean => step.name === "pr" || step.name === "no-mistakes"

const stepsToCome = (steps: ReadonlyArray<Step>): ReadonlyArray<string> => {
  const last = steps.at(-1)
  const rounds = steps.filter((step) => step.name === "checks").length
  const fixes = steps.filter((step) => step.name === "fix").length
  if (last === undefined) {
    return ["Agent", "Checks 1", "PR"]
  }
  if (steps.some(delivers)) {
    return []
  }
  if (last.name === "checks") {
    return last.status === "failed" ? [`Fix ${fixes + 1}`, `Checks ${rounds + 1}`, "PR"] : ["PR"]
  }
  return [`Checks ${rounds + 1}`, "PR"]
}

const goesOn = (standing: Standing): boolean =>
  standing.status === "Running" || standing.status === "Queued" || (standing.status === "Awaiting you" && standing.waiting.on === "answer")

export const stepRows = (standing: Standing, steps: ReadonlyArray<Step>): ReadonlyArray<StepRow> => {
  const recorded = steps.map((step): StepRow => ({ key: `step-${step.id}`, label: stepLabel(step), mark: recordedMark(step, standing), stepId: step.id }))
  const toCome = goesOn(standing)
    ? stepsToCome(steps).map((label): StepRow => ({ key: `next-${label}`, label, mark: "○", stepId: null }))
    : []
  const approval = standing.status === "Awaiting you" && standing.waiting.on === "approval"
    ? [{ key: "approve", label: `Approve ${standing.waiting.pr}`, mark: "◆" as const, stepId: null }]
    : []
  return [...recorded, ...toCome, ...approval]
}
