import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { addTask, claimTask, closeStartedTask, listTasks, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { retryStartedTask, sendBackClosedTask } from "../../../packages/run/src/entities/parked-runs/index"
import { backlogJson } from "../../../packages/run/src/widgets/beat/board"
import { cx, documents, nodes, spawned } from "./gpui-fakes"

const wordsOf = (element: unknown): ReadonlyArray<string> => {
  if (typeof element === "string") return [element]
  const made = typeof element === "object" && element !== null ? nodes.get(element) : undefined
  return made === undefined ? [] : made.kids.flatMap(wordsOf)
}

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = (title: string) => ({
  title, project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const,
  created: "2026-11-26T09:00:00.000Z", body: "# " + title + "\n"
})

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-11-26T09:01:00.000Z" }

const startTask = async (root: string, title: string): Promise<string> => {
  const added = await run(addTask(root, spec(title)))
  await run(claimTask(root, added.spec.id))
  await run(writeTaken(root, { ...added, state: { kind: "started", claim, started: { at: "2026-11-26T09:02:00.000Z", log: "/tmp/task.log" } } }))
  return added.spec.id
}

const retriedRun = "20261126-100000-aaaaaa"
const sentBackRun = "20261126-110000-bbbbbb"

const succeededWithPr = (id: string, task: string, pr: number) => ({
  id, project: "/work/orc", branch: "orc/" + task, status: "succeeded", prLink: "https://github.com/o/r/pull/" + pr.toString(),
  title: null, step: null, questions: 0, endReason: null, kind: null, delivery: null, worktree: null
})

const seedBoard = async (root: string): Promise<void> => {
  const retried = await startTask(root, "Retried after its PR opened")
  await run(retryStartedTask(root, retried, "mac", retriedRun, "2026-11-26T10:30:00.000Z"))
  const sent = await startTask(root, "Sent back by the captain")
  await run(closeStartedTask(root, sent, "done", "", { pr: "https://github.com/o/r/pull/49", report: null }, "2026-11-26T11:00:00.000Z"))
  await run(sendBackClosedTask(root, sent, "rename the flag", "2026-11-26T12:00:00.000Z", { machine: "mac", run: sentBackRun }, "cleared"))
  const tasks = await run(listTasks(root))
  documents.set("orc backlog --json", backlogJson({
    tasks, events: [], projects: { kind: "read", projects: [{ name: "orc", checkouts: { mac: "/work/orc" } }] }, room: { kind: "read", room: [] },
    merged: new Set(), prStates: new Map(), beatWaits: null, deciderOwns: () => false
  }))
  documents.set("orc runs --json --local", { schema: "orc.runs.v1", runs: [succeededWithPr(retriedRun, retried, 48), succeededWithPr(sentBackRun, sent, 49)] })
  documents.set("orc attention --json", { schema: "orc.attention.v1", items: [], decided: [] })
}

test("the Agents panel labels a run the beat retried after its PR opened Retried, not Sent back like the run the captain sent back", async () => {
  const root = await mkdtemp(join(tmpdir(), "orc-retried-run-"))
  try {
    await seedBoard(root)
    const { default: OrcAgents } = await import("../../../packages/herdr-app/mods/orc-agents/main")
    const agents = new OrcAgents()
    agents.refresh(cx)
    while (spawned.length > 0) await spawned.shift()
    const openedRun = (runId: string): ReadonlyArray<string> => {
      const card = agents.allCards().find((candidate) => candidate.runId === runId)
      if (card === undefined) throw new Error("No card for " + runId)
      agents.selectedKey = card.key
      return wordsOf(agents.render())
    }
    const retried = openedRun(retriedRun)
    expect(retried).toContain("Retried PR #48")
    expect(retried).not.toContain("Sent back PR #48")
    expect(openedRun(sentBackRun)).toContain("Sent back PR #49")
  } finally {
    documents.clear()
    await rm(root, { recursive: true, force: true })
  }
})
