import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { openItems } from "../../../packages/run/src/entities/attention/attention"
import { routePullRequest } from "../../../packages/run/src/entities/attention/pull-request-items"
import { addTask, claimTask, closeStartedTask, findTask, writeTaken } from "../../../packages/run/src/entities/backlog/index"
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

const closeWithPr = async (root: string): Promise<void> => {
  await run(addTask(root, spec))
  await run(claimTask(root, "task-1"))
  const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }
  await run(writeTaken(root, { spec: { ...spec, id: "task-1" }, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: "/tmp/task.log" } } }))
  await run(closeStartedTask(root, "task-1", "done", "", { pr, report: null }, "2026-10-27T11:00:00.000Z"))
}

const route = async (root: string, asked: Array<ReadonlyArray<string>>, at: string): Promise<void> => {
  const task = await run(findTask(root, "task-1"))
  await Effect.runPromise(routePullRequest(root, task, pr, red, at).pipe(Effect.provide(Layer.merge(BunServices.layer, recording(asked)))))
}

describe("a red check on a ship task's PR", () => {
  test("reruns only the failed jobs of its run, instead of the whole run, and records the rerun", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      const asked: Array<ReadonlyArray<string>> = []
      await route(root, asked, "2026-10-27T12:00:00.000Z")
      expect(asked).toEqual([["run", "rerun", "4242", "--failed", "-R", "github.com/acme/orc"]])
      expect(asked[0]).toContain("--failed")
      expect(await run(openItems(root))).toEqual([])
      expect((await run(findTask(root, "task-1"))).state).toMatchObject({ ciRerun: { pr, runs: ["4242"], at: "2026-10-27T12:00:00.000Z" } })
      const events = await readdir(join(root, "events"))
      expect(events).toHaveLength(1)
      expect(JSON.parse(await readFile(join(root, "events", events[0] ?? ""), "utf8"))).toMatchObject({ text: "task-1 Fix the login page: orc reran the failed jobs of ci/test on " + pr })
    })
  })

  test("opens the check-red item after the rerun, instead of rerunning a second time", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      const asked: Array<ReadonlyArray<string>> = []
      await route(root, asked, "2026-10-27T12:00:00.000Z")
      await route(root, asked, "2026-10-27T12:10:00.000Z")
      expect(asked).toHaveLength(1)
      expect((await run(openItems(root))).map(({ item }) => [item.kind, item.text])).toEqual([["check-red", pr + ": the check ci/test is red at " + details]])
    })
  })
})
