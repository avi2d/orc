import { arrow, card, svg, tall, text, zone, type Drawing, type Part } from "./kit"

const title = "The merge: what orc merge checks before it lands a pull request"

const desc =
  "You, the chat and the app all merge through orc merge. It merges only when the task names a pull request, the pull request is open, and every check has reported green. Otherwise it refuses, names every reason, and merges nothing. A branch behind its base updates first. It squash merges at the exact commit it checked. A merge always traces back to your word, and the decider never answers a question about merging."

const askers: readonly Part[] = [
  { title: "You", text: "`orc merge <task-id>`" },
  { title: "The chat", text: "Its `merge_task` tool.", href: "chat" },
  { title: "The app", text: "Its Approve step.", href: "app" }
]

const conditions: readonly Part[] = [
  { title: "A pull request", text: "The task names one." },
  { title: "Open", text: "It is not closed, and not merged yet." },
  { title: "Green", text: "Every check has reported, and none is red." }
]

const merged: Part = { title: "Squash merge", text: "At the checked commit, updating a branch behind its base first.", cls: "card-ok" }
const refused: Part = { title: "Refused: nothing merges", text: "The refusal names every reason." }

const word: readonly Part[] = [
  { title: "Your word", text: "The default basis. You said to merge that pull request." },
  { title: "`yolo-green`", text: "The project has `\"yolo\": true`, and you ask the chat to merge its green pull request." },
  { title: "Never the decider", text: "It answers no question about merging, so a merge always traces back to you.", href: "attention" },
  { title: "After the merge", text: "A later beat records it, the chat posts it, and a ship task that waited on it can start.", href: "beat" }
]

const wide = (): Drawing => {
  const body = [
    zone(8, 8, 190, 292, "Who asks"),
    zone(218, 8, 734, 292, "`orc merge` lands it once all three hold"),
    zone(8, 314, 944, 174, "Whose word merges"),
    ...askers.map((asker, index) => card(18, 42 + index * 84, 170, 76, asker)),
    arrow([[188, 80], [226, 80]], "work"),
    ...conditions.map((condition, index) => card(228 + index * 148, 42, 132, 130, condition)),
    ...conditions.map((_, index) => arrow([[360 + index * 148, 96], [374 + index * 148, 96]], "work")),
    card(820, 42, 122, 130, merged),
    card(228, 218, 576, 66, refused),
    ...conditions.flatMap((_, index) => [arrow([[294 + index * 148, 172], [294 + index * 148, 216]], "aside"), text(302 + index * 148, 198, "no")]),
    ...word.map((item, index) => card(18 + index * 234, 348, 222, 130, item))
  ]
  return svg("merge", 960, 496, title, desc, body)
}

export const merge = (): readonly Drawing[] => [
  wide(),
  tall("merge", title, desc, [
    { label: "Who asks", rows: askers },
    { label: "`orc merge` lands it once all three hold", rows: [...conditions, { arrow: "work", note: "all three hold" }, merged, { note: "If one does not hold:" }, refused] },
    { label: "Whose word merges", rows: word }
  ])
]
