import { describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { addTask, claimTask, closeStartedTask, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { runBeat } from "../../../packages/run/src/dispatch/beat"
import { formatBeat } from "../../../packages/run/src/dispatch/board"
import { markEventPosted, unpostedEvents } from "../../../packages/run/src/entities/events/index"
import type { LoadReading } from "../../../packages/run/src/dispatch/load"
import type { PullRequestView } from "../../../packages/run/src/entities/pull-request/pr-view"
import { quietSources, uncheckedOpen } from "../../lib/beat-sources"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-chat-events-"))
  try {
    await writeFile(join(root, "dispatch.json"), JSON.stringify({ machines: [{ name: "mac", slots: 0, start: ["true"] }], quota }))
    await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: "/checkout" } }] }))
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const quota = { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: "/secrets/main-token" }], floorPercent: 15 }

const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })

const commands = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
  const real = yield* ChildProcessSpawner.ChildProcessSpawner
  const reply = (text: string) => real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + text + "\nJ"]))
  return ChildProcessSpawner.make((command) =>
    ChildProcess.isStandardCommand(command) && command.command === "pueue"
      ? reply(JSON.stringify({ tasks: {} }))
      : ChildProcess.isStandardCommand(command) && command.command === "orc-quota" ? reply(quotaReply) : real.spawn(command)
  )
})).pipe(Layer.provide(BunServices.layer))

const unreadLoad = (): Effect.Effect<LoadReading> => Effect.succeed({ kind: "unread", reason: "no load read in a chat event test" })

const beatNow = Date.parse("2026-10-27T12:00:00.000Z")

const beat = (root: string, view: () => PullRequestView = () => uncheckedOpen): Promise<string> =>
  Effect.runPromise(Effect.gen(function*() {
    yield* TestClock.setTime(beatNow)
    return formatBeat(yield* runBeat(root, root, quietSources(unreadLoad, () => Effect.succeed(view()))))
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, commands, TestClock.layer()))))

const unposted = async (root: string): Promise<ReadonlyArray<string>> => (await run(unpostedEvents(root))).map((event) => event.text)

const postAll = async (root: string): Promise<void> => {
  for (const event of await run(unpostedEvents(root))) {
    await run(markEventPosted(root, event.key))
  }
}

const spec = { title: "Fix the login page", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], created: "2026-10-27T10:00:00.000Z", body: "# Fix the login page\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-10-27T10:01:00.000Z" }

const pr = "https://github.com/acme/orc/pull/7"

const closeWithPr = async (root: string): Promise<void> => {
  await run(addTask(root, spec))
  await run(claimTask(root, "task-1"))
  await run(writeTaken(root, { spec: { ...spec, id: "task-1" }, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-10-27T10:02:00.000Z", log: "/tmp/task.log" } } }))
  await run(closeStartedTask(root, "task-1", "done", "", { pr, report: null }, "2026-10-27T11:00:00.000Z"))
}

const green: PullRequestView = {
  ...uncheckedOpen,
  statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-27T11:10:00.000Z" }]
}

const quotaFire = JSON.stringify({
  schemaVersion: 1,
  rule: "quota-pace",
  at: "2026-10-27T11:30:00.000Z",
  account: { provider: "acme", title: "main" },
  window: "weekly",
  windowLabel: "weekly",
  leftPoints: 12,
  elapsedFraction: 0.4,
  resetsAt: "2026-10-30T00:00:00.000Z",
  flags: []
})

const loadFire = JSON.stringify({ schemaVersion: 1, rule: "heavy-load", at: "2026-10-27T11:31:00.000Z", machine: "mac", since: "2026-10-27T11:25:00.000Z", crossed: ["cpu"] })

const longTask = {
  schemaVersion: 1,
  rule: "long-task",
  at: "2026-10-27T11:32:00.000Z",
  reason: "quiet",
  machine: "mac",
  task: { id: "task-9", title: "Port the parser" },
  quietMinutes: 45,
  totalMinutes: 90
}

const longFire = JSON.stringify(longTask)

const fireTexts = [
  "alert: main's weekly runs ahead of pace, 12 points left, resets at 2026-10-30T00:00:00.000Z",
  "alert: mac over its cpu limit since 2026-10-27T11:25:00.000Z",
  "alert: Port the parser (task-9) on mac quiet for 45m"
]

describe("an alert fire", () => {
  test("each fire is listed once instead of once per read or per beat", async () => {
    await withBacklog(async (root) => {
      await writeFile(join(root, "alerts.jsonl"), [quotaFire, loadFire, longFire].join("\n") + "\n")
      expect(await unposted(root)).toEqual(fireTexts)
      await beat(root)
      expect(await unposted(root)).toEqual(fireTexts)
    })
  })
  test("a posted fire stays posted after a restart instead of posting again", async () => {
    await withBacklog(async (root) => {
      await writeFile(join(root, "alerts.jsonl"), quotaFire + "\n")
      await postAll(root)
      await appendFile(join(root, "alerts.jsonl"), loadFire + "\n")
      expect(await unposted(root)).toEqual([fireTexts[1]])
    })
  })
  test("a line the stream wrote twice is listed once instead of posting twice", async () => {
    await withBacklog(async (root) => {
      await writeFile(join(root, "alerts.jsonl"), [quotaFire, quotaFire].join("\n") + "\n")
      expect(await unposted(root)).toEqual([fireTexts[0]])
    })
  })
  test("a line the stream is still writing waits for its newline instead of failing to read", async () => {
    await withBacklog(async (root) => {
      await writeFile(join(root, "alerts.jsonl"), quotaFire + "\n" + loadFire.slice(0, 20))
      expect(await unposted(root)).toEqual([fireTexts[0]])
      await appendFile(join(root, "alerts.jsonl"), loadFire.slice(20) + "\n")
      expect(await unposted(root)).toEqual(fireTexts.slice(0, 2))
    })
  })
  test("a line orc cannot read is posted once as its error instead of stopping every later fire", async () => {
    await withBacklog(async (root) => {
      await writeFile(join(root, "alerts.jsonl"), "{\"rule\":\"unknown\"}\n" + loadFire + "\n")
      const [unread = "", ...rest] = await unposted(root)
      expect(unread).toStartWith("orc cannot read alert line 1 of " + join(root, "alerts.jsonl") + ": ")
      expect(rest).toEqual([fireTexts[1]])
      await postAll(root)
      expect(await unposted(root)).toEqual([])
    })
  })
  test("a retired nightly line posts as its error instead of firing the removed rule", async () => {
    await withBacklog(async (root) => {
      const retired = JSON.stringify({
        rule: "nightly",
        at: "2026-10-27T09:00:00.000Z",
        repo: "example/website",
        workflow: "night-run",
        runId: 101,
        conclusion: "failure",
      })
      await writeFile(join(root, "alerts.jsonl"), retired + "\n" + loadFire + "\n")
      const [unread = "", ...rest] = await unposted(root)
      expect(unread).toStartWith("orc cannot read alert line 1 of " + join(root, "alerts.jsonl") + ": ")
      expect(rest).toEqual([fireTexts[1]])
    })
  })
  test("a key no fire carries is refused instead of marked", async () => {
    await withBacklog(async (root) => {
      await writeFile(join(root, "alerts.jsonl"), quotaFire + "\n")
      const refused = await Effect.runPromise(markEventPosted(root, "alert.quota-pace.0000000000000000").pipe(Effect.flip, Effect.provide(BunServices.layer)))
      expect(refused.detail).toBe("the backlog holds no event alert.quota-pace.0000000000000000")
    })
  })
})

describe("a long task fire", () => {
  test("a total in minutes reads in days and hours instead of thousands of minutes", async () => {
    await withBacklog(async (root) => {
      const total = JSON.stringify({ ...longTask, reason: "total", totalMinutes: 6095.8 })
      await writeFile(join(root, "alerts.jsonl"), total + "\n")
      expect(await unposted(root)).toEqual(["alert: Port the parser (task-9) on mac running for 4d 5h"])
    })
  })
})

describe("a pull request of a task the chat did not add", () => {
  test("an open PR with no checks posts nothing instead of calling it ready", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      await beat(root)
      await beat(root)
      expect(await unposted(root)).toEqual([])
    })
  })
  test("green checks post ready once instead of on every beat", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      await beat(root, () => green)
      await beat(root, () => green)
      expect(await unposted(root)).toEqual(["task-1 Fix the login page PR ready: " + pr + ", checks green: test"])
    })
  })
  test("a merge posts once and the PR is read no more instead of being polled forever", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      let reads = 0
      const merged = () => {
        reads += 1
        return { ...green, state: "MERGED" }
      }
      await beat(root, merged)
      await beat(root, merged)
      expect(await unposted(root)).toEqual(["task-1 Fix the login page merged: " + pr])
      expect(reads).toBe(1)
    })
  })
  test("a PR closed without merging posts once instead of reading as merged", async () => {
    await withBacklog(async (root) => {
      await closeWithPr(root)
      await beat(root, () => ({ ...uncheckedOpen, state: "CLOSED" }))
      await beat(root, () => ({ ...uncheckedOpen, state: "CLOSED" }))
      expect(await unposted(root)).toEqual(["task-1 Fix the login page PR closed without merging: " + pr])
    })
  })
})
