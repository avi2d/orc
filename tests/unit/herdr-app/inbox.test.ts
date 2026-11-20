import { expect, test } from "bun:test"
import { type AskingRun, type AttentionItem, askingRuns, attention, guardJson } from "../../../packages/herdr-app/src/guard"
import { type InboxSources, inboxItems, inboxTasks } from "../../../packages/herdr-app/src/inbox"
import type { TaskDetail } from "../../../packages/herdr-app/src/task"
import type { Thread, ThreadLine } from "../../../packages/herdr-app/src/thread"

const started: TaskDetail = {
  id: "orc-60",
  title: "Pick a layout",
  kind: "ship",
  body: "",
  created: "2026-11-13T10:00:00.000Z",
  priority: null,
  dependsOn: [],
  prState: null,
  hold: null,
  parked: null,
  state: { status: "started", account: "main", started: "2026-11-13T10:05:00.000Z" }
}

const askId = "orc-60.ask-1.2026-11-13T11_00_00_000Z"

const line = (kind: ThreadLine["kind"], who: ThreadLine["who"], id: string | null, text: string, at: string | null = "2026-11-13T11:00:00.000Z"): ThreadLine =>
  ({ at, who, kind, id, text })

const ask = line("question", "worker", askId, "Which layout?\nA) Wide\nB) Narrow")

const remoteRun: AskingRun = { branch: "orc/orc-60", task: "orc-60", questions: 1 }

const sources = (entries: ReadonlyArray<ThreadLine>, more: Partial<InboxSources> = {}): InboxSources => ({
  backlog: [started],
  attention: [],
  runs: [remoteRun],
  threads: new Map<string, Thread>([["orc-60", { task: "orc-60", entries }]]),
  ...more
})

test("lists a question on a run kept on another machine instead of missing it from the Inbox", () => {
  const document = JSON.stringify({ schema: "orc.runs.v1", runs: [{ id: "r1", branch: "orc/orc-60", task: "orc-60", machine: "mac", questions: 1 }], machines: [] })
  const runs = guardJson(document, askingRuns)
  expect(runs).toEqual({ kind: "ok", value: [remoteRun] })
  const [item] = inboxItems(sources([ask]))
  expect(item).toMatchObject({ kind: "question", task: "orc-60", title: "Pick a layout", who: "worker", recommendation: null, action: { kind: "answer", target: { kind: "question", id: "ask-1" } } })
  expect(item.ask.options.map((option) => option.text)).toEqual(["Wide", "Narrow"])
})

test("drops an answered question instead of still listing it", () => {
  expect(inboxItems(sources([ask, line("answer", "user", askId, "Wide", "2026-11-13T11:02:00.000Z")]))).toEqual([])
})

test("drops a withdrawn question instead of still listing it", () => {
  expect(inboxItems(sources([ask, line("withdrawn", "beat", askId, "the run ended", "2026-11-13T11:02:00.000Z")]))).toEqual([])
})

test("lists an escalated question as a decision instead of a plain question", () => {
  const document = JSON.stringify({ schema: "orc.attention.v1", at: "2026-11-13T12:00:00.000Z", items: [{ id: askId, kind: "worker-question", task: "orc-60", text: "Which layout?", asked: "2026-11-13T11:00:00.000Z", owner: "user", decision: { kind: "escalated", reason: "taste", at: "2026-11-13T11:01:00.000Z" }, ageSeconds: 60, overdue: false }] })
  const items = guardJson(document, attention)
  if (items.kind !== "ok") throw new Error(items.reason)
  expect(inboxItems(sources([ask], { attention: items.value, runs: [] })).map((item) => item.kind)).toEqual(["decision"])
})

test("carries the decider's recommended option into an escalated decision instead of dropping it", () => {
  const document = JSON.stringify({ schema: "orc.attention.v1", at: "2026-11-13T12:00:00.000Z", items: [{ id: askId, kind: "worker-question", task: "orc-60", text: "Which layout?", asked: "2026-11-13T11:00:00.000Z", owner: "user", decision: { kind: "escalated", reason: "taste", recommendation: "Narrow", at: "2026-11-13T11:01:00.000Z" }, ageSeconds: 60, overdue: false }] })
  const items = guardJson(document, attention)
  if (items.kind !== "ok") throw new Error(items.reason)
  const [item] = inboxItems(sources([ask], { attention: items.value, runs: [] }))
  expect(item).toMatchObject({ kind: "decision", recommendation: "Narrow" })
  expect(item.ask.options.filter((option) => option.text === item.recommendation).map((option) => option.letter)).toEqual(["B"])
})

const delivered = (pr: TaskDetail["prState"]): TaskDetail => ({
  ...started,
  id: "orc-61",
  prState: pr,
  state: { status: "closed", account: "main", started: null, outcome: "done", pr: "https://github.com/o/r/pull/9", report: null, closedAt: "2026-11-13T12:00:00.000Z" }
})

test("drops a merged PR instead of still asking to merge it", () => {
  const ready: AttentionItem = { id: "orc-61.pr-ready", kind: "pr-ready", task: "orc-61", escalated: false, recommendation: null }
  const readyLine = line("question", "beat", "orc-61.pr-ready", "https://github.com/o/r/pull/9 is ready to merge, checks green: ci", "2026-11-13T12:00:00.000Z")
  expect(inboxItems({ backlog: [delivered("merged")], attention: [ready], runs: [], threads: new Map([["orc-61", { task: "orc-61", entries: [readyLine] }]]) })).toEqual([])
  expect(inboxItems({ backlog: [delivered("merged")], attention: [], runs: [], threads: new Map() })).toEqual([])
  const [open] = inboxItems({ backlog: [delivered("open")], attention: [], runs: [], threads: new Map() })
  expect(open.action).toEqual({ kind: "merge", argv: ["merge", "orc-61", "--basis", "captain-word"] })
})

test("sorts items oldest first instead of by task", () => {
  const held: TaskDetail = { ...started, id: "orc-59", state: { status: "new" }, hold: { reason: "wait for the design", until: null, at: "2026-11-13T13:00:00.000Z", questions: [], answer: null } }
  const items = inboxItems({
    backlog: [held, delivered("open"), started],
    attention: [],
    runs: [remoteRun],
    threads: new Map<string, Thread>([["orc-59", { task: "orc-59", entries: [line("hold", "user", null, "wait for the design", "2026-11-13T13:00:00.000Z")] }], ["orc-60", { task: "orc-60", entries: [ask] }]])
  })
  expect(items.map((item) => `${item.kind} ${item.task}`)).toEqual(["question orc-60", "pr orc-61", "hold orc-59"])
  expect(items.at(-1)?.action).toEqual({ kind: "answer", target: { kind: "hold" } })
})

test("reads no thread for a task nothing flags instead of every task", () => {
  const quiet: AttentionItem = { id: "x", kind: "run-died", task: "orc-60", escalated: false, recommendation: null }
  expect(inboxTasks({ backlog: [started], attention: [quiet], runs: [] })).toEqual([])
  expect(inboxItems(sources([line("question", "beat", "x", "the run on mac died: boom")]))).toEqual([])
})
