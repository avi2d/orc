import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { addTask, backlogPaths, claimTask, findTask, listTasks, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { openItems } from "../../../packages/run/src/entities/attention/index"
import { readResultReaching, readResultThrough } from "../../../packages/run/src/features/queueing-a-task/index"
import { MachineUnreached, RunnerError } from "../../../packages/run/src/shared/process/index"
import { runBeat } from "../../../packages/run/src/widgets/beat/beat"
import { closeFinished } from "../../../packages/run/src/widgets/beat/beat-close"
import { readDispatchConfig } from "../../../packages/run/src/shared/config/dispatch-config"
import { quietSources } from "../../lib/beat-sources"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const closedConnection = "Connection closed by UNKNOWN port 65535"

const reachExiting = (reach: string, exitCode: number): Promise<void> =>
  writeFile(reach, "#!/bin/sh\necho '" + closedConnection + "' >&2\nexit " + exitCode.toString() + "\n")

const withReach = async (exitCode: number, body: (root: string, reach: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-unreached-"))
  try {
    const reach = join(root, "reach.sh")
    await reachExiting(reach, exitCode)
    await body(root, reach)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })

const localStub = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
  const real = yield* ChildProcessSpawner.ChildProcessSpawner
  return ChildProcessSpawner.make((command) =>
    ChildProcess.isStandardCommand(command) && command.command === "pueue"
      ? real.spawn(ChildProcess.make("sh", ["-c", "echo '{\"tasks\":{}}'"]))
      : ChildProcess.isStandardCommand(command) && command.command === "orc-quota"
        ? real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + quotaReply + "\nJ"]))
        : real.spawn(command))
})).pipe(Layer.provide(BunServices.layer))

const longStarted = "2026-11-18T10:00:00.000Z"

const startOnReach = async (root: string, reach: string): Promise<void> => {
  const quota = { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", kind: "token-file", tokenFile: "/secrets/main-token" }], floorPercent: 15 }
  await writeFile(join(root, "dispatch.json"), JSON.stringify({ machines: [{ name: "win", slots: 1, start: ["orc", "runner", "start", "--", "sh", reach] }], quota }))
  await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { win: "/checkout" } }] }))
  await run(addTask(root, { title: "Fix the thing", project: "orc", kind: "ship", internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0, created: "2026-11-18T09:00:00.000Z", body: "# Fix the thing\n" }))
  await run(claimTask(root, "orc-1"))
  const first = (await run(listTasks(root))).find((task) => task.spec.id === "orc-1")
  if (first === undefined) {
    throw new Error("the backlog holds no orc-1")
  }
  await run(writeTaken(root, { spec: first.spec, hold: null, parked: null, state: { kind: "started", claim: { beat: "beat-1", machine: "win", account: "main", takenAt: longStarted }, started: { at: longStarted, log: root + "/logs/orc-1.log" } } }))
  await mkdir(join(root, "logs"), { recursive: true })
  await writeFile(backlogPaths(root).unreadFile("orc-1"), longStarted)
}

const openKinds = async (root: string) => (await run(openItems(root))).map((entry) => [entry.item.kind, entry.item.owner])

const beat = (root: string) => Effect.runPromise(runBeat(root, root, quietSources()).pipe(Effect.provide(Layer.merge(BunServices.layer, localStub))))

describe("a dispatch machine orc cannot reach", () => {
  test("a lost ssh read does not close a live run failed and a later read restores its running state", async () => {
    await withReach(255, async (root, reach) => {
      await startOnReach(root, reach)
      const config = await run(readDispatchConfig(join(root, "dispatch.json")))
      const task = await run(findTask(root, "orc-1"))
      const timeoutSpawner = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
        const real = yield* ChildProcessSpawner.ChildProcessSpawner
        return ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) && command.command === "sh"
            ? Effect.never
            : real.spawn(command))
      })).pipe(Layer.provide(BunServices.layer))
      const lost = await Effect.runPromise(Effect.gen(function*() {
        yield* TestClock.setTime(Date.now())
        const fiber = yield* Effect.forkScoped(closeFinished({ root, home: root, config }, task))
        yield* Effect.forkScoped(Effect.forever(TestClock.adjust("1 second")))
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, timeoutSpawner, TestClock.layer())), Effect.scoped))
      expect(lost.kind).toBe("unknown")
      expect(Number.isNaN(Date.parse(await readFile(backlogPaths(root).unreachedFile("orc-1"), "utf8")))).toBe(false)
      expect((await run(findTask(root, "orc-1"))).state.kind).toBe("started")
      expect(await run(openItems(root))).toEqual([])

      const response = JSON.stringify({ schema: "orc.runner.v1", result: { task: "orc-1", status: "running", pueueTask: 11, run: null, started: longStarted } })
      await writeFile(reach, "#!/bin/sh\nprintf '%s\\n' '" + response + "'\n")
      const restored = await run(closeFinished({ root, home: root, config }, await run(findTask(root, "orc-1"))))
      expect(restored.kind).toBe("running")
      expect(await readFile(backlogPaths(root).unreachedFile("orc-1"), "utf8").then(() => "present", () => "absent")).toBe("absent")
      expect((await run(findTask(root, "orc-1"))).state.kind).toBe("started")
    })
  })

  test("a result read that ssh ends with 255 fails as unreached, instead of as a runner refusal", async () => {
    await withReach(255, async (_root, reach) => {
      const failure = await Effect.runPromise(Effect.flip(readResultReaching(["sh", reach], "orc-1")).pipe(Effect.provide(BunServices.layer)))
      expect(failure).toBeInstanceOf(MachineUnreached)
      expect(failure.detail).toContain(closedConnection)
    })
  })

  test("a result read through a reach that does not tell the two apart still fails as a runner refusal", async () => {
    await withReach(255, async (_root, reach) => {
      const failure = await Effect.runPromise(Effect.flip(readResultThrough(["sh", reach], "orc-1")).pipe(Effect.provide(BunServices.layer)))
      expect(failure).toBeInstanceOf(RunnerError)
    })
  })

  test("a result read through ssh bounds its connect below the 30-second close read, instead of letting a machine that never answers end as a timed-out read", async () => {
    await withReach(255, async (root) => {
      const ssh = join(root, "ssh")
      const argv = join(root, "argv")
      await writeFile(ssh, "#!/bin/sh\nprintf '%s\\n' \"$@\" > '" + argv + "'\nexit 255\n")
      await chmod(ssh, 0o755)
      await Effect.runPromise(Effect.flip(readResultReaching([ssh, "box", "orc"], "orc-1")).pipe(Effect.provide(BunServices.layer)))
      const words = (await readFile(argv, "utf8")).trim().split("\n")
      expect(words[0]).toBe("-o")
      expect(words[1]).toMatch(/^ConnectTimeout=\d+$/)
      expect(Number(words[1]?.slice("ConnectTimeout=".length))).toBeLessThan(30)
      expect(words.slice(2, 4)).toEqual(["box", "orc"])
    })
  })

  test("a first unreached beat keeps the task started with no item for the owner, instead of closing it as a died run", async () => {
    await withReach(255, async (root, reach) => {
      await startOnReach(root, reach)
      const report = await beat(root)
      expect(report.actions.map((action) => action.kind)).toEqual([])
      expect((await run(findTask(root, "orc-1"))).state.kind).toBe("started")
      expect(await run(openItems(root))).toEqual([])
    })
  })

  test("a machine unreached past the 10-minute grace opens one item for the owner and keeps the task started, instead of staying silent forever", async () => {
    await withReach(255, async (root, reach) => {
      await startOnReach(root, reach)
      await writeFile(backlogPaths(root).unreachedFile("orc-1"), longStarted)
      await beat(root)
      await beat(root)
      expect((await run(findTask(root, "orc-1"))).state.kind).toBe("started")
      const items = await run(openItems(root))
      expect(items.map((entry) => [entry.item.kind, entry.item.owner])).toEqual([["machine-unreached", "user"]])
      expect(items[0]?.item.text).toContain("win")
      expect(items[0]?.item.text).toContain(closedConnection)
    })
  })

  test("a machine that answers again withdraws its unreached item, instead of leaving the owner a stale alarm", async () => {
    await withReach(255, async (root, reach) => {
      await startOnReach(root, reach)
      await writeFile(backlogPaths(root).unreachedFile("orc-1"), longStarted)
      await beat(root)
      expect(await openKinds(root)).toEqual([["machine-unreached", "user"]])
      await reachExiting(reach, 3)
      await beat(root)
      expect(await openKinds(root)).toEqual([])
    })
  })

  test("an unreached beat restarts the unread grace, instead of closing a run unread before the outage as soon as the machine answers", async () => {
    await withReach(255, async (root, reach) => {
      await startOnReach(root, reach)
      await beat(root)
      await reachExiting(reach, 3)
      await beat(root)
      expect((await run(findTask(root, "orc-1"))).state.kind).toBe("started")
      expect(await openKinds(root)).toEqual([])
    })
  })

  test("a reached machine whose runner refuses past the grace still closes the task as a died run for the owner", async () => {
    await withReach(3, async (root, reach) => {
      await startOnReach(root, reach)
      await beat(root)
      expect((await run(findTask(root, "orc-1"))).state.kind).toBe("closed")
      expect(await openKinds(root)).toEqual([["run-died", "user"]])
    })
  })
})
