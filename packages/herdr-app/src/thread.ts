import type { AnswerTarget, TaskDetail } from "./task"

export const threadWhos = ["user", "decider", "worker", "beat"] as const
export const threadKinds = ["hold", "question", "decision", "answer", "delivered", "withdrawn", "note"] as const

export interface ThreadLine {
  readonly at: string | null
  readonly who: typeof threadWhos[number]
  readonly kind: typeof threadKinds[number]
  readonly id: string | null
  readonly text: string
}

export interface Thread {
  readonly task: string
  readonly entries: ReadonlyArray<ThreadLine>
}

export interface AskOption {
  readonly letter: string
  readonly text: string
  readonly picture: string | null
}

export interface AskText {
  readonly context: string | null
  readonly question: string
  readonly options: ReadonlyArray<AskOption>
}

export interface ThreadCard {
  readonly key: string
  readonly line: ThreadLine
  readonly what: string
  readonly ask: AskText | null
  readonly answers: ReadonlyArray<ThreadLine>
  readonly delivered: boolean
  readonly notes: ReadonlyArray<ThreadLine>
  readonly reply: AnswerTarget | null
}

const whoLabels: Readonly<Record<ThreadLine["who"], string>> = { user: "Captain", decider: "Decider", worker: "Worker", beat: "Beat" }
const kindLabels: Readonly<Record<ThreadLine["kind"], string>> = {
  hold: "Hold", question: "Question", decision: "Decision", answer: "Answer", delivered: "Delivered", withdrawn: "Withdrawn", note: "Note"
}

export const whoLabel = (line: ThreadLine): string => whoLabels[line.who]

export const lineLabel = (line: ThreadLine): string => kindLabels[line.kind]

export type OptionShape = { readonly kind: "tile"; readonly picture: string } | { readonly kind: "button" }

export const optionShape = (option: AskOption): OptionShape => option.picture === null ? { kind: "button" } : { kind: "tile", picture: option.picture }

const optionLine = /^([A-Z])\) (.*?)(?: \(picture: (.+)\))?$/

// orc_ask folds its context and options into the question's text, and the thread carries only that text.
export const askText = (text: string): AskText => {
  const lines = text.split("\n")
  const options: Array<AskOption> = []
  while (lines.length > 1) {
    const found = optionLine.exec(lines.at(-1) ?? "")
    if (found === null) break
    options.unshift({ letter: found[1] ?? "", text: found[2] ?? "", picture: found[3] ?? null })
    lines.pop()
  }
  const lettered = options.every((option, index) => option.letter === String.fromCharCode(65 + index))
  const body = lettered ? lines : text.split("\n")
  const context = body.findIndex((line) => line.startsWith("Context: "))
  return {
    context: context === -1 ? null : body.slice(context).join("\n").slice("Context: ".length),
    question: (context === -1 ? body : body.slice(0, context)).join("\n"),
    options: lettered ? options : []
  }
}

// A hold question's id carries its hold generation, and a parked question's id is the attention item id task.question.asked.
export const questionIdOf = (id: string): string | null => {
  const held = /^hold-\d+\/(.+)$/.exec(id)
  if (held !== null) return held[1] ?? null
  const parts = id.split(".")
  return parts.length === 3 ? parts[1] ?? null : null
}

const answerable = (line: ThreadLine): boolean => line.who === "user" || line.who === "worker"

export const threadCards = (thread: Thread, task: TaskDetail): ReadonlyArray<ThreadCard> => {
  const open = task.state.status !== "closed"
  const cards: Array<ThreadCard> = []
  const questions = new Map<string, number>()
  let lastHold = -1
  const attach = (index: number, change: (card: ThreadCard) => ThreadCard): void => {
    const card = cards[index]
    if (card !== undefined) cards[index] = change(card)
  }
  for (const [index, line] of thread.entries.entries()) {
    const asked = line.id === null ? undefined : questions.get(line.id)
    if (asked !== undefined && line.kind !== "question") {
      attach(asked, (card) => line.kind === "answer"
        ? { ...card, answers: [...card.answers, line], reply: null }
        : line.kind === "delivered"
        ? { ...card, delivered: true }
        : { ...card, notes: [...card.notes, line], reply: line.kind === "withdrawn" ? null : card.reply })
      continue
    }
    if (line.kind === "answer" && line.id === null && lastHold !== -1) {
      attach(lastHold, (card) => ({ ...card, answers: [...card.answers, line] }))
      continue
    }
    const question = line.kind === "question" && line.id !== null ? questionIdOf(line.id) : null
    const reply = open && question !== null && answerable(line) ? { kind: "question" as const, id: question } : null
    const key = line.kind === "question" && line.id !== null ? `question-${line.id}` : `${line.kind}-${line.at ?? index}`
    const what = question === null ? kindLabels[line.kind] : `${kindLabels[line.kind]} ${question}`
    if (line.kind === "question" && line.id !== null) questions.set(line.id, cards.length)
    if (line.kind === "hold") lastHold = cards.length
    cards.push({ key, line, what, ask: line.kind === "question" ? askText(line.text) : null, answers: [], delivered: false, notes: [], reply })
  }
  const hold = task.hold
  if (open && hold !== null && hold.answer === null && hold.questions.length === 0) attach(lastHold, (card) => ({ ...card, reply: { kind: "hold" } }))
  return cards
}
