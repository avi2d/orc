import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Fiber, FileSystem, Layer, Result } from "effect"
import { TestClock } from "effect/testing"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { openItems } from "../../../packages/run/src/entities/attention/attention"
import { routePullRequestWithRetry } from "../../../packages/run/src/entities/attention/pull-request-retry"
import { routePullRequest } from "../../../packages/run/src/entities/attention/beat-items"
import { addTask, claimTask, closeStartedTask, findTask, markCiRerun, markPosted, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { unpostedEvents } from "../../../packages/run/src/entities/events/index"
import { sendBackClosedTask } from "../../../packages/run/src/entities/parked-runs/index"
import { redRuns, type PullRequestView } from "../../../packages/run/src/entities/pull-request/pr-view"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const recording = (asked: Array<ReadonlyArray<string>>) =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command) && command.command === "gh") {
        asked.push(command.args.map(String))
        return real.spawn(ChildProcess.make("true", []))
      }
      return real.spawn(command)
    })
  })).pipe(Layer.provide(BunServices.layer))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-ci-rerun-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const spec = { title: "Fix the login page", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-10-27T10:00:00.000Z", body: "# Fix the login page\n" }
const pr = "https://github.com/acme/orc/pull/7"
const details = "https://github.com/acme/orc/actions/runs/4242/job/99"
const red: PullRequestView = {
  state: "OPEN",
  headRefOid: "a".repeat(40),
  baseRefName: "main",
  statusCheckRollup: [{ workflowName: "ci", detailsUrl: details, name: "test", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-27T11:10:00.000Z" }]
}
const claim = { beat: "beat-1", machine: "worker", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

const closeWithPr = async (root: string): Promise<void> => {
  await run(addTask(root, spec))
  await run(claimTask(root, "orc-1"))
  const task = await run(findTask(root, "orc-1"))
  await run(writeTaken(root, { ...task, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: "/tmp/task.log" } } }))
  await run(closeStartedTask(root, "orc-1", "done", "", { pr, report: null }, "2026-10-27T11:00:00.000Z"))
}

const route = async (root: string, asked: Array<ReadonlyArray<string>>, view = red): Promise<void> => {
  const task = await run(findTask(root, "orc-1"))
  await Effect.runPromise(routePullRequestWithRetry(root, task, pr, view, "2026-10-27T12:00:00.000Z").pipe(Effect.provide(Layer.merge(BunServices.layer, recording(asked)))))
}

describe("a red check on a ship task's PR", () => {
  test("reruns failed jobs instead of the whole run and records the event", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      const asked: Array<ReadonlyArray<string>> = []
      await route(root, asked)
      expect(asked).toEqual([["run", "rerun", "4242", "--failed", "-R", "github.com/acme/orc"]])
      expect(await run(openItems(root))).toEqual([])
      const events = await readdir(join(root, "events"))
      expect(events).toHaveLength(1)
      expect(JSON.parse(await readFile(join(root, "events", events[0] ?? ""), "utf8"))).toMatchObject({ text: "orc-1 Fix the login page: orc reran the failed jobs of ci/test on " + pr })
    })
  })

  test.each(["IN_PROGRESS", "QUEUED"])("does not spend the rerun allowance while a sibling job is %s", async (status) => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      const asked: Array<ReadonlyArray<string>> = []
      const pending: PullRequestView = {
        ...red,
        statusCheckRollup: [
          ...red.statusCheckRollup,
          { workflowName: "ci", detailsUrl: details, name: "parallel", status: "COMPLETED", conclusion: "CANCELLED", startedAt: "2026-10-27T11:00:00.000Z" },
          { workflowName: "ci", detailsUrl: details, name: "parallel", status, conclusion: "", startedAt: "2026-10-27T11:10:00.000Z" },
          { workflowName: "ci", detailsUrl: "https://github.com/acme/orc/actions/runs/5252/job/1", name: "other", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-27T11:10:00.000Z" }
        ]
      }
      await route(root, asked, pending)
      expect(asked).toEqual([])
      expect((await run(findTask(root, "orc-1"))).ciReruns).toBeUndefined()
      expect(await run(openItems(root))).toEqual([])
      expect(redRuns(pending)).toEqual([{ run: "5252", name: "ci/other" }])
      const completed: PullRequestView = {
        ...pending,
        statusCheckRollup: pending.statusCheckRollup.map((entry) => "status" in entry && entry.status === status ? { ...entry, status: "COMPLETED", conclusion: "SUCCESS" } : entry)
      }
      await route(root, asked, completed)
      expect(asked).toEqual([
        ["run", "rerun", "4242", "--failed", "-R", "github.com/acme/orc"],
        ["run", "rerun", "5252", "--failed", "-R", "github.com/acme/orc"]
      ])
      expect(await run(openItems(root))).toEqual([])
      await route(root, asked, completed)
      expect(asked).toHaveLength(2)
      expect((await run(openItems(root)))[0]?.item.text).toContain(details)
    })
  })

  test("withdraws an old ready item instead of keeping it while a red run is in progress", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      await run(routePullRequest(root, "orc-1", pr, { ...red, statusCheckRollup: [{ ...red.statusCheckRollup[0], conclusion: "SUCCESS" }] }, "2026-10-27T11:00:00.000Z"))
      const asked: Array<ReadonlyArray<string>> = []
      await route(root, asked, { ...red, headRefOid: "b".repeat(40), statusCheckRollup: [...red.statusCheckRollup, { workflowName: "ci", detailsUrl: details, name: "parallel", status: "IN_PROGRESS", conclusion: "", startedAt: "2026-10-27T11:10:00.000Z" }] })
      expect(await run(openItems(root))).toEqual([])
      expect(asked).toEqual([])
    })
  })

  test("opens a red item instead of holding when the PR already used its rerun", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      const asked: Array<ReadonlyArray<string>> = []
      await route(root, asked)
      await route(root, asked, { ...red, statusCheckRollup: [...red.statusCheckRollup, { workflowName: "ci", detailsUrl: details, name: "parallel", status: "IN_PROGRESS", conclusion: "", startedAt: "2026-10-27T11:10:00.000Z" }] })
      expect(asked).toHaveLength(1)
      expect((await run(openItems(root)))[0]?.item.text).toContain(details)
    })
  })

  test("keeps equally named checks from different Actions runs instead of collapsing them", () => {
    const view: PullRequestView = {
      ...red,
      statusCheckRollup: [
        ...red.statusCheckRollup,
        { workflowName: "ci", detailsUrl: "https://github.com/acme/orc/actions/runs/5252/job/1", name: "test", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-27T11:10:00.000Z" }
      ]
    }
    expect(redRuns(view)).toEqual([{ run: "4242", name: "ci/test" }, { run: "5252", name: "ci/test" }])
  })

  test("opens the red item instead of aborting when the rerun marker cannot be written", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      const task = await run(findTask(root, "orc-1"))
      for (const file of await readdir(join(root, "closed"))) {
        await rm(join(root, "closed", file))
      }
      const asked: Array<ReadonlyArray<string>> = []
      await Effect.runPromise(routePullRequestWithRetry(root, task, pr, red, "2026-10-27T12:00:00.000Z").pipe(Effect.provide(Layer.merge(BunServices.layer, recording(asked)))))
      expect(asked).toEqual([])
      expect((await run(openItems(root)))[0]?.item.text).toContain(details)
      expect((await run(unpostedEvents(root)))[0]?.text).toContain("could not record")
    })
  })

  test("does not report an old failure while its queued rerun has no start time", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      const asked: Array<ReadonlyArray<string>> = []
      await route(root, asked)
      const queued: PullRequestView = {
        ...red,
        statusCheckRollup: [
          ...red.statusCheckRollup,
          { workflowName: "ci", detailsUrl: details, name: "test", status: "QUEUED", conclusion: "", startedAt: "0001-01-01T00:00:00Z" }
        ]
      }
      await route(root, asked, queued)
      expect(asked).toHaveLength(1)
      expect(await run(openItems(root))).toEqual([])
    })
  })

  test.each(["WAITING", "PENDING"])("opens a red item instead of holding indefinitely when a sibling job is %s", async (status) => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      const asked: Array<ReadonlyArray<string>> = []
      const pending: PullRequestView = {
        ...red,
        statusCheckRollup: [
          ...red.statusCheckRollup,
          { workflowName: "ci", detailsUrl: details, name: "parallel", status, conclusion: "", startedAt: "2026-10-27T11:10:00.000Z" }
        ]
      }
      await route(root, asked, pending)
      expect(asked).toEqual([])
      expect((await run(findTask(root, "orc-1"))).ciReruns).toBeUndefined()
      expect((await run(openItems(root)))[0]?.item.text).toContain(details)
    })
  })

  test.each(["WAITING", "PENDING"])("opens the red item instead of rerunning a different run when a sibling is %s", async (status) => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      const asked: Array<ReadonlyArray<string>> = []
      const pending: PullRequestView = {
        ...red,
        statusCheckRollup: [
          ...red.statusCheckRollup,
          { workflowName: "ci", detailsUrl: details, name: "parallel", status, conclusion: "", startedAt: "2026-10-27T11:10:00.000Z" },
          { workflowName: "ci", detailsUrl: "https://github.com/acme/orc/actions/runs/5252/job/1", name: "other", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-27T11:10:00.000Z" }
        ]
      }
      await route(root, asked, pending)
      expect(asked).toEqual([])
      expect((await run(findTask(root, "orc-1"))).ciReruns).toBeUndefined()
      expect((await run(openItems(root)))[0]?.item.text).toContain(details)
    })
  })

  test("interrupts a stalled rerun after 30 seconds instead of blocking the beat", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      const task = await run(findTask(root, "orc-1"))
      await Effect.runPromise(Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        let interrupted = false
        const spawner = ChildProcessSpawner.make(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => { interrupted = true }))
          ))
        const fiber = yield* routePullRequestWithRetry(root, task, pr, red, "2026-10-27T12:00:00.000Z").pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.forkChild
        )
        yield* Deferred.await(started)
        yield* TestClock.adjust("30 seconds")
        expect(interrupted).toBe(true)
        yield* Fiber.join(fiber)
      }).pipe(Effect.provide(Layer.merge(BunServices.layer, TestClock.layer()))))
      expect((await run(openItems(root)))[0]?.item.text).toContain(details)
      expect((await run(findTask(root, "orc-1"))).ciReruns).toHaveLength(1)
      const events = await run(unpostedEvents(root))
      expect(events).toHaveLength(1)
      expect(events[0]?.text).toContain("timed out after 30 seconds")
    })
  })

  test.each(["posting", "rerun"])("does not lose state when %s holds the closed-task grab", async (writer) => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      const marker = { pr, runs: ["4242"], at: "2026-10-27T12:00:00.000Z" }
      await run(Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        let overlapped = false
        const grabbedFs = {
          ...fs,
          readFileString: (path: string, options?: Parameters<typeof fs.readFileString>[1]) =>
            fs.readFileString(path, options).pipe(Effect.tap(() => {
              if (!path.startsWith(join(root, "closed") + "/")) {
                return Effect.void
              }
              return Effect.gen(function*() {
                overlapped = true
                const attempt = yield* (writer === "posting" ? markCiRerun(root, "orc-1", marker) : markPosted(root, "orc-1", marker.at)).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.result
                )
                expect(Result.isFailure(attempt)).toBe(true)
              })
            }))
        } satisfies FileSystem.FileSystem
        expect(yield* (writer === "posting" ? markPosted(root, "orc-1", marker.at) : markCiRerun(root, "orc-1", marker)).pipe(Effect.provideService(FileSystem.FileSystem, grabbedFs))).toBe(true)
        expect(overlapped).toBe(true)
        expect(yield* (writer === "posting" ? markCiRerun(root, "orc-1", marker) : markPosted(root, "orc-1", marker.at))).toBe(true)
      }))
      const task = await run(findTask(root, "orc-1"))
      expect(task.ciReruns).toEqual([marker])
      expect(task.state.kind === "closed" ? task.state.postedAt : null).toBe(marker.at)
      expect(await run(markPosted(root, "orc-1", marker.at))).toBe(false)
    })
  })

  test("opens a red item instead of rerunning a second time", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      const asked: Array<ReadonlyArray<string>> = []
      await route(root, asked)
      await route(root, asked)
      expect(asked).toHaveLength(1)
      expect((await run(openItems(root)))[0]?.item.text).toContain(details)
    })
  })

  test("keeps non-Actions failure links instead of dropping them after a rerun", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      const asked: Array<ReadonlyArray<string>> = []
      await route(root, asked)
      const external = "https://ci.example/build/42"
      await route(root, asked, { ...red, statusCheckRollup: [{ workflowName: "security", detailsUrl: external, name: "scan", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-27T11:10:00.000Z" }] })
      expect((await run(openItems(root)))[0]?.item.text).toContain(external)
      expect(asked).toHaveLength(1)
    })
  })

  test("does not rerun the same PR again after send-back and re-close", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      const asked: Array<ReadonlyArray<string>> = []
      await route(root, asked)
      await run(sendBackClosedTask(root, "orc-1", "fix it", "2026-10-27T12:10:00.000Z", { machine: "worker", run: "run-1", pr }, "cleared"))
      await run(claimTask(root, "orc-1"))
      const task = await run(findTask(root, "orc-1"))
      await run(writeTaken(root, { ...task, state: { kind: "started", claim, started: { at: "2026-10-27T12:11:00.000Z", log: "/tmp/task.log" } } }))
      await run(closeStartedTask(root, "orc-1", "done", "", { pr, report: null }, "2026-10-27T12:12:00.000Z"))
      await route(root, asked)
      expect(asked).toHaveLength(1)
      expect((await run(openItems(root)))[0]?.item.text).toContain(details)
    })
  })
})
