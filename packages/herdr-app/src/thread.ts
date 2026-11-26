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
  readonly outcome?: string
  readonly action?: "write-answer" | "wait"
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

export const whoLabel = (line: Pick<ThreadLine, "who">): string => whoLabels[line.who]

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
    const [, letter, option] = found
    // RegExpExecArray types every group as string, yet the unmatched optional picture group is undefined, which only at() admits.
    options.unshift({ letter, text: option, picture: found.at(3) ?? null })
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
const questionIdOf = (id: string): string | null => {
  const held = /^hold-\d+\/(.+)$/.exec(id)?.[1]
  if (held !== undefined) return held
  const parts = id.split(".")
  return parts.length === 3 ? parts[1] ?? null : null
}

const answerable = (line: ThreadLine): boolean => line.who === "user" || line.who === "worker"

const follow = (card: ThreadCard, line: ThreadLine): ThreadCard => {
  if (line.kind === "answer") return { ...card, answers: [...card.answers, line], reply: null }
  if (line.kind === "delivered") return { ...card, delivered: true }
  return { ...card, notes: [...card.notes, line], reply: line.kind === "withdrawn" ? null : card.reply }
}

const followedCard = (line: ThreadLine, questions: ReadonlyMap<string, number>, lastHold: number): number | undefined => {
  if (line.kind === "question") return undefined
  if (line.id !== null) return questions.get(line.id)
  return line.kind === "answer" && lastHold !== -1 ? lastHold : undefined
}

const startCard = (line: ThreadLine, index: number, open: boolean): ThreadCard => {
  const asked = line.kind === "question" ? line.id : null
  const question = asked === null ? null : questionIdOf(asked)
  const reply = open && question !== null && answerable(line) ? { kind: "question" as const, id: question } : null
  const key = asked === null ? `${line.kind}-${line.at ?? index}` : `question-${asked}`
  const what = question === null ? kindLabels[line.kind] : `${kindLabels[line.kind]} ${question}`
  return { key, line, what, ask: line.kind === "question" ? askText(line.text) : null, answers: [], delivered: false, notes: [], reply }
}

export const threadCards = (thread: Thread, task: TaskDetail): ReadonlyArray<ThreadCard> => {
  const open = task.state.status !== "closed"
  const cards: Array<ThreadCard> = []
  const questions = new Map<string, number>()
  let lastHold = -1
  for (const [index, line] of thread.entries.entries()) {
    const followed = followedCard(line, questions, lastHold)
    if (followed !== undefined) {
      cards[followed] = follow(cards[followed], line)
    } else {
      if (line.kind === "question" && line.id !== null) questions.set(line.id, cards.length)
      if (line.kind === "hold") lastHold = cards.length
      cards.push(startCard(line, index, open))
    }
  }
  const hold = task.hold
  if (open && lastHold !== -1 && hold !== null && hold.answer === null && hold.questions.length === 0) cards[lastHold] = { ...cards[lastHold], reply: { kind: "hold" } }
  return cards
}
