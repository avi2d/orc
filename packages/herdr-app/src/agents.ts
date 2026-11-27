import type { Backlog, Run, Runs, ShownStep, Step, Task } from "./guard"
import { type InboxAnswer, type InboxApproval, type InboxItem, waitsOnLabel } from "./inbox"
import { sentBackLabel } from "./approval-stage"

export const cardStatuses = ["Awaiting you", "Running", "Queued", "Failed", "Done"] as const
export type CardStatus = typeof cardStatuses[number]

export const railLabel = (card: Pick<Card, "id" | "runId">): string => {
  const id = card.runId ?? card.id
  return id.length > 10 ? id.slice(-6) : id
}

export type Standing =
  | { readonly status: "Awaiting you"; readonly waiting: { readonly on: "answer"; readonly items: ReadonlyArray<InboxAnswer> } | { readonly on: "approval"; readonly item: InboxApproval } }
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
  readonly openPr: string | null
  readonly merge?: Task["merge"]
}

export interface Checkout {
  readonly worktree: string
  readonly branch: string
}

export interface Filter {
  readonly project: string | null
  readonly allRuns: boolean
}

export type StepTab =
  | { readonly kind: "step"; readonly id: number; readonly label: string; readonly from: string | null; readonly status: Step["status"] }
  | { readonly kind: "next"; readonly label: string }

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
    case "event": return "Event"
  }
}

const stepLabel = (step: Pick<Step, "name">, place: number): string => {
  switch (step.name) {
    case "implement":
      return "Agent"
    case "checks":
      return `Checks ${place}`
    case "fix":
      return `Fix ${place}`
    case "pr":
      return "PR"
    case "no-mistakes":
      return "No mistakes"
    default:
      return step.name
  }
}

const taskBranches = (task: Task): ReadonlyArray<string> => [`orc/${task.id}`, `orc/${task.id}-parent`]

const queuedWhere = (task: Task, awaited: ReadonlyArray<string> | undefined): string => {
  if (awaited !== undefined) return waitsOnLabel(awaited)
  return task.hold === null ? "Waiting to start" : "Held"
}

type Place = Pick<Card, "standing" | "where"> & { readonly openPr?: string }

const awaitingAnswer = (items: ReadonlyArray<InboxAnswer>): Place | null => {
  const first = items.at(0)
  return first === undefined ? null : {
    standing: { status: "Awaiting you", waiting: { on: "answer", items } },
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
  if (task.retriedRun === runId) {
    return { standing: { status: "Done" }, where: `Retried ${pr}` }
  }
  if (task.status !== "closed" && task.parkedOrigin === runId) {
    return { standing: { status: "Done" }, where: sentBackLabel(pr, task.merge) }
  }
  if (!newest) {
    return { standing: { status: "Done" }, where: `Sent back ${pr}` }
  }
  if (merged.has(task.id)) {
    return { standing: { status: "Done" }, where: `Merged ${pr}` }
  }
  return { ...(approval?.link === link ? awaitingApproval(approval) : { standing: { status: "Done" }, where: pr }), openPr: link }
}

const settledPlace = (run: Run, task: Task | undefined, newest: boolean): Pick<Card, "standing" | "where"> | null => {
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

const sendBackOf = (task: Task | undefined, place: Place): string | null =>
  task?.status === "closed" && place.openPr !== undefined ? task.id : null

const runningPlace = (run: Run): Place =>
  ({ standing: { status: "Running" }, where: run.step === null ? "Starting" : runningStepLabel(run.step) })

// The runs list carries only the running step, so its place among the run's steps is unknown and a numbered step is named without its number.
const runningStepLabel = (step: Pick<Step, "name">): string => stepLabel(step, 0).replace(/ 0$/, "")

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

const runCard = (run: Run, task: Task | undefined, place: Place, project: string, known: boolean): Card => ({
  key: run.id,
  id: task?.id ?? run.id,
  kind: run.kind ?? task?.kind ?? null,
  delivery: run.delivery,
  title: run.title ?? task?.title ?? run.branch,
  project,
  known,
  standing: place.standing,
  where: place.where,
  runId: run.id,
  checkout: run.worktree === null ? null : { worktree: run.worktree, branch: run.branch },
  sendBack: sendBackOf(task, place),
  openPr: place.openPr ?? null,
  ...(task?.merge === undefined ? {} : { merge: task.merge })
})

const taskCard = (task: Task, active: ReadonlySet<string>, pending: ReadonlyArray<InboxAnswer>, holdsOnTasks: ReadonlyMap<string, ReadonlyArray<string>>): ReadonlyArray<Card> => {
  const waiting = awaitingAnswer(pending)
  if (waiting === null && (active.has(task.id) || task.status === "closed")) return []
  const place = waiting ?? { standing: { status: "Queued" } as const, where: queuedWhere(task, holdsOnTasks.get(task.id)) }
  return [{ key: task.id, id: task.id, kind: task.kind, delivery: null, title: task.title, project: task.project, known: true, ...place, runId: null, checkout: null, sendBack: null, openPr: null }]
}

interface CardsInput {
  readonly byBranch: ReadonlyMap<string, Task>
  readonly merged: ReadonlySet<string>
  readonly newest: ReadonlySet<string>
  readonly waitingRuns: ReadonlyMap<string, string>
  readonly answers: ReadonlyMap<string, ReadonlyArray<InboxAnswer>>
  readonly approvals: ReadonlyMap<string, InboxApproval>
  readonly checkoutProject: ReadonlyMap<string, string>
  readonly known: (project: string) => boolean
  readonly holdsOnTasks: ReadonlyMap<string, ReadonlyArray<string>>
}

const projectFor = (task: Task | undefined, run: Run, checkoutProject: ReadonlyMap<string, string>): string =>
  task?.project ?? checkoutProject.get(run.project) ?? lastSegment(run.project)

const markActive = (active: Set<string>, task: Task | undefined, place: Place): void => {
  if (task !== undefined && (place.standing.status === "Running" || place.standing.status === "Awaiting you")) {
    active.add(task.id)
  }
}

const workerAnswers = (run: Run, id: string, input: CardsInput): ReadonlyArray<InboxAnswer> =>
  input.waitingRuns.get(id) === run.id ? (input.answers.get(id) ?? []).filter((item) => item.who === "worker") : []

const placeFor = (run: Run, task: Task | undefined, id: string, input: CardsInput): Place =>
  settledPlace(run, task, input.newest.has(run.id))
    ?? (run.status === "running"
      ? awaitingAnswer(workerAnswers(run, id, input)) ?? runningPlace(run)
      : finishedPlace(run, task, input.merged, input.newest.has(run.id), input.approvals.get(id)))

const pendingFor = (task: Task, input: CardsInput): ReadonlyArray<InboxAnswer> =>
  (input.answers.get(task.id) ?? []).filter((item) => item.who !== "worker" || !input.waitingRuns.has(task.id))

const remainingCards = (backlog: Backlog, active: ReadonlySet<string>, approvalsShown: ReadonlySet<string>, input: CardsInput): ReadonlyArray<Card> =>
  backlog.tasks.flatMap((task) => {
    const known = input.known(task.project)
    const queued = taskCard(task, active, pendingFor(task, input), input.holdsOnTasks).map((card) => ({ ...card, known }))
    const approval = input.approvals.get(task.id)
    if (approval === undefined || approvalsShown.has(task.id) || task.prState === "closed" || task.prState === "merged" || input.merged.has(task.id)) return queued
    return [...queued, {
      key: approval.key, id: task.id, kind: task.kind, delivery: null, title: task.title, project: task.project, known,
      ...awaitingApproval(approval), runId: null, checkout: null, sendBack: task.status === "closed" ? task.id : null, openPr: approval.link,
      ...(task.merge === undefined ? {} : { merge: task.merge })
    }]
  })

export const buildCards = (runs: Runs, backlog: Backlog, items: ReadonlyArray<InboxItem> = [], holdsOnTasks: ReadonlyMap<string, ReadonlyArray<string>> = new Map()): ReadonlyArray<Card> => {
  const byBranch = new Map(backlog.tasks.flatMap((task) => taskBranches(task).map((branch) => [branch, task] as const)))
  const input: CardsInput = {
    byBranch,
    merged: new Set(backlog.merged),
    newest: newestRun(runs),
    waitingRuns: waitingRunByTask(runs, byBranch),
    answers: answersByTask(items),
    approvals: new Map(items.filter((item) => item.kind === "pr").map((item) => [item.task, item])),
    checkoutProject: new Map((backlog.projects ?? []).flatMap((project) => project.paths.map((path) => [path, project.name] as const))),
    known: (project: string): boolean => backlog.projects === null || backlog.projects.some((configured) => configured.name === project),
    holdsOnTasks
  }
  const active = new Set<string>()
  const approvalsShown = new Set<string>()
  const cards: Array<Card> = []
  for (const run of runs.runs) {
    const task = input.byBranch.get(run.branch)
    const place = placeFor(run, task, task?.id ?? run.id, input)
    markActive(active, task, place)
    if (task !== undefined && place.standing.status === "Awaiting you" && place.standing.waiting.on === "approval") approvalsShown.add(task.id)
    const project = projectFor(task, run, input.checkoutProject)
    cards.push(runCard(run, task, place, project, input.known(project)))
  }
  return sortCards([...cards, ...remainingCards(backlog, active, approvalsShown, input)])
}

export const cardAnswers = (card: Pick<Card, "standing"> | null): ReadonlyArray<InboxAnswer> =>
  card?.standing.status === "Awaiting you" && card.standing.waiting.on === "answer" ? card.standing.waiting.items : []

export const approvalOf = (card: Pick<Card, "standing"> | null): InboxApproval | null =>
  card?.standing.status === "Awaiting you" && card.standing.waiting.on === "approval" ? card.standing.waiting.item : null

export type LastTab = "Approve" | "Send back"

export const lastTab = (card: Pick<Card, "standing" | "openPr" | "sendBack">): LastTab | null => {
  if (approvalOf(card) !== null) return "Approve"
  return card.openPr !== null && card.sendBack !== null ? "Send back" : null
}

export const sendBackArgs = (card: Pick<Card, "sendBack">, words: string): ReadonlyArray<string> | null =>
  card.sendBack === null || words.trim() === "" ? null : ["backlog", "send-back", card.sendBack, words.trim()]

const sortCards = (cards: ReadonlyArray<Card>): ReadonlyArray<Card> =>
  cardStatuses.flatMap((status) => cards.filter((card) => card.standing.status === status))

const findsCard = (card: Pick<Card, "id" | "title">, find: string): boolean => {
  const words = find.trim().toLowerCase()
  return words === "" || card.id.toLowerCase().includes(words) || card.title.toLowerCase().includes(words)
}

export const filterCards = (cards: ReadonlyArray<Card>, filter: Filter, find = ""): ReadonlyArray<Card> =>
  cards.filter((card) =>
    (filter.project === null ? filter.allRuns || card.known : card.project === filter.project) && findsCard(card, find))

export const openedFilter = (cards: ReadonlyArray<Card>, key: string): Filter =>
  ({ project: null, allRuns: cards.some((card) => card.key === key && !card.known) })

export const projectsOf = (cards: ReadonlyArray<Card>): ReadonlyArray<string> =>
  [...new Set(cards.flatMap((card) => card.known ? [card.project] : []))].sort((a, b) => a.localeCompare(b))

export const recordedStatus = (status: Step["status"], standing: Standing["status"]): Step["status"] =>
  status === "running" && (standing === "Failed" || standing === "Done") ? "failed" : status

const delivers = (step: Step): boolean => step.name === "pr" || step.name === "no-mistakes"

const countOf = (steps: ReadonlyArray<Step>, name: string): number => steps.filter((step) => step.name === name).length

const stepsToCome = (steps: ReadonlyArray<Step>, kind: string | null, delivery: string | null): ReadonlyArray<string> => {
  if (kind !== null && kind !== "ship") {
    return steps.length === 0 ? ["Agent"] : []
  }
  const last = steps.at(-1)
  const rounds = countOf(steps, "checks")
  const fixes = countOf(steps, "fix")
  const finalStep = delivery === "direct-PR" || delivery === "orc" ? "PR" : "No mistakes"
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

export const stepTabs = (standing: Standing, steps: ReadonlyArray<ListedStep>, kind: string | null = null, delivery: string | null = null): ReadonlyArray<StepTab> => {
  const ordered = [...steps.filter((step) => step.from !== null), ...steps.filter((step) => step.from === null)]
  const recorded = ordered.map((step, index): StepTab => ({
    kind: "step",
    id: step.id,
    label: stepLabel(step, countOf(ordered.slice(0, index + 1), step.name)),
    from: step.from,
    status: recordedStatus(step.status, standing.status)
  }))
  const toCome = goesOn(standing) ? stepsToCome(ordered, kind, delivery).map((label): StepTab => ({ kind: "next", label })) : []
  return [...recorded, ...toCome]
}
