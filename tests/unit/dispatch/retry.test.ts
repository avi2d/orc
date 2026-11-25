import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { addTask, claimTask, closeStartedTask, findTask, publishClosed, taskPr, writeTaken, type TaskRecord } from "../../../packages/run/src/entities/backlog/index"
import { retryTask } from "../../../packages/run/src/features/backlog-planning/index"
import { answerItem, openItems, openRunDeaths, type BeatAction } from "../../../packages/run/src/entities/attention/index"
import { sendBackClosedTask } from "../../../packages/run/src/entities/parked-runs/index"
import { readRequest } from "../../../packages/run/src/features/queueing-a-task/runner-request"
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

const withClosed = async (kind: "ship" | "parent", closing: "failed" | "stopped" | "start-failed", parked: TaskRecord["parked"], body: (root: string, id: string) => Promise<void>, pr: string | null = null) => {
  const root = await mkdtemp(join(tmpdir(), "orc-retry-"))
  try {
    const task = await run(addTask(root, { title: "Work", project: "demo", kind, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 1, created: at, body: "# Work\n" }))
    await run(claimTask(root, task.spec.id))
    const result = closing === "start-failed"
      ? { outcome: closing, reason: "failed" } as const
      : { outcome: closing, reason: "failed", started: { at, log: "log" }, pr, report: null } as const
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
    test(kind + " retry does not lose unconsumed answers after a failed start", async () => {
      await withClosed(kind, "start-failed", answered, async (root, id) => {
        await run(retryTask(root, id))
        const task = await run(findTask(root, id))
        const placement = placeTask(task, config, projects, room)
        expect(task.parked).toEqual(answered)
        expect(task.spec.machine).toBeNull()
        expect(placement.kind === "place" ? placement.machine.name : placement.reason).toBe("node-a")
        await run(claimTask(root, id))
        const request = await run(readRequest({
          ORC_TASK_ID: id,
          ORC_TASK_FILE: join(root, "taken", id + ".md"),
          ORC_TASK_CHECKOUT: "/a",
          ORC_TASK_PROVIDER: "acme"
        }, Effect.succeed("")))
        expect(request.resumeRun).toBe("prior")
        expect(request.answers).toEqual([{ question: "question-1", answer: "Yes" }])
      })
    })
    for (const outcome of ["failed", "stopped"] as const) {
      for (const source of ["closing", "parked"] as const) {
        test(kind + " retry of " + outcome + " does not lose the " + source + " PR before another send-back", async () => {
          const pr = "https://github.com/acme/demo/pull/7"
          const parked = source === "parked" ? { ...answered, origin: { machine: "node-a", run: "prior", pr } } : null
          await withClosed(kind, outcome, parked, async (root, id) => {
            await run(retryTask(root, id))
            const retried = await run(findTask(root, id))
            expect(retried.priorPr).toBe(pr)
            expect(retried.parked).toBeNull()
            await run(claimTask(root, id))
            const failedStart = await run(findTask(root, id))
            await run(publishClosed(root, { ...failedStart, state: { kind: "closed", claim, closing: { outcome: "start-failed", reason: "no shell" }, closedAt: at, postedAt: null } }))
            await run(retryTask(root, id))
            expect((await run(findTask(root, id))).priorPr).toBe(pr)
            await run(claimTask(root, id))
            const taken = await run(findTask(root, id))
            await run(writeTaken(root, { ...taken, state: { kind: "started", claim, started: { at, log: "log" } } }))
            await run(closeStartedTask(root, id, outcome, "no push", { pr: null, report: null }, "2026-01-02T00:00:00Z"))
            expect(taskPr(await run(findTask(root, id)))).toBe(pr)
            await run(sendBackClosedTask(root, id, "Keep the API", "2026-01-03T00:00:00Z", { machine: "node-a", run: "retried" }))
            expect((await run(findTask(root, id))).parked?.origin?.pr).toBe(pr)
          }, source === "closing" ? pr : null)
        })
      }
    }
    test(kind + " retry does not drop send-back words or the PR after a failed start", async () => {
      const parked = {
        ...answered,
        origin: { machine: "node-a", run: "prior", pr: "https://github.com/acme/demo/pull/7" },
        questions: [{ ...answered.questions[0], id: "send-back" }] as const
      }
      await withClosed(kind, "start-failed", parked, async (root, id) => {
        await run(retryTask(root, id))
        expect((await run(findTask(root, id))).parked).toEqual(parked)
      })
    })
  }
  for (const outcome of ["failed", "start-failed"] as const) {
    for (const answeredItem of [false, true]) {
      test("retry does not hide a second " + outcome + " after an " + (answeredItem ? "answered" : "open") + " death item", async () => {
        await withClosed("ship", outcome, null, async (root, id) => {
          const action: BeatAction = outcome === "start-failed"
            ? { kind: "start-failed", task: id, machine: "node-a", reason: "no shell" }
            : { kind: "closed", task: id, machine: "node-a", outcome, reason: "exit 1", pr: null, report: null }
          await run(openRunDeaths(root, [action], at))
          const first = (await run(openItems(root)))[0]
          expect(first).toBeDefined()
          if (answeredItem && first !== undefined) {
            await run(answerItem(root, first.id, { words: "rerun", at }))
          }
          await run(retryTask(root, id))
          expect(await run(openItems(root))).toEqual([])
          const later = "2026-01-02T00:00:00Z"
          await run(openRunDeaths(root, [action], later))
          const second = await run(openItems(root))
          expect(second).toHaveLength(1)
          expect(second[0]?.id).not.toBe(first?.id)
          expect(second[0]?.item.asked).toBe(later)
        })
      })
    }
  }
})
