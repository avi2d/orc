import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { PueueState, queuedTasks } from "../../packages/run/src/shared/process/index"
import { decodeRunsJson, encodeRunsJson, runsJson, withQueued } from "../../packages/run/src/features/seeing-runs/index"

const home = "/home/sam/.orc"
const otherHome = "/home/sam/other-orc"

const pueueTask = (id: number, label: string, status: unknown) => ({
  id,
  created_at: "2026-11-14T09:00:00.000000+00:00",
  original_command: "orc run task.md",
  command: "orc run task.md",
  path: "/home/sam/work/kelp",
  envs: {},
  group: "orc",
  dependencies: [],
  priority: 0,
  label,
  status
})

const statusDocument = {
  tasks: {
    "7": pueueTask(7, home + " kelp-12", { Queued: { enqueued_at: "2026-11-14T09:00:01.000000+00:00" } }),
    "8": pueueTask(8, home + " kelp-11", { Running: { enqueued_at: "2026-11-14T08:00:01.000000+00:00", start: "2026-11-14T08:00:02.000000+00:00" } }),
    "9": pueueTask(9, otherHome + " kelp-13", { Queued: { enqueued_at: "2026-11-14T09:00:03.000000+00:00" } })
  },
  groups: { orc: { status: "Running", parallel_tasks: 1 } }
}

const queuedDocument = () => withQueued(runsJson([]), queuedTasks(Schema.decodeUnknownSync(PueueState)(statusDocument), home))

test("a queued task, a running task and another home's queued task give one queued entry, not the running or foreign one", () => {
  expect(queuedDocument().runs).toEqual([{
    id: null,
    project: "/home/sam/work/kelp",
    branch: "orc/kelp-12",
    status: null,
    state: "queued",
    prLink: null,
    title: null,
    step: null,
    currentStep: null,
    questions: 0,
    endReason: null,
    kind: null,
    delivery: null,
    task: "kelp-12",
    machine: null,
    worktree: null,
    ahead: 1
  }])
})

test("a queued entry survives the JSON another machine reads back instead of failing its decode", async () => {
  const document = queuedDocument()
  const read = await Effect.runPromise(encodeRunsJson(document).pipe(Effect.flatMap((text) => decodeRunsJson(JSON.parse(text)))))
  expect(read).toEqual(document)
})

test("a queued parent task is not listed as a task named with -parent", () => {
  const state = Schema.decodeUnknownSync(PueueState)({ tasks: { "3": pueueTask(3, home + " kelp-12-parent", { Queued: { enqueued_at: "2026-11-14T09:00:01.000000+00:00" } }) } })
  expect(withQueued(runsJson([]), queuedTasks(state, home)).runs).toEqual([])
})

test("a queued task's count ahead leaves out tasks of other pueue groups instead of counting them", () => {
  const queued = { Queued: { enqueued_at: "2026-11-15T09:00:01.000000+00:00" } }
  const running = { Running: { enqueued_at: "2026-11-15T08:00:01.000000+00:00", start: "2026-11-15T08:00:02.000000+00:00" } }
  const state = Schema.decodeUnknownSync(PueueState)({
    tasks: {
      "1": { ...pueueTask(1, "build", running), group: "default" },
      "2": { ...pueueTask(2, "lint", queued), group: "default" },
      "3": pueueTask(3, home + " orc-59", running),
      "4": pueueTask(4, otherHome + " orc-58", queued),
      "5": pueueTask(5, home + " orc-54", queued),
      "6": pueueTask(6, home + " orc-56", queued)
    }
  })
  expect(queuedTasks(state, home).map(({ task, ahead }) => ({ task, ahead }))).toEqual([{ task: "orc-54", ahead: 2 }, { task: "orc-56", ahead: 3 }])
})
