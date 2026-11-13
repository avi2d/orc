import { Schema } from "effect"
import type { ExpectedDecision } from "../../entities/parked-runs/index"

const CardTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("question"), id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("reason") })
])
type CardTarget = typeof CardTarget.Type

const BoardCardRecord = Schema.Struct({
  target: CardTarget,
  text: Schema.String,
  options: Schema.NonEmptyArray(Schema.String),
  recommended: Schema.String
})
export type BoardCardRecord = typeof BoardCardRecord.Type

export const BoardRecord = Schema.Struct({
  task: Schema.String,
  title: Schema.String,
  waits: Schema.Literals(["held", "parked"]),
  reason: Schema.String,
  openedAt: Schema.String,
  board: Schema.String,
  cards: Schema.NonEmptyArray(BoardCardRecord),
  generation: Schema.optional(Schema.Number)
})
export type BoardRecord = typeof BoardRecord.Type

export const BoardAnswer = Schema.Struct({ board: Schema.String, card: Schema.String, answer: Schema.String, words: Schema.optional(Schema.String) })
type BoardAnswer = typeof BoardAnswer.Type

export const answerTag = "orc-board-answer"

export const cardKey = (target: CardTarget): string => target.kind === "question" ? target.id : "reason"

export const answerWords = (answer: BoardAnswer): string =>
  answer.words === undefined || answer.words.trim() === "" ? answer.answer : answer.answer + " — " + answer.words

export const answerArgs = (task: string, target: CardTarget, words: string, expected?: ExpectedDecision): ReadonlyArray<string> => {
  const asked = target.kind === "question" ? target.id + "=" + words : words
  if (expected === undefined) {
    return ["backlog", "answer", task, asked]
  }
  return expected.kind === "parked"
    ? ["backlog", "answer", task, "--expect", "parked", asked]
    : ["backlog", "answer", task, "--expect", "held", "--generation", String(expected.generation), asked]
}

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;")

const lavishRuntime = [
  "<link rel=\"stylesheet\" href=\"https://cdn.jsdelivr.net/npm/daisyui@5.5.19/daisyui.css\">",
  "<link rel=\"stylesheet\" href=\"https://cdn.jsdelivr.net/npm/daisyui@5.5.19/themes.css\">",
  "<script src=\"https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.2.4/dist/index.global.js\"></script>"
].join("\n")

const optionHtml = (card: BoardCardRecord, option: string): string => {
  const recommended = option === card.recommended
  return "<label class=\"flex items-center gap-3 rounded-box border p-3 cursor-pointer " + (recommended ? "border-primary" : "border-base-content/20") + "\">" +
    "<input type=\"radio\" class=\"radio radio-primary\" name=\"answer\" value=\"" + escapeHtml(option) + "\"" + (recommended ? " checked" : "") + ">" +
    "<span class=\"flex-1 min-w-0 break-words\">" + escapeHtml(option) + "</span>" + (recommended ? "<span class=\"badge badge-primary\">Recommended</span>" : "") + "</label>"
}

const formHtml = (card: BoardCardRecord, key: string, board: string): string =>
  "<form data-card=\"" + key + "\" data-board=\"" + board + "\" data-lavish-question=\"" + key + "\" class=\"grid gap-2\">" + card.options.map((option) => optionHtml(card, option)).join("") +
  "<label class=\"fieldset\"><span class=\"fieldset-legend\">Words to add (optional)</span><textarea class=\"textarea w-full\" name=\"words\" rows=\"2\"></textarea></label>" +
  "<div class=\"card-actions\"><button type=\"submit\" class=\"btn btn-primary\">Record this answer</button></div></form>"

const cardHtml = (card: BoardCardRecord, answered: string | null, board: string): string => {
  const key = escapeHtml(cardKey(card.target))
  const body = answered === null
    ? formHtml(card, key, board)
    : "<p class=\"break-words\">Recorded: <strong>" + escapeHtml(answered) + "</strong></p>"
  const mark = answered === null ? "" : "<span class=\"badge badge-success badge-soft\">Recorded</span>"
  return "<section class=\"card card-border bg-base-100\"><div class=\"card-body gap-3\">" +
    "<header class=\"grid gap-1\"><span class=\"flex items-center gap-2 font-mono text-xs\"><span class=\"opacity-70\">" + key + "</span>" + mark + "</span>" +
    "<h2 class=\"card-title break-words\">" + escapeHtml(card.text) + "</h2></header>" +
    body + "</div></section>"
}

const script = [
  "document.querySelectorAll('form[data-card]').forEach((form) => form.addEventListener('submit', (event) => {",
  "  event.preventDefault()",
  "  const values = new FormData(form)",
  "  const answer = values.get('answer')",
  "  if (typeof answer !== 'string') return",
  "  const words = String(values.get('words') ?? '')",
  "  const question = form.closest('section').querySelector('h2').textContent",
  "  const said = words.trim() === '' ? answer : answer + ' — ' + words",
  "  window.lavish.queuePrompt(question + ': ' + said, { tag: '" + answerTag + "', text: question + ': ' + said, element: form, data: { board: form.dataset.board, card: form.dataset.card, answer, words } })",
  "  window.lavish.sendQueuedPrompts()",
  "  const button = form.querySelector('button')",
  "  button.disabled = true",
  "  button.textContent = 'Sent, recording'",
  "}))"
].join("\n")

export const boardHtml = (record: BoardRecord, answered: (card: BoardCardRecord) => string | null): string => {
  const open = record.cards.filter((card) => answered(card) === null).length
  return [
    "<!doctype html>",
    "<html lang=\"en\" data-theme=\"luxury\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<title>" + escapeHtml(record.task + " decision board") + "</title>",
    lavishRuntime,
    "</head>",
    "<body class=\"min-h-screen bg-base-200 text-base-content\"><main class=\"mx-auto grid max-w-3xl gap-4 px-5 py-8\">",
    "<h1 class=\"text-2xl font-bold break-words\">" + escapeHtml(record.task + " " + record.title) + "</h1>",
    "<p class=\"opacity-80 break-words\">" + escapeHtml(record.reason) + "</p>",
    "<p role=\"status\" class=\"alert " + (open === 0 ? "alert-success" : "alert-info") + " alert-soft\">" +
      (open === 0 ? "Every card is answered." : open + " of " + record.cards.length + " cards wait for your answer. The task stays " + record.waits + " until every card is answered.") + "</p>",
    ...record.cards.map((card) => cardHtml(card, answered(card), escapeHtml(record.board))),
    "</main><script>" + script + "</script></body></html>",
    ""
  ].join("\n")
}
