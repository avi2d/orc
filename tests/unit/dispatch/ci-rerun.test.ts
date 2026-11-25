import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { openItems } from "../../../packages/run/src/entities/attention/attention"
import { routePullRequestWithRetry } from "../../../packages/run/src/entities/attention/pull-request-retry"
import { addTask, claimTask, closeStartedTask, findTask, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { sendBackClosedTask } from "../../../packages/run/src/entities/parked-runs/index"
import type { PullRequestView } from "../../../packages/run/src/entities/pull-request/pr-view"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const recording = (asked: Array<ReadonlyArray<string>>) =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command) && command.command === "gh") {
        asked.push(command.args)
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
  await run(claimTask(root, "task-1"))
  const task = await run(findTask(root, "task-1"))
  await run(writeTaken(root, { ...task, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: "/tmp/task.log" } } }))
  await run(closeStartedTask(root, "task-1", "done", "", { pr, report: null }, "2026-10-27T11:00:00.000Z"))
}

const route = async (root: string, asked: Array<ReadonlyArray<string>>, view = red): Promise<void> => {
  const task = await run(findTask(root, "task-1"))
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
      expect(JSON.parse(await readFile(join(root, "events", events[0] ?? ""), "utf8"))).toMatchObject({ text: "task-1 Fix the login page: orc reran the failed jobs of ci/test on " + pr })
    })
  })

})
