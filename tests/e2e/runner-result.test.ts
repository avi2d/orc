import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Schema } from "effect"
import { openDatabase, recordRun } from "../../packages/run/src/run-history"
import { binPath, fakeQuota, isRecord, orcOk, orcThere, resultJson, RunnerRun, runnerTimeout, runOrc, waitForAddedTasks, withFixture, writeTwoHomeDispatches } from "./runner-helpers"

describe("orc runner result", () => {
  test("a label-less result returns without stdin closing instead of waiting on stdin to EOF", async () => {
    await withFixture(async (fixture) => {
      const proc = Bun.spawn([process.execPath, binPath, "runner", "result", "task-7", "--json"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        cwd: fixture.dir,
        env: { ...process.env, ...fixture.env }
      })
      try {
        const exitCode = await Promise.race([proc.exited, Bun.sleep(8000).then(() => "timed-out" as const)])
        if (exitCode === "timed-out") {
          throw new Error("orc runner result task-7 never returned with its stdin pipe left open")
        }
        expect(exitCode).toBe(0)
        expect(JSON.parse(await new Response(proc.stdout).text())).toEqual({
          schema: "orc.runner.v1",
          result: { task: "task-7", status: "unknown" }
        })
      } finally {
        proc.kill()
      }
    })
  }, runnerTimeout)

  test("reads each pueue state as its own result instead of one running bucket", async () => {
    await withFixture(async (fixture) => {
      const statuses = await Promise.all(["task-1", "task-2", "task-3", "task-4", "task-5", "task-6", "task-7"].map(async (task) => resultJson(fixture, task)))
      expect(statuses).toEqual([
        { schema: "orc.runner.v1", result: { task: "task-1", status: "succeeded", pueueTask: 655, run: null, started: "2026-10-28T02:36:39.176448491+03:00", ended: "2026-10-28T02:36:39.489650573+03:00" } },
        { schema: "orc.runner.v1", result: { task: "task-2", status: "failed", pueueTask: 656, run: null, started: "2026-10-28T02:36:39.500714478+03:00", ended: "2026-10-28T02:36:39.813373536+03:00", reason: "orc exited 3" } },
        { schema: "orc.runner.v1", result: { task: "task-3", status: "failed", pueueTask: 657, run: null, started: "2026-10-28T02:36:41.331824562+03:00", ended: "2026-10-28T02:36:42.246702792+03:00", reason: "the run was killed" } },
        { schema: "orc.runner.v1", result: { task: "task-4", status: "queued", pueueTask: 658, run: null } },
        { schema: "orc.runner.v1", result: { task: "task-5", status: "stashed", pueueTask: 659, run: null } },
        { schema: "orc.runner.v1", result: { task: "task-6", status: "running", pueueTask: 660, run: null, started: "2026-10-28T02:36:41.331824562+03:00", outputAt: "2026-10-28T02:36:41.331824562+03:00" } },
        { schema: "orc.runner.v1", result: { task: "task-7", status: "unknown" } }
      ])
    })
  }, runnerTimeout)

  test("a task-1 queued by another home reads unknown instead of that home's run", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({
        tasks: {
          "77": {
            id: 77,
            label: join(fixture.dir, "other-home") + " task-1",
            group: "orc",
            path: "/checkout",
            status: { Done: { start: "2026-10-28T02:36:39.176448491+03:00", end: "2026-10-28T02:36:39.489650573+03:00", result: "Success" } }
          }
        },
        groups: {}
      }))
      expect(await resultJson(fixture, "task-1")).toEqual({ schema: "orc.runner.v1", result: { task: "task-1", status: "unknown" } })
    })
  }, runnerTimeout)

  test("names the orc run on the task's branch with its PR, not just pueue's exit", async () => {
    await withFixture(async (fixture) => {
      const db = await Effect.runPromise(openDatabase(fixture.home).pipe(Effect.provide(BunServices.layer)))
      try {
        Effect.runSync(recordRun(db, {
          id: "run-1",
          project: "/checkout",
          branch: "orc/task-1",
          taskFile: "task.md",
          status: "succeeded",
          started: "2026-10-27T23:36:39.200Z",
          ended: "2026-10-27T23:36:39.400Z",
          prLink: "https://github.com/avi2d/orc/pull/1"
        }))
      } finally {
        db.close()
      }
      expect(await orcOk(fixture, ["runner", "result", "task-1"])).toBe([
        "task-1: succeeded as pueue task 655, 2026-10-28T02:36:39.176448491+03:00 to 2026-10-28T02:36:39.489650573+03:00",
        "orc run run-1 succeeded, PR https://github.com/avi2d/orc/pull/1",
        ""
      ].join("\n"))
    })
  }, runnerTimeout)

  test("a run on the same branch in another checkout is not attached to the task", async () => {
    await withFixture(async (fixture) => {
      const db = await Effect.runPromise(openDatabase(fixture.home).pipe(Effect.provide(BunServices.layer)))
      try {
        Effect.runSync(recordRun(db, {
          id: "run-other",
          project: "/other-checkout",
          branch: "orc/task-1",
          taskFile: "task.md",
          status: "succeeded",
          started: "2026-10-28T02:36:39.200Z",
          ended: "2026-10-28T02:36:39.400Z",
          prLink: "https://github.com/avi2d/orc/pull/9"
        }))
      } finally {
        db.close()
      }
      const document = Schema.decodeUnknownSync(RunnerRun)(await resultJson(fixture, "task-1"))
      expect(document.result.run).toBeNull()
    })
  }, runnerTimeout)

  test("a failed task does not inherit an earlier run's PR", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({
        tasks: {
          "77": {
            id: 77,
            label: fixture.home + " task-1",
            group: "orc",
            path: "/checkout",
            status: { Done: { start: "2026-10-28T02:36:39.500Z", end: "2026-10-28T02:36:39.800Z", result: { Failed: 3 } } }
          }
        },
        groups: {}
      }))
      const db = await Effect.runPromise(openDatabase(fixture.home).pipe(Effect.provide(BunServices.layer)))
      try {
        Effect.runSync(recordRun(db, {
          id: "run-earlier",
          project: "/checkout",
          branch: "orc/task-1",
          taskFile: "task.md",
          status: "succeeded",
          started: "2026-10-28T02:36:39.100Z",
          ended: "2026-10-28T02:36:39.200Z",
          prLink: "https://github.com/avi2d/orc/pull/1"
        }))
      } finally {
        db.close()
      }
      const document = Schema.decodeUnknownSync(RunnerRun)(await resultJson(fixture, "task-1"))
      expect(document.result.run).toBeNull()
      expect(await orcOk(fixture, ["runner", "result", "task-1"])).toContain("orc holds no run on orc/task-1")
    })
  }, runnerTimeout)

  test("a task does not close with a later run's PR", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({
        tasks: {
          "77": {
            id: 77,
            label: fixture.home + " task-1",
            group: "orc",
            path: "/checkout",
            status: { Done: { start: "2026-10-28T02:36:39.100Z", end: "2026-10-28T02:36:39.200Z", result: { Failed: 3 } } }
          }
        },
        groups: {}
      }))
      const db = await Effect.runPromise(openDatabase(fixture.home).pipe(Effect.provide(BunServices.layer)))
      try {
        Effect.runSync(recordRun(db, {
          id: "run-later",
          project: "/checkout",
          branch: "orc/task-1",
          taskFile: "task.md",
          status: "succeeded",
          started: "2026-10-28T02:36:39.500Z",
          ended: "2026-10-28T02:36:39.600Z",
          prLink: "https://github.com/avi2d/orc/pull/9"
        }))
      } finally {
        db.close()
      }
      const document = Schema.decodeUnknownSync(RunnerRun)(await resultJson(fixture, "task-1"))
      expect(document.result.run).toBeNull()
      expect(await orcOk(fixture, ["runner", "result", "task-1"])).toContain("orc holds no run on orc/task-1")
    })
  }, runnerTimeout)

  test("a result read through a command is the far side's result, not the reader's", async () => {
    await withFixture(async (fixture) => {
      const far = join(fixture.dir, "far-home")
      const statusFile = join(fixture.pueue, "status.json")
      const status: unknown = JSON.parse(await readFile(statusFile, "utf8"))
      if (!isRecord(status) || !isRecord(status.tasks) || !isRecord(status.tasks["656"])) {
        throw new Error("the fixture holds no pueue task 656")
      }
      const near = status.tasks["656"]
      status.tasks["777"] = { ...near, id: 777, label: far + " task-2" }
      await writeFile(statusFile, JSON.stringify(status))
      const db = await Effect.runPromise(openDatabase(far).pipe(Effect.provide(BunServices.layer)))
      try {
        Effect.runSync(recordRun(db, {
          id: "run-far",
          project: "/checkout",
          branch: "orc/task-2",
          taskFile: "task.md",
          status: "succeeded",
          started: "2026-10-27T23:36:39.600Z",
          ended: "2026-10-27T23:36:39.700Z",
          prLink: "https://github.com/avi2d/orc/pull/2"
        }))
      } finally {
        db.close()
      }
      const farResult = Schema.decodeUnknownSync(RunnerRun)(await resultJson(fixture, "task-2", ["--", ...orcThere(far)]))
      const nearResult = Schema.decodeUnknownSync(RunnerRun)(await resultJson(fixture, "task-2"))
      expect(farResult.result.run).toEqual({ id: "run-far", status: "succeeded", prLink: "https://github.com/avi2d/orc/pull/2", endReason: null, openQuestions: [] })
      expect(nearResult.result.run).toBeNull()
    })
  }, runnerTimeout)

  test("a result read through a splitting command still reads the far home's run instead of splitting its label", async () => {
    await withFixture(async (fixture) => {
      const far = join(fixture.dir, "far-home")
      const statusFile = join(fixture.pueue, "status.json")
      const status: unknown = JSON.parse(await readFile(statusFile, "utf8"))
      if (!isRecord(status) || !isRecord(status.tasks) || !isRecord(status.tasks["656"])) {
        throw new Error("the fixture holds no pueue task 656")
      }
      const near = status.tasks["656"]
      status.tasks["777"] = { ...near, id: 777, label: far + " task-2" }
      await writeFile(statusFile, JSON.stringify(status))
      const db = await Effect.runPromise(openDatabase(far).pipe(Effect.provide(BunServices.layer)))
      try {
        Effect.runSync(recordRun(db, {
          id: "run-far",
          project: "/checkout",
          branch: "orc/task-2",
          taskFile: "task.md",
          status: "succeeded",
          started: "2026-10-27T23:36:39.600Z",
          ended: "2026-10-27T23:36:39.700Z",
          prLink: "https://github.com/avi2d/orc/pull/2"
        }))
      } finally {
        db.close()
      }
      const splitting = ["sh", "-c", "joined=\"$*\"; ORC_HOME='" + far + "' eval \"exec \\\"$0\\\" '" + binPath + "' $joined\"", process.execPath]
      const farResult = Schema.decodeUnknownSync(RunnerRun)(await resultJson(fixture, "task-2", ["--", ...splitting]))
      expect(farResult.result.run).toEqual({ id: "run-far", status: "succeeded", prLink: "https://github.com/avi2d/orc/pull/2", endReason: null, openQuestions: [] })
    })
  }, runnerTimeout)

  test("two homes sharing one far runner queue separately and read their own runs instead of seeing each other's", async () => {
    await withFixture(async (fixture) => {
      const homeA = fixture.home
      const homeB = join(fixture.dir, "home-b")
      const far = join(fixture.dir, "far-home")
      await mkdir(join(homeB, "backlog"), { recursive: true })
      await mkdir(far, { recursive: true })
      await writeFile(join(homeB, "backlog", "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { linux: fixture.checkout } }] }))
      await fakeQuota(fixture)
      const machineThroughFar = [process.execPath, binPath, "runner", "start", "--", ...orcThere(far)]
      await writeTwoHomeDispatches(homeA, homeB, machineThroughFar)
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--machine", "linux"])
      await orcOk(fixture, ["beat"])
      const addB = await runOrc(fixture, ["backlog", "add", "orc", "task.md", "--machine", "linux"], { ORC_HOME: homeB })
      if (addB.exitCode !== 0) {
        throw new Error("home-b add exited " + addB.exitCode + ": " + addB.stderr)
      }
      const beatB = await runOrc(fixture, ["beat"], { ORC_HOME: homeB })
      if (beatB.exitCode !== 0) {
        throw new Error("home-b beat exited " + beatB.exitCode + ": " + beatB.stderr)
      }
      expect(beatB.stdout).toContain("started orc-1")
      expect(beatB.stdout).not.toContain("already")
      const added = await waitForAddedTasks(fixture)
      const labelA = homeA + " orc-1"
      const labelB = homeB + " orc-1"
      expect(added.some((line) => line.startsWith(labelA + " orc "))).toBe(true)
      expect(added.some((line) => line.startsWith(labelB + " orc "))).toBe(true)
      const queueA = await runOrc(fixture, ["runner", "queue"], { ORC_HOME: far }, JSON.stringify({ task: "orc-1", checkout: fixture.checkout, provider: "acme", body: "# x\n", token: "tokenA123", expiresAt: "2027-01-01T00:00:00.000Z", label: labelA }))
      expect(queueA.exitCode).toBe(0)
      const queueB = await runOrc(fixture, ["runner", "queue"], { ORC_HOME: far }, JSON.stringify({ task: "orc-1", checkout: fixture.checkout, provider: "acme", body: "# x\n", token: "tokenB123", expiresAt: "2027-01-01T00:00:00.000Z", label: labelB }))
      expect(queueB.exitCode).toBe(0)
      expect(queueB.stdout).toContain("queued orc-1")
      const tokenFileA = join(far, "runner", "tokens", "label-" + encodeURIComponent(labelA), "token")
      const tokenFileB = join(far, "runner", "tokens", "label-" + encodeURIComponent(labelB), "token")
      expect(await readFile(tokenFileA, "utf8")).toBe("tokenA123")
      expect(await readFile(tokenFileB, "utf8")).toBe("tokenB123")
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({
        tasks: {
          "77": { id: 77, label: labelA, group: "orc", path: fixture.checkout, status: { Running: { start: "2026-10-28T02:36:41.331824562+03:00" } } },
          "78": { id: 78, label: labelB, group: "orc", path: fixture.checkout, status: { Running: { start: "2026-10-28T02:36:41.331824562+03:00" } } }
        },
        groups: {}
      }))
      const renewB = await runOrc(fixture, ["runner", "renew", "--", ...orcThere(far)], { ORC_HOME: homeB }, JSON.stringify({ task: "orc-1", token: "tokenB456", expiresAt: "2027-01-01T00:00:00.000Z", label: labelB }))
      expect(renewB.exitCode).toBe(0)
      expect(await readFile(tokenFileA, "utf8")).toBe("tokenA123")
      expect(await readFile(tokenFileB, "utf8")).toBe("tokenB456")
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({
        tasks: {
          "77": { id: 77, label: labelA, group: "orc", path: fixture.checkout, status: { Done: { start: "2026-10-28T02:36:39.176448491+03:00", end: "2026-10-28T02:36:39.489650573+03:00", result: "Success" } } },
          "78": { id: 78, label: labelB, group: "orc", path: fixture.checkout, status: { Done: { start: "2026-10-28T02:36:39.500714478+03:00", end: "2026-10-28T02:36:39.813536573+03:00", result: { Failed: 3 } } } }
        },
        groups: {}
      }))
      const RunnerStatus = Schema.Struct({ result: Schema.Struct({ status: Schema.String, pueueTask: Schema.Finite }) })
      const resultA = Schema.decodeUnknownSync(RunnerStatus)(JSON.parse(await orcOk(fixture, ["runner", "result", "orc-1", "--label", labelA, "--json", "--", ...orcThere(far)], { ORC_HOME: homeA })))
      const resultB = Schema.decodeUnknownSync(RunnerStatus)(JSON.parse(await orcOk(fixture, ["runner", "result", "orc-1", "--label", labelB, "--json", "--", ...orcThere(far)], { ORC_HOME: homeB })))
      expect(resultA.result.status).toBe("succeeded")
      expect(resultA.result.pueueTask).toBe(77)
      expect(resultB.result.status).toBe("failed")
      expect(resultB.result.pueueTask).toBe(78)
    })
  }, runnerTimeout)
})
