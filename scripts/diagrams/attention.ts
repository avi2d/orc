import { arrow, bullets, card, svg, tall, text, zone, type Drawing, type Part } from "./kit"

const title = "The attention queue and the decider: who answers what"

const desc =
  "A question from a run and news for you both open an item in the attention queue. A question on a guarded topic goes straight to you. Any other question goes to the decider, a model that answers routine questions from written instructions, or asks you. When it cannot answer, the question goes to you. Your answer replaces the decider's, and the run carries on."

const question: Part = { title: "A question from a run", text: "The worker, fixer, or review can ask. A worker question can block or leave the run working.", href: "checks" }
const news: Part = { title: "News for you", ...bullets(["a run died", "a check went red", "a pull request is ready", "a hold is overdue", "a command keeps failing"]) }
const queue: Part = { title: "The attention queue", text: "Everything that waits on someone, oldest first. `orc attention` lists it.", cls: "card-ask" }
const guarded: Part = {
  title: "Is it on a guarded topic?",
  cls: "card-ask",
  ...bullets(["deleting, or anything that cannot be undone", "security, keys and logins", "merging, pushing, releasing", "spending", "a site's look, and legal text"])
}
const decider: Part = { title: "The decider", text: "A model answers routine questions from written instructions, or asks you.", cls: "card-ask" }
const quote: Part = { title: "Can it answer?", text: "It can quote a rule, the task or the Rules section of its policy, reuse an earlier answer, or ask the worker for more detail.", cls: "card-ask" }
const you: Part = { title: "You answer", text: "In the chat, in the app, or with `orc backlog answer`. Your answer replaces the decider's.", href: "chat" }
const answered: Part = { title: "Answered", text: "The run carries on where it waited." }

const wide = (): Drawing => {
  const body = [
    zone(8, 8, 200, 480, "What opens an item"),
    zone(228, 8, 484, 480, "The machine that plans"),
    zone(732, 8, 220, 480, "You"),
    card(18, 42, 180, 128, question),
    card(18, 212, 180, 172, news),
    card(240, 42, 216, 108, queue),
    card(240, 196, 216, 190, guarded),
    card(486, 42, 216, 124, decider),
    card(486, 226, 216, 126, quote),
    card(742, 42, 200, 84, answered),
    card(742, 226, 200, 140, you),
    arrow([[198, 90], [238, 90]], "ask"),
    arrow([[348, 150], [348, 194]], "ask"),
    arrow([[456, 216], [471, 216], [471, 104], [484, 104]], "ask"),
    text(476, 98, "no", "ask-text", "middle"),
    arrow([[594, 166], [594, 224]], "ask"),
    arrow([[702, 256], [722, 256], [722, 84], [740, 84]], "ask"),
    text(727, 180, "yes", "ask-text"),
    arrow([[702, 306], [740, 306]], "ask"),
    text(721, 324, "no", "ask-text", "middle"),
    arrow([[348, 386], [348, 426], [822, 426], [822, 368]], "ask"),
    text(360, 420, "yes: it goes straight to you", "ask-text"),
    arrow([[108, 384], [108, 458], [876, 458], [876, 368]], "ask"),
    text(120, 452, "it waits for you", "ask-text"),
    arrow([[842, 226], [842, 128]], "ask")
  ]
  return svg("attention", 960, 496, title, desc, body)
}

export const attention = (): readonly Drawing[] => [
  wide(),
  tall("attention", title, desc, [
    { label: "What opens an item", rows: [question, news, { note: "News waits for you. A question takes the path below." }] },
    {
      label: "The machine that plans",
      rows: [queue, { arrow: "ask" }, guarded, { note: "Yes: it goes straight to you." }, { arrow: "ask", note: "no" }, decider, { arrow: "ask" }, quote, { note: "Yes: answered. No: it goes to you." }]
    },
    { label: "You", rows: [you, { arrow: "ask" }, answered] }
  ])
]
