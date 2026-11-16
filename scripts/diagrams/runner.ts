import { arrow, bullets, card, svg, tall, zone, type Drawing, type Part } from "./kit"

const title = "The runner: what keeps a run alive on its machine"

const desc =
  "The beat runs the machine's start command and never waits for it. orc runner start reads the task and queues the run in pueue, on this machine or over SSH on another. The pueue group orc gives each running task one slot and starts orc run. A second group, heavy, has one slot, so the test runs and builds of every agent take turns. A later beat reaches the run only through the orc runner commands."

const beat: Part = { title: "The beat", text: "Runs the machine's start command, detached, and never waits for it.", href: "beat" }
const later: Part = { title: "A later beat", text: "Never looks into pueue. It asks the runner.", href: "beat" }
const start: Part = { title: "`orc runner start`", text: "Reads the task from the `ORC_TASK_*` variables and queues the run." }
const far: Part = { title: "Another machine", text: "The task travels as JSON over SSH to `orc runner queue` there. SSH can drop once pueue holds the run." }
const queue: Part = { title: "pueue, group `orc`", text: "One slot per running task, as `dispatch.json` says. A full machine holds the task back.", cls: "card-work" }
const run: Part = { title: "`orc run`", text: "On the host as your user, on the branch `orc/<task-id>`.", href: "run" }
const heavy: Part = { title: "pueue, group `heavy`", text: "One slot. The test runs and builds of every agent take turns, so they cannot overload the machine.", cls: "card-work" }
const commands: Part = {
  title: "The commands a beat reaches a run through",
  ...bullets([
    "`orc runner result`: the state of the run, and its pull request",
    "`orc runner answer`: your answers, for a run that waits at its gate",
    "`orc runner renew`: a fresh token",
    "`orc runner kill`: stops the run, and the next beat closes the task stopped",
    "`orc runner load`: the load a load limit is compared against"
  ])
}

const wide = (): Drawing => {
  const body = [
    zone(8, 8, 200, 480, "The machine that plans"),
    zone(228, 8, 724, 480, "A machine that works"),
    card(18, 42, 180, 120, beat),
    card(18, 340, 180, 140, later),
    card(238, 42, 222, 120, start),
    card(479, 42, 222, 120, queue),
    card(720, 42, 222, 120, run),
    card(238, 196, 222, 124, far),
    card(720, 196, 222, 124, heavy),
    card(238, 340, 704, 140, commands),
    arrow([[198, 90], [236, 90]], "work"),
    arrow([[460, 80], [477, 80]], "work"),
    arrow([[701, 90], [718, 90]], "work"),
    arrow([[349, 162], [349, 194]], "work"),
    arrow([[460, 258], [469, 258], [469, 130], [477, 130]], "work"),
    arrow([[831, 162], [831, 194]], "mute"),
    arrow([[198, 410], [236, 410]], "work", true)
  ]
  return svg("runner", 960, 496, title, desc, body)
}

export const runner = (): readonly Drawing[] => [
  wide(),
  tall("runner", title, desc, [
    { label: "The machine that plans", rows: [beat] },
    { label: "A machine that works", rows: [start, far, { arrow: "work" }, queue, { arrow: "work" }, run, { arrow: "mute", note: "its test runs and builds" }, heavy] },
    { label: "The machine that plans, later", rows: [later, { arrow: "work" }, commands] }
  ])
]
