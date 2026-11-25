import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { addTask, claimTask, findTask, publishClosed, type TaskRecord } from "../../../packages/run/src/entities/backlog/index"
import { retryTask } from "../../../packages/run/src/features/backlog-planning/index"
import type { DispatchConfig, Project } from "../../../packages/run/src/shared/config/dispatch-config"
import { placeTask } from "../../../packages/run/src/widgets/beat/beat"

const config: DispatchConfig = {
  machines: [{ name: "node-a", slots: 1, start: ["true"] }, { name: "node-b", slots: 4, start: ["true"] }],
  quota: { provider: "keyed", command: ["quota"], accounts: [{ name: "main", kind: "token-file", tokenFile: "/token" }], floorPercent: 15 }
}
const projects: ReadonlyArray<Project> = [{ name: "demo", checkouts: { "node-a": "/a", "node-b": "/b" } }]
const room = [{ machine: "node-a", slots: 1, busy: 0 }, { machine: "node-b", slots: 4, busy: 0 }]
const claim = { beat: "beat", machine: "node-a", account: "main", takenAt: "2026-01-01T00:00:00Z" }
const at = "2026-01-01T00:00:00Z"
const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withClosed = async (kind: "ship" | "parent", closing: "failed" | "stopped" | "start-failed", parked: TaskRecord["parked"], body: (root: string, id: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "orc-retry-"))
  try {
    const task = await run(addTask(root, { title: "Work", project: "demo", kind, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 1, created: at, body: "# Work\n" }))
    await run(claimTask(root, task.spec.id))
    const result = closing === "start-failed"
      ? { outcome: closing, reason: "failed" } as const
      : { outcome: closing, reason: "failed", started: { at, log: "log" }, pr: null, report: null } as const
    await run(publishClosed(root, { ...task, parked, state: { kind: "closed", claim, closing: result, closedAt: at, postedAt: null } }))
    await body(root, task.spec.id)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const answered: NonNullable<TaskRecord["parked"]> = {
  branch: "orc/demo-1",
  origin: { machine: "node-a", run: "prior" },
  questions: [{ id: "question-1", text: "Choose", asked: at, blocks: true, answer: { words: "Yes", at, relayedTo: null } }]
}

describe("backlog retry", () => {
  for (const kind of ["ship", "parent"] as const) {
    test(kind + " retry does not place kept work on a roomier machine", async () => {
      await withClosed(kind, "failed", null, async (root, id) => {
        await run(retryTask(root, id))
        const placement = placeTask(await run(findTask(root, id)), config, projects, room)
        expect(placement.kind === "place" ? placement.machine.name : placement.reason).toBe("node-a")
      })
    })
    test(kind + " retry does not retain an obsolete parked origin", async () => {
      await withClosed(kind, "stopped", answered, async (root, id) => {
        await run(retryTask(root, id))
        const task = await run(findTask(root, id))
        expect(task.parked).toBeNull()
        expect(task.spec.machine).toBe("node-a")
      })
    })
    test(kind + " retry does not wait on an answered question without an origin", async () => {
      const live = { branch: answered.branch, questions: answered.questions }
      await withClosed(kind, "stopped", live, async (root, id) => {
        await run(retryTask(root, id))
        const task = await run(findTask(root, id))
        expect(task.parked).toBeNull()
        expect(task.spec.machine).toBe("node-a")
      })
    })
    test(kind + " retry does not pin a failed start with no kept work", async () => {
      await withClosed(kind, "start-failed", null, async (root, id) => {
        await run(retryTask(root, id))
        const placement = placeTask(await run(findTask(root, id)), config, projects, room)
        expect(placement.kind === "place" ? placement.machine.name : placement.reason).toBe("node-b")
      })
    })
    test(kind + " retry does not lose kept work after a failed start", async () => {
      await withClosed(kind, "start-failed", answered, async (root, id) => {
        await run(retryTask(root, id))
        const task = await run(findTask(root, id))
        const placement = placeTask(task, config, projects, room)
        expect(task.parked).toBeNull()
        expect(placement.kind === "place" ? placement.machine.name : placement.reason).toBe("node-a")
      })
    })
  }
})
