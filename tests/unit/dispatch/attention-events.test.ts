import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { parseDispatchArgs } from "../../../packages/run/src/dispatch/args"
import { answerItem, openItem, openItems, openRunDeaths, routeTaskItems } from "../../../packages/run/src/entities/attention/attention"
import { addTask, claimTask, closeStartedTask, writeTaken, type TaskRecord } from "../../../packages/run/src/entities/backlog/index"
import { runBeat } from "../../../packages/run/src/dispatch/beat"
import { formatBeat } from "../../../packages/run/src/dispatch/board"
import type { PullRequestView } from "../../../packages/run/src/entities/pull-request/pr-view"
import { quietSources, uncheckedOpen } from "../../lib/beat-sources"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const quota = { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: "/secrets/main-token" }], floorPercent: 15 }

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-attention-events-"))
  try {
    await writeFile(join(root, "dispatch.json"), JSON.stringify({ machines: [{ name: "mac", slots: 0, start: ["true"] }], quota }))
    await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: "/checkout" } }] }))
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const commands = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
  const real = yield* ChildProcessSpawner.ChildProcessSpawner
  const reply = (text: string) => real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + text + "\nJ"]))
  return ChildProcessSpawner.make((command) =>
    ChildProcess.isStandardCommand(command) && command.command === "pueue"
      ? reply(JSON.stringify({ tasks: {} }))
      : ChildProcess.isStandardCommand(command) && command.command === "orc-quota"
      ? reply(JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] }))
      : real.spawn(command)
  )
})).pipe(Layer.provide(BunServices.layer))

const beat = (root: string, at: string, view: PullRequestView = uncheckedOpen): Promise<string> =>
  Effect.runPromise(Effect.gen(function*() {
    yield* TestClock.setTime(Date.parse(at))
    const unread = () => Effect.succeed({ kind: "unread" as const, reason: "no load read in this test" })
    return formatBeat(yield* runBeat(root, root, quietSources(unread, () => Effect.succeed(view))))
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, commands, TestClock.layer()))))

const spec = { title: "Fix the login page", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], created: "2026-10-27T10:00:00.000Z", body: "# Fix the login page\n" }

const pr = "https://github.com/acme/orc/pull/7"

const closeWithPr = async (root: string): Promise<void> => {
  await run(addTask(root, spec))
  await run(claimTask(root, "task-1"))
  const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }
  await run(writeTaken(root, { spec: { ...spec, id: "task-1" }, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: "/tmp/task.log" } } }))
  await run(closeStartedTask(root, "task-1", "done", "", { pr, report: null }, "2026-10-27T11:00:00.000Z"))
}

const checked = (conclusion: string, head = "a".repeat(40)): PullRequestView => ({
  ...uncheckedOpen,
  headRefOid: head,
  statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion, startedAt: "2026-10-27T11:10:00.000Z" }]
})

const itemFiles = async (root: string): Promise<ReadonlyArray<unknown>> => {
  const names = (await Array.fromAsync(new Bun.Glob("*.json").scan(join(root, "attention")))).toSorted()
  return Promise.all(names.map(async (name): Promise<unknown> => JSON.parse(await readFile(join(root, "attention", name), "utf8"))))
}

const heldTask = (until: string, answer: { words: string; at: string } | null): TaskRecord => ({
  spec: { ...spec, id: "orc-2", title: "Pick the API" },
  hold: { reason: "REST or gRPC", until, questions: [], answer },
  parked: null,
  state: { kind: "new" }
})

describe("run events in the attention queue", () => {
  test("a run that died opens an item, while a done or stopped run opens none", async () => {
    await withBacklog(async (root) => {
      await run(openRunDeaths(root, [
        { kind: "closed", task: "orc-1", machine: "mac", outcome: "failed", reason: "exit 1", pr: null, report: null },
        { kind: "closed", task: "orc-2", machine: "mac", outcome: "done", reason: "", pr: null, report: null },
        { kind: "closed", task: "orc-3", machine: "mac", outcome: "stopped", reason: "the captain stopped orc-3", pr: null, report: null },
        { kind: "start-failed", task: "orc-4", machine: "mac", reason: "the start command did not run" }
      ], "2026-10-27T12:00:00.000Z"))
      expect((await run(openItems(root))).map(({ item }) => [item.kind, item.task, item.owner])).toEqual([["run-died", "orc-1", "user"], ["run-died", "orc-4", "user"]])
    })
  })

  test("a red check opens an item that green checks withdraw, instead of staying open beside a ready PR", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      await beat(root, "2026-10-27T12:00:00.000Z", checked("FAILURE"))
      expect((await run(openItems(root))).map(({ item }) => [item.kind, item.text])).toEqual([["check-red", pr + ": the check test is red"]])
      await beat(root, "2026-10-27T12:01:00.000Z", checked("SUCCESS"))
      expect((await run(openItems(root))).map(({ item }) => [item.kind, item.text])).toEqual([["pr-ready", pr + " is ready to merge, checks green: test"]])
      expect(await itemFiles(root)).toMatchObject([{ kind: "check-red", state: { kind: "withdrawn" } }, { kind: "pr-ready", state: { kind: "open" } }])
    })
  })

  test("a ready PR reopens its item after a red check clears instead of staying withdrawn", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      await beat(root, "2026-10-27T12:00:00.000Z", checked("SUCCESS"))
      await beat(root, "2026-10-27T12:01:00.000Z", checked("FAILURE"))
      expect((await run(openItems(root))).map(({ item }) => item.kind)).toEqual(["check-red"])
      await beat(root, "2026-10-27T12:02:00.000Z", checked("SUCCESS"))
      expect((await run(openItems(root))).map(({ item }) => [item.kind, item.asked])).toEqual([["pr-ready", "2026-10-27T12:02:00.000Z"]])
      expect(await itemFiles(root)).toMatchObject([{ kind: "check-red", state: { kind: "withdrawn" } }, { kind: "pr-ready", state: { kind: "open" } }])
    })
  })

  test("a merged PR closes its ready item with the merge as its answer, instead of leaving it open", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      await beat(root, "2026-10-27T12:00:00.000Z", checked("SUCCESS"))
      await beat(root, "2026-10-27T12:01:00.000Z", { ...checked("SUCCESS"), state: "MERGED" })
      expect(await run(openItems(root))).toEqual([])
      expect(await itemFiles(root)).toMatchObject([{ kind: "pr-ready", state: { kind: "closed", answer: { words: "merged", at: "2026-10-27T12:01:00.000Z" } } }])
    })
  })

  test("a run-died item closes on orc attention answer, while a review question is sent to orc backlog answer", async () => {
    await withBacklog(async (root) => {
      await run(openRunDeaths(root, [{ kind: "start-failed", task: "orc-4", machine: "mac", reason: "no shell" }], "2026-10-27T12:00:00.000Z"))
      await run(openItem(root, "orc-1.r2.a", { kind: "review-question", task: "orc-1", text: "Keep the flag?", asked: "2026-10-27T12:00:00.000Z", owner: "user" }))
      expect(await run(answerItem(root, "orc-4.run-died", { words: "Requeue it", at: "2026-10-27T12:05:00.000Z" }))).toBe("closed")
      expect(await run(answerItem(root, "orc-1.r2.a", { words: "Keep it", at: "2026-10-27T12:05:00.000Z" }))).toEqual({ kind: "answered elsewhere", task: "orc-1" })
      expect((await run(openItems(root))).map(({ id }) => id)).toEqual(["orc-1.r2.a"])
      expect(parseDispatchArgs("attention", ["answer", "orc-4.run-died", "Requeue", "it"])).toEqual({ kind: "AnswerItem", id: "orc-4.run-died", words: "Requeue it" })
      expect(parseDispatchArgs("attention", ["answer", "../task", "x"])).toMatchObject({ kind: "UsageError" })
    })
  })
})

describe("overdue waits in the attention queue", () => {
  test("a hold whose until date passed opens an item, while one still within its date opens none", async () => {
    const previous = process.env.TZ
    process.env.TZ = "UTC"
    try {
      await withBacklog(async (root) => {
        await run(routeTaskItems(root, [heldTask("2026-12-01", null)], "2026-12-01T23:59:00.000Z"))
        expect(await run(openItems(root))).toEqual([])
        await run(routeTaskItems(root, [heldTask("2026-12-01", null)], "2026-12-02T00:01:00.000Z"))
        expect((await run(openItems(root))).map(({ item }) => item)).toEqual([{
          kind: "overdue-wait", task: "orc-2", text: "held for the captain: REST or gRPC, until 2026-12-01 passed", asked: "2026-12-02T00:00:00.000Z", owner: "user", state: { kind: "open" }
        }])
      })
    } finally {
      if (previous === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = previous
      }
    }
  })

  test("an until date covers its whole local day instead of ending at UTC midnight", async () => {
    const previous = process.env.TZ
    process.env.TZ = "America/Los_Angeles"
    try {
      await withBacklog(async (root) => {
        await run(routeTaskItems(root, [heldTask("2026-12-01", null)], "2026-12-02T07:59:00.000Z"))
        expect(await run(openItems(root))).toEqual([])
        await run(routeTaskItems(root, [heldTask("2026-12-01", null)], "2026-12-02T08:00:00.000Z"))
        expect((await run(openItems(root))).map(({ item }) => item.asked)).toEqual(["2026-12-02T08:00:00.000Z"])
      })
    } finally {
      if (previous === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = previous
      }
    }
  })

  test("an overdue wait an overlapping beat withdrew opens again on the next beat instead of staying withdrawn", async () => {
    const previous = process.env.TZ
    process.env.TZ = "UTC"
    try {
      await withBacklog(async (root) => {
        await run(routeTaskItems(root, [heldTask("2026-12-01", null)], "2026-12-02T00:01:00.000Z"))
        expect((await run(openItems(root))).map(({ id }) => id)).toEqual(["orc-2.overdue-wait.2026-12-01"])
        const unheld: TaskRecord = { spec: { ...spec, id: "orc-2", title: "Pick the API" }, hold: null, parked: null, state: { kind: "new" } }
        await run(routeTaskItems(root, [unheld], "2026-12-02T00:02:00.000Z"))
        expect(await run(openItems(root))).toEqual([])
        await run(routeTaskItems(root, [heldTask("2026-12-01", null)], "2026-12-02T00:03:00.000Z"))
        expect((await run(openItems(root))).map(({ id }) => id)).toEqual(["orc-2.overdue-wait.2026-12-01"])
        expect(await itemFiles(root)).toMatchObject([{ kind: "overdue-wait", state: { kind: "open" } }])
      })
    } finally {
      if (previous === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = previous
      }
    }
  })

  test("an overdue wait reopened after an overlapping beat withdrew it shows the hold reason the task has now instead of the one it had", async () => {
    const previous = process.env.TZ
    process.env.TZ = "UTC"
    try {
      await withBacklog(async (root) => {
        await run(routeTaskItems(root, [heldTask("2026-12-01", null)], "2026-12-02T00:01:00.000Z"))
        const unheld: TaskRecord = { spec: { ...spec, id: "orc-2", title: "Pick the API" }, hold: null, parked: null, state: { kind: "new" } }
        await run(routeTaskItems(root, [unheld], "2026-12-02T00:02:00.000Z"))
        const relabelled: TaskRecord = { ...heldTask("2026-12-01", null), hold: { reason: "waiting on legal review", until: "2026-12-01", questions: [], answer: null } }
        await run(routeTaskItems(root, [relabelled], "2026-12-02T00:03:00.000Z"))
        const open = await run(openItems(root))
        expect(open.map(({ id }) => id)).toEqual(["orc-2.overdue-wait.2026-12-01"])
        expect(open[0]?.item.text).toContain("waiting on legal review")
        expect(open[0]?.item.text).not.toContain("REST or gRPC")
      })
    } finally {
      if (previous === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = previous
      }
    }
  })

  test("answering the hold closes its overdue item with the answer instead of withdrawing it", async () => {
    const previous = process.env.TZ
    process.env.TZ = "UTC"
    try {
      await withBacklog(async (root) => {
        await run(routeTaskItems(root, [heldTask("2026-12-01", null)], "2026-12-02T00:01:00.000Z"))
        await run(routeTaskItems(root, [heldTask("2026-12-01", { words: "REST", at: "2026-12-02T09:00:00.000Z" })], "2026-12-02T09:00:00.000Z"))
        expect(await run(openItems(root))).toEqual([])
        expect(await itemFiles(root)).toMatchObject([{ kind: "overdue-wait", state: { kind: "closed", answer: { words: "REST", at: "2026-12-02T09:00:00.000Z" } } }])
      })
    } finally {
      if (previous === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = previous
      }
    }
  })

  test("an overdue wait an overlapping beat withdrew closes with its answer instead of staying withdrawn", async () => {
    const previous = process.env.TZ
    process.env.TZ = "UTC"
    try {
      await withBacklog(async (root) => {
        await run(routeTaskItems(root, [heldTask("2026-12-01", null)], "2026-12-02T00:01:00.000Z"))
        const unheld: TaskRecord = { spec: { ...spec, id: "orc-2", title: "Pick the API" }, hold: null, parked: null, state: { kind: "new" } }
        await run(routeTaskItems(root, [unheld], "2026-12-02T00:02:00.000Z"))
        expect(await run(openItems(root))).toEqual([])
        await run(routeTaskItems(root, [heldTask("2026-12-01", { words: "REST", at: "2026-12-02T09:00:00.000Z" })], "2026-12-02T09:00:00.000Z"))
        expect(await run(openItems(root))).toEqual([])
        expect(await itemFiles(root)).toMatchObject([{ kind: "overdue-wait", state: { kind: "closed", answer: { words: "REST", at: "2026-12-02T09:00:00.000Z" } } }])
      })
    } finally {
      if (previous === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = previous
      }
    }
  })
})

describe("the beat and the attention queue", () => {
  test("the beat lists open items oldest first before the new tasks it considers, instead of after a launch", async () => {
    await withBacklog(async (root) => {
      await run(openItem(root, "newer", { kind: "review-question", task: "orc-9", text: "Keep the flag?", asked: "2026-10-27T11:58:00.000Z", owner: "user" }))
      await run(openItem(root, "older", { kind: "run-died", task: "orc-3", text: "the run died", asked: "2026-10-27T11:50:00.000Z", owner: "user" }))
      await run(addTask(root, spec))
      const lines = (await beat(root, "2026-10-27T12:00:00.000Z")).split("\n")
      const queue = lines.filter((line) => line.startsWith("needs the "))
      expect(queue).toEqual(["needs the user, overdue older: the run died", "needs the user newer: Keep the flag?"])
      expect(lines.indexOf(queue[1] ?? "")).toBeLessThan(lines.findIndex((line) => line.startsWith("waits orc-1")))
    })
  })
})
