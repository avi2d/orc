import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { listTasks, BacklogError } from "../../../packages/run/src/entities/backlog/index"
import { runBeat } from "../../../packages/run/src/widgets/beat/beat"
import { formatBeat } from "../../../packages/run/src/widgets/beat/board"
import type { LoadReading } from "../../../packages/run/src/widgets/beat/load"
import { unpostedEvents } from "../../../packages/run/src/entities/events/index"
import { changesOf, type ReadUpstream, readUpstream, type UpstreamState } from "../../../packages/run/src/widgets/beat/upstream"
import { quietSources } from "../../lib/beat-sources"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const pull = "https://github.com/acme/widgets/pull/7"
const issue = "https://github.com/acme/widgets/issues/9"

const quota = { provider: "keyed", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: "/secrets/main-token" }], floorPercent: 15 }

const withBacklog = async (upstream: ReadonlyArray<string> | null, body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-upstream-"))
  try {
    await writeFile(join(root, "dispatch.json"), JSON.stringify({ machines: [{ name: "mac", slots: 0, start: ["true"] }], quota }))
    const project = { name: "orc", checkouts: { mac: "/checkout" }, ...(upstream === null ? {} : { upstream }) }
    await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [project] }))
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const quotaReply = JSON.stringify({ schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] })

const reply = (real: ChildProcessSpawner.ChildProcessSpawner["Service"], text: string, exit = 0) =>
  real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + text + "\nJ\nexit " + String(exit)]))

const commands = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
  const real = yield* ChildProcessSpawner.ChildProcessSpawner
  return ChildProcessSpawner.make((command) =>
    ChildProcess.isStandardCommand(command) && command.command === "pueue"
      ? reply(real, JSON.stringify({ tasks: {} }))
      : ChildProcess.isStandardCommand(command) && command.command === "orc-quota" ? reply(real, quotaReply) : real.spawn(command)
  )
})).pipe(Layer.provide(BunServices.layer))

const unreadLoad = (): Effect.Effect<LoadReading> => Effect.succeed({ kind: "unread", reason: "no load read in an upstream test" })

const beat = (root: string, read: ReadUpstream): Promise<string> =>
  Effect.runPromise(Effect.gen(function*() {
    yield* TestClock.setTime(Date.parse("2026-11-03T12:00:00.000Z"))
    return formatBeat(yield* runBeat(root, root, quietSources(unreadLoad, undefined, read)))
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, commands, TestClock.layer()))))

const reads = (state: UpstreamState): ReadUpstream => () => Effect.succeed(state)

const upstreamLines = (board: string): ReadonlyArray<string> =>
  board.split("\n").filter((line) => line.startsWith("watching ") || line.startsWith("added ") || line.startsWith("upstream of "))

const head = "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c"
const openPull: UpstreamState = { kind: "pull", state: "OPEN", comments: 2, reviews: 0, head }
const mergedPull: UpstreamState = { ...openPull, state: "MERGED", comments: 3 }

const seenFile = (root: string): string => join(root, "upstream", "orc", "acme.widgets.7.json")

describe("the beat's upstream watch", () => {
  test("first sight records the state and adds no task instead of following up on what was always there", async () => {
    await withBacklog([pull], async (root) => {
      expect(upstreamLines(await beat(root, reads(openPull)))).toEqual(["watching " + pull + " for orc: open, 2 comments, 0 reviews, head 1f2e3d4"])
      expect(await run(listTasks(root))).toEqual([])
      expect(JSON.parse(await readFile(seenFile(root), "utf8"))).toEqual({ url: pull, state: openPull, changes: 0 })
    })
  })

  test("a changed contribution adds one scout task naming it and the change instead of none or one per field", async () => {
    await withBacklog([pull], async (root) => {
      await beat(root, reads(openPull))
      expect(upstreamLines(await beat(root, reads(mergedPull)))).toEqual(["added orc-1 for orc as a scout: " + pull + " changed: merged, 1 new comment"])
      const tasks = await run(listTasks(root))
      expect(tasks.map((task) => [task.spec.id, task.spec.kind, task.spec.project, task.spec.title, task.state.kind])).toEqual([
        ["orc-1", "scout", "orc", "Follow up on acme/widgets#7: merged, 1 new comment", "new"]
      ])
      expect(tasks[0]?.spec.body).toContain("The upstream pull request " + pull + ", which projects.json names for orc, changed since the last beat read it: merged, 1 new comment.")
      expect((await run(unpostedEvents(root))).map((event) => event.text)).toEqual(["upstream " + pull + " of orc changed: merged, 1 new comment"])
    })
  })

  test("a repeat beat on the same state adds no second task instead of following up again", async () => {
    await withBacklog([pull], async (root) => {
      await beat(root, reads(openPull))
      await beat(root, reads(mergedPull))
      expect(upstreamLines(await beat(root, reads(mergedPull)))).toEqual([])
      expect((await run(listTasks(root))).length).toBe(1)
    })
  })

  test("a beat whose record still holds the old state adds no second task for a change already claimed instead of trusting the stale record", async () => {
    await withBacklog([pull], async (root) => {
      await beat(root, reads(openPull))
      const stale = await readFile(seenFile(root), "utf8")
      await beat(root, reads(mergedPull))
      await writeFile(seenFile(root), stale)
      expect(upstreamLines(await beat(root, reads(mergedPull)))).toEqual([])
      expect((await run(listTasks(root))).length).toBe(1)
      expect(JSON.parse(await readFile(seenFile(root), "utf8"))).toEqual({ url: pull, state: mergedPull, changes: 1 })
    })
  })

  test("a second change adds a second task instead of being taken for the first", async () => {
    await withBacklog([pull], async (root) => {
      await beat(root, reads(openPull))
      await beat(root, reads(mergedPull))
      expect(upstreamLines(await beat(root, reads({ ...mergedPull, comments: 5 })))).toEqual(["added orc-2 for orc as a scout: " + pull + " changed: 2 new comments"])
    })
  })

  test("an unreadable contribution is reported and adds no task instead of failing the beat or recording a state", async () => {
    await withBacklog([pull], async (root) => {
      const offline: ReadUpstream = (contribution) => Effect.fail(new BacklogError({ detail: "cannot read " + contribution.url + ": error connecting to api.github.com" }))
      expect(upstreamLines(await beat(root, offline))).toEqual(["upstream of orc: cannot read " + pull + ": error connecting to api.github.com"])
      expect(await run(listTasks(root))).toEqual([])
      await beat(root, reads(openPull))
      expect(upstreamLines(await beat(root, offline))).toHaveLength(1)
      expect(await run(listTasks(root))).toEqual([])
    })
  })

  test("a record orc cannot read is reported instead of watched afresh", async () => {
    await withBacklog([pull], async (root) => {
      await beat(root, reads(openPull))
      await writeFile(seenFile(root), "{")
      const lines = upstreamLines(await beat(root, reads(mergedPull)))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toStartWith("upstream of orc: " + seenFile(root) + " holds no upstream state orc reads, so remove it to watch afresh")
      expect(await run(listTasks(root))).toEqual([])
    })
  })

  test("a URL respelled in another case keeps its recorded state instead of being seen afresh", async () => {
    await withBacklog([pull], async (root) => {
      await beat(root, reads(openPull))
      const respelled = "https://github.com/Acme/Widgets/pull/7"
      await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: "/checkout" }, upstream: [respelled] }] }))
      expect(upstreamLines(await beat(root, reads(openPull)))).toEqual([])
      expect(upstreamLines(await beat(root, reads(mergedPull)))).toEqual(["added orc-1 for orc as a scout: " + respelled + " changed: merged, 1 new comment"])
    })
  })

  test("a project without upstream reads nothing upstream instead of asking gh", async () => {
    await withBacklog(null, async (root) => {
      expect(upstreamLines(await beat(root, () => Effect.die("read")))).toEqual([])
    })
  })

  test("an issue's state names its comments instead of a pull request's reviews and head", async () => {
    await withBacklog([issue], async (root) => {
      expect(upstreamLines(await beat(root, reads({ kind: "issue", state: "OPEN", comments: 1 })))).toEqual(["watching " + issue + " for orc: open, 1 comment"])
    })
  })
})

describe("changesOf", () => {
  test.each<[string, UpstreamState, ReadonlyArray<string>]>([
    ["a closed pull request", { ...openPull, state: "CLOSED" }, ["closed"]],
    ["new commits", { ...openPull, head: "9".repeat(40) }, ["new head 9999999"]],
    ["a new review", { ...openPull, reviews: 1 }, ["1 new review"]],
    ["a deleted comment", { ...openPull, comments: 1 }, ["1 comment gone"]]
  ])("names %s as a change instead of reading it as the same state", (_, after, changes) => {
    expect(changesOf(openPull, after)).toEqual(changes)
  })
  test("reads the same state as no change instead of following it up", () => {
    expect(changesOf(openPull, { ...openPull })).toEqual([])
  })
  test("names a reopened issue instead of calling it closed", () => {
    expect(changesOf({ kind: "issue", state: "CLOSED", comments: 0 }, { kind: "issue", state: "OPEN", comments: 0 })).toEqual(["reopened"])
  })
})

const ghAnswering = (stdout: string, exit: number, asked: Array<ReadonlyArray<string>>) =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command) && command.command === "gh") {
        asked.push(command.args)
        return reply(real, stdout, exit)
      }
      return real.spawn(command)
    })
  })).pipe(Layer.provide(BunServices.layer))

const readThrough = (stdout: string, exit: number, asked: Array<ReadonlyArray<string>>, url: string, owner: string, number: number) =>
  Effect.runPromise(readUpstream({ url, owner, repo: "orc", number }).pipe(
    Effect.catchTag("BacklogError", (error) => Effect.succeed(error.detail)),
    Effect.provide(Layer.merge(BunServices.layer, ghAnswering(stdout, exit, asked)))
  ))

describe("readUpstream", () => {
  test("reads a pull request's state, counts and head from gh's GraphQL reply", async () => {
    const asked: Array<ReadonlyArray<string>> = []
    const answer = JSON.stringify({ data: { repository: { issueOrPullRequest: { type: "PullRequest", state: "MERGED", headRefOid: "389855af53621b7c49f17226559a089a4d456537", comments: { totalCount: 0 }, reviews: { totalCount: 0 } } } } })
    expect(await readThrough(answer, 0, asked, "https://github.com/avi2d/orc/pull/77", "avi2d", 77)).toEqual({ kind: "pull", state: "MERGED", comments: 0, reviews: 0, head: "389855af53621b7c49f17226559a089a4d456537" })
    expect(asked[0]?.slice(0, 2)).toEqual(["api", "graphql"])
    expect(asked[0]?.slice(4)).toEqual(["-f", "owner=avi2d", "-f", "repo=orc", "-F", "number=77"])
  })
  test("hands a numeric owner to gh as a string instead of letting -F turn it into a number", async () => {
    const asked: Array<ReadonlyArray<string>> = []
    const answer = JSON.stringify({ data: { repository: { issueOrPullRequest: { type: "Issue", state: "OPEN", comments: { totalCount: 4 } } } } })
    expect(await readThrough(answer, 0, asked, "https://github.com/1234/orc/issues/3", "1234", 3)).toEqual({ kind: "issue", state: "OPEN", comments: 4 })
    expect(asked[0]).toContain("owner=1234")
    expect(asked[0]?.[asked[0].indexOf("owner=1234") - 1]).toBe("-f")
  })
  test("reports gh's refusal for a missing contribution instead of reading it as unchanged", async () => {
    const asked: Array<ReadonlyArray<string>> = []
    const said = "gh: Could not resolve to an issue or pull request with the number of 99999."
    expect(await readThrough(said, 1, asked, "https://github.com/avi2d/orc/issues/99999", "avi2d", 99999)).toBe("cannot read https://github.com/avi2d/orc/issues/99999: " + said)
  })
})
