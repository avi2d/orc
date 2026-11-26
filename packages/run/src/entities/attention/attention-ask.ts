import type { ParkedQuestion, TaskRecord } from "../backlog/index"
import type { Asked, AttentionOption } from "./attention-item"

// The same parts always name one file, so routing an item again opens nothing new.
export const itemId = (...parts: ReadonlyArray<string>): string => parts.map((part) => part.replace(/[^A-Za-z0-9_-]/g, "_")).join(".")

export type Choice = Pick<Asked, "subject" | "options" | "recommendation">

// The recommended option comes first, so an item cannot recommend an option it does not list.
export const choice = (subject: string, recommended: AttentionOption, ...others: ReadonlyArray<AttentionOption>): Choice =>
  ({ subject, options: [recommended, ...others], recommendation: recommended.text })

// A closed item cannot ask again, so a blocking question whose item closed before the task file took its answer gets one item that names it.
export const unaskedQuestion = (task: TaskRecord, unasked: ReadonlyArray<ParkedQuestion>, at: string): { readonly id: string; readonly asked: Asked } | null => {
  const first = unasked.at(0)
  if (first === undefined) {
    return null
  }
  const id = task.spec.id
  const since = unasked.reduce((earliest, question) => question.asked < earliest ? question.asked : earliest, first.asked)
  const named = unasked.map((question) => question.id)
  const text = id + " is parked for the captain's answer to " + named.join(", ") + ", and no open item asks it, so the task does not resume until each has an answer: " +
    unasked.map((question) => question.id + ": " + question.text).join(" ")
  return {
    id: itemId(id, "unasked-question", since),
    asked: {
      kind: "unasked-question",
      task: id,
      text,
      ...choice(
        "the unasked questions of " + id + ": " + named.join(", "),
        { text: "answer", outcome: "orc backlog answer " + id + " <question-id>=<text> answers one, and the next beat resumes the task once every blocking question has an answer" },
        { text: "drop", outcome: "orc backlog drop " + id + " <reason> drops the task, and it never starts" }
      ),
      asked: at,
      owner: "user"
    }
  }
}

export const writtenAnswerChoice = (task: string, question: string, subject: string, reason: string): Choice => choice(
  subject,
  { text: "Write an answer", action: "write-answer", outcome: "Send an answer with orc backlog answer " + task + " " + question + "=<words> so the run can use it." + reason },
  { text: "Leave open", action: "wait", outcome: "No answer is sent. The run keeps waiting for a decision on this question." }
)
