import { arrow, bullets, card, svg, tall, text, zone, type Drawing, type Part } from "./kit"

const title = "Checks and review: the two gates a code change passes"

const desc =
  "After Pi commits, orc runs the project's checks. When one fails, a fixer repairs it and the checks run again, and after three fixes with a check still red the run fails and no pull request opens. Once the checks are green, no-mistakes reviews the branch. Orc has it fix a finding marked auto-fix, ignores no-op, and treats ask-user as a question that waits at the gate for 30 minutes before the task parks on its branch. Then no-mistakes pushes the branch, opens the pull request and waits for green CI. The project's mode decides which of these a ship task goes through."

const branch: Part = { title: "The branch", text: "Pi's commits, in the run's copy of the project.", href: "run" }
const gate: Part = { title: "The checks", text: "The commands the project names in `.no-mistakes.yaml`.", cls: "card-work" }
const fixer: Part = { title: "A fixer", text: "A second Pi gets the failing output and repairs it. Then the checks run again." }
const failed: Part = { title: "The run fails", text: "A check is still red after 3 fixes. No pull request opens.", mark: "failed" }

const review: Part = { title: "no-mistakes reviews the branch", text: "It gets the task as its intent, and marks each finding.", cls: "card-work" }
const findings: Part = {
  title: "What orc does with a finding",
  ...bullets(["`auto-fix`: asks no-mistakes to fix it", "`no-op`: ignores it", "`ask-user`: a question that waits for an answer"])
}
const question: Part = {
  title: "A question waits at the gate",
  text: "For 30 minutes. An answer in that time carries the run on. With none, the task parks on its branch, and resumes once every question has an answer.",
  cls: "card-ask",
  href: "attention",
  mark: "attention"
}
const deliver: Part = { title: "no-mistakes delivers", text: "It pushes the branch, opens the pull request and waits for green CI." }

const modes: readonly Part[] = [
  { title: "`no-mistakes`", text: "The default. Checks, then the review, then a pull request with green CI." },
  { title: "`direct-PR`", text: "Checks, then orc pushes the branch and opens the pull request itself." },
  { title: "`no-mistakes-prod-only`", text: "`direct-PR` for a task marked internal, `no-mistakes` for the rest." }
]
const pullRequest: Part = { title: "A pull request", text: "Checked and reviewed before it reaches you.", cls: "card-ok", href: "merge", mark: "done" }

const wide = (): Drawing => {
  const body = [
    zone(8, 8, 290, 482, "Gate 1: the project's checks"),
    zone(318, 8, 390, 482, "Gate 2: the review"),
    zone(728, 8, 224, 482, "A ship task, by the project's mode"),
    card(18, 42, 270, 80, branch),
    card(18, 150, 270, 80, gate),
    card(18, 282, 270, 96, fixer),
    card(18, 404, 270, 78, failed),
    arrow([[153, 122], [153, 148]], "work"),
    arrow([[100, 230], [100, 280]], "mute"),
    text(92, 260, "red", "", "end"),
    arrow([[206, 280], [206, 232]], "mute"),
    text(214, 260, "again"),
    arrow([[153, 378], [153, 402]], "mute"),
    card(328, 42, 350, 78, review),
    card(328, 144, 350, 106, findings),
    card(328, 276, 350, 96, question),
    card(328, 398, 350, 80, deliver),
    arrow([[288, 190], [303, 190], [303, 76], [326, 76]], "work"),
    text(298, 140, "green", "", "end"),
    arrow([[503, 120], [503, 142]], "work"),
    arrow([[430, 250], [430, 274]], "ask"),
    arrow([[503, 372], [503, 396]], "work"),
    arrow([[678, 196], [692, 196], [692, 420], [680, 420]], "work"),
    ...modes.map((mode, index) => card(738, 42 + index * 104, 204, 96, mode)),
    card(738, 384, 204, 96, pullRequest),
    arrow([[678, 456], [736, 456]], "work")
  ]
  return svg("checks", 960, 498, title, desc, body)
}

export const checks = (): readonly Drawing[] => [
  wide(),
  tall("checks", title, desc, [
    { label: "Gate 1: the project's checks", rows: [branch, { arrow: "work" }, gate, { arrow: "mute", note: "red" }, fixer, { arrow: "mute", note: "red after 3 fixes" }, failed] },
    { label: "Gate 2: the review", rows: [review, { arrow: "work" }, findings, { arrow: "ask", note: "ask-user" }, question, { arrow: "work" }, deliver, { arrow: "work" }, pullRequest] },
    { label: "A ship task, by the project's mode", rows: modes }
  ])
]
