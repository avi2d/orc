import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { answerItem, routePullRequest, taskItems } from "../../../packages/run/src/entities/attention/index"
import { addTask, claimTask, closeStartedTask, listTasks, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { ownerWordChanges, readChangedFiles, type ChangedFile, type PullRequestView } from "../../../packages/run/src/entities/pull-request/index"
import { beatReady } from "../../../packages/run/src/widgets/beat/yolo-merge"
import { prEvents } from "../../../packages/run/src/widgets/beat/task-events"

const check = (conclusion: string) => ({ name: "test", workflowName: "ci", status: "COMPLETED", conclusion, startedAt: "2026-11-18T10:00:00Z" })

const view = (conclusion = "SUCCESS", state = "OPEN"): PullRequestView =>
  ({ state, headRefOid: "0".repeat(40), baseRefName: "main", statusCheckRollup: [check(conclusion)] })

const changed = (path: string, status = "modified", version = false, previous?: string): ChangedFile =>
  previous === undefined ? { status, path, version } : { status, path, previous, version }

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = { title: "Tidy the docs", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-11-18T10:00:00Z", body: "# Tidy the docs\n" }

const claim = { beat: "beat-1", machine: "mac", account: "main", takenAt: "2026-11-18T10:01:00.000Z" }

const started = { at: "2026-11-18T10:02:00.000Z", log: "/tmp/task.log" }

const pr = "https://github.com/acme/orc/pull/8"

const withBacklog = async (yolo: boolean, body: (root: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-yolo-"))
  const root = join(home, "backlog")
  try {
    await mkdir(root)
    await writeFile(join(root, "dispatch.json"), JSON.stringify({ machines: [{ name: "mac", slots: 1, start: ["true"] }], quota: { provider: "acme", command: ["true"], accounts: [{ name: "main", tokenFile: "/x" }] } }))
    await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: root }, yolo }] }))
    await body(root)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const closeWith = async (root: string, outcome: "done" | "failed" | "stopped"): Promise<void> => {
  await run(addTask(root, spec))
  await run(claimTask(root, "task-1"))
  await run(writeTaken(root, { spec: { ...spec, id: "task-1" }, hold: null, parked: null, state: { kind: "started", claim, started } }))
  await run(closeStartedTask(root, "task-1", outcome, "", { pr, report: null }, "2026-11-18T11:00:00.000Z"))
}

const taskOf = async (root: string) => {
  const task = (await run(listTasks(root))).find((candidate) => candidate.spec.id === "task-1")
  if (task === undefined) {
    throw new Error("task-1 missing from the backlog")
  }
  return task
}

const ghLayer = (current: PullRequestView, files: string | null, merges: Array<string>): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    const reply = (text: string) => real.spawn(ChildProcess.make("sh", ["-c", "cat <<'J'\n" + text + "\nJ"]))
    const refusal = () => real.spawn(ChildProcess.make("sh", ["-c", "echo fail >&2; exit 1"]))
    return ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command) || command.command !== "gh") {
        return real.spawn(command)
      }
      const args = command.args
      const text = "gh " + args.join(" ")
      if (args[0] === "pr" && args[1] === "view") {
        return reply(JSON.stringify({ state: current.state, headRefOid: current.headRefOid, baseRefName: current.baseRefName, statusCheckRollup: current.statusCheckRollup }))
      }
      if (text.includes("/pulls/") && text.includes("/files")) {
        return files === null ? refusal() : reply(files)
      }
      if (text.includes("/compare/")) {
        return reply(JSON.stringify({ behind_by: 0, base_commit: { sha: "1".repeat(40) }, merge_base_commit: { sha: "1".repeat(40) }, files: [] }))
      }
      if (args[0] === "pr" && args[1] === "merge") {
        merges.push(text)
        return reply("")
      }
      return real.spawn(command)
    })
  })).pipe(Layer.provide(BunServices.layer))

const beatAction = async (root: string, current: PullRequestView, yolo: boolean, files: string | null, merges: Array<string>) => {
  const task = await taskOf(root)
  return Effect.runPromise(prEvents(root, task, () => Effect.succeed(current), "2026-11-18T11:10:00.000Z", yolo, dirname(root)).pipe(Effect.provide(Layer.merge(BunServices.layer, ghLayer(current, files, merges)))))
}

const holdReady = async (root: string, current: PullRequestView): Promise<void> => {
  await run(routePullRequest(root, "task-1", pr, current, "2026-11-18T11:01:00.000Z"))
  const ready = (await run(taskItems(root, "task-1"))).find((entry) => entry.item.kind === "pr-ready" && entry.item.state.kind === "open")
  if (ready === undefined) {
    throw new Error("task-1 has no open pr-ready item")
  }
  expect(await run(answerItem(root, ready.id, { words: "hold", at: "2026-11-18T11:02:00.000Z" }))).toBe("closed")
}

const filesOf = (rows: ReadonlyArray<Record<string, unknown>>): string => rows.map((row) => JSON.stringify(row)).join("\n")

const workflowFiles = filesOf([{ status: "modified", path: ".github/workflows/ci.yml", previous: null, patch: "+on: push" }])

const noFiles = filesOf([{ status: "modified", path: "src/example.ts", previous: null, patch: "+example" }])

describe("the beat merges a yolo project's green PR", () => {
  test("a green open PR of a yolo project is ready instead of waiting for the captain", () => {
    expect(beatReady(true, view())).toBe(true)
    expect(ownerWordChanges([changed("packages/run/src/a.ts"), changed("docs/a.md", "added")])).toEqual([])
  })

  test("a red PR waits instead of being merged", () => {
    expect(beatReady(true, view("FAILURE"))).toBe(false)
  })

  test("a PR whose check has not reported waits instead of being merged", () => {
    expect(beatReady(true, { ...view(), statusCheckRollup: [{ ...check(""), status: "IN_PROGRESS" }] })).toBe(false)
  })

  test("a no-yolo project's green PR waits instead of being merged", () => {
    expect(beatReady(false, view())).toBe(false)
  })

  test("a workflow change waits for the captain instead of being merged", () => {
    expect(ownerWordChanges([changed(".github/workflows/ci.yml")])).toEqual([
      "changes the workflow file .github/workflows/ci.yml, which waits for the captain's merge word"
    ])
  })

  test("a release, a deletion and a secret change wait for the captain instead of being merged", () => {
    expect(ownerWordChanges([changed("CHANGELOG.md"), changed("packages/run/package.json", "modified", true), changed("src/old.ts", "removed"), changed(".env.production")])).toEqual([
      "is a release, as it changes CHANGELOG.md, packages/run/package.json, which waits for the captain's merge word",
      "deletes src/old.ts, which waits for the captain's merge word",
      "changes the secret file .env.production, which waits for the captain's merge word"
    ])
  })

  test("a package.json change that keeps the version merges instead of reading as a release", () => {
    expect(ownerWordChanges([changed("package.json")])).toEqual([])
  })

  test("a workflow file moved away still waits instead of merging as a docs change", () => {
    expect(ownerWordChanges([changed("docs/deploy.yml.bak", "renamed", false, ".github/workflows/deploy.yml")])).toEqual([
      "changes the workflow file .github/workflows/deploy.yml->docs/deploy.yml.bak, which waits for the captain's merge word"
    ])
  })

  test("a secret file moved away still waits instead of merging as a rename", () => {
    expect(ownerWordChanges([changed("docs/notes.md", "renamed", false, ".env.production")])).toEqual([
      "changes the secret file .env.production->docs/notes.md, which waits for the captain's merge word"
    ])
  })

  for (const { label, patch } of [
    { label: "missing patch", patch: undefined },
    { label: "null patch", patch: null },
    { label: "version patch", patch: '-  "version": "1.0.0",\n+  "version": "1.1.0",' }
  ]) {
    test("a package.json release with version false is not accepted as an ordinary edit: " + label, async () => {
      const layer = ghLayer(view(), filesOf([{ status: "modified", path: "package.json", previous: null, patch, version: false }]), [])
      const files = await Effect.runPromise(readChangedFiles(pr).pipe(Effect.provide(Layer.merge(BunServices.layer, layer))))
      expect(ownerWordChanges(files)).toEqual([
        "is a release, as it changes package.json, which waits for the captain's merge word"
      ])
    })
  }

  test("a readable package.json dependency patch is not refused as a release", async () => {
    const layer = ghLayer(view(), filesOf([{ status: "modified", path: "package.json", patch: '-  "effect": "4.0.0"\n+  "effect": "4.0.1"' }]), [])
    const files = await Effect.runPromise(readChangedFiles(pr).pipe(Effect.provide(Layer.merge(BunServices.layer, layer))))
    expect(ownerWordChanges(files)).toEqual([])
  })
})

describe("the beat gate around the merge", () => {
  test("a held green PR on a yolo project is not merged", async () => {
    await withBacklog(true, async (root) => {
      await closeWith(root, "done")
      await holdReady(root, view())
      const merges: Array<string> = []
      for (let beat = 0; beat < 2; beat += 1) {
        expect(Option.isNone(await beatAction(root, view(), true, noFiles, merges))).toBe(true)
      }
      expect(merges).toEqual([])
    })
  })

  test("a held PR is not merged when its checks turn red then green on the same head", async () => {
    await withBacklog(true, async (root) => {
      await closeWith(root, "done")
      await holdReady(root, view())
      const merges: Array<string> = []
      await beatAction(root, view("FAILURE"), true, noFiles, merges)
      expect(Option.isNone(await beatAction(root, view(), true, noFiles, merges))).toBe(true)
      expect(merges).toEqual([])
    })
  })

  test("a hold on an older head does not prevent a new green head from merging", async () => {
    await withBacklog(true, async (root) => {
      await closeWith(root, "done")
      await holdReady(root, view())
      const merges: Array<string> = []
      const current = { ...view(), headRefOid: "1".repeat(40) }
      await beatAction(root, current, true, noFiles, merges)
      expect(merges).toEqual(["gh pr merge " + pr + " --squash --match-head-commit " + current.headRefOid])
    })
  })

  test("a green yolo PR merges instead of staying open", async () => {
    await withBacklog(true, async (root) => {
      await closeWith(root, "done")
      const merges: Array<string> = []
      const action = await beatAction(root, view(), true, noFiles, merges)
      expect(Option.isSome(action)).toBe(true)
      expect(merges.length).toBe(1)
    })
  })

  test("a red PR stays unmerged instead of auto-merging", async () => {
    await withBacklog(true, async (root) => {
      await closeWith(root, "done")
      const merges: Array<string> = []
      const action = await beatAction(root, view("FAILURE"), true, noFiles, merges)
      expect(Option.isNone(action)).toBe(true)
      expect(merges).toEqual([])
    })
  })

  test("a no-yolo project's green PR stays unmerged instead of auto-merging", async () => {
    await withBacklog(false, async (root) => {
      await closeWith(root, "done")
      const merges: Array<string> = []
      const action = await beatAction(root, view(), false, noFiles, merges)
      expect(Option.isNone(action)).toBe(true)
      expect(merges).toEqual([])
    })
  })

  test("a workflow change stays unmerged instead of auto-merging", async () => {
    await withBacklog(true, async (root) => {
      await closeWith(root, "done")
      const merges: Array<string> = []
      const action = await beatAction(root, view(), true, workflowFiles, merges)
      expect(Option.isNone(action)).toBe(true)
      expect(merges).toEqual([])
    })
  })

  test("a stopped task with a green PR stays unmerged instead of auto-merging", async () => {
    await withBacklog(true, async (root) => {
      await closeWith(root, "stopped")
      const merges: Array<string> = []
      const action = await beatAction(root, view(), true, noFiles, merges)
      expect(Option.isNone(action)).toBe(true)
      expect(merges).toEqual([])
    })
  })

  test("a PR whose files cannot be read stays unmerged instead of auto-merging", async () => {
    await withBacklog(true, async (root) => {
      await closeWith(root, "done")
      const merges: Array<string> = []
      const action = await beatAction(root, view(), true, null, merges)
      expect(Option.isSome(action)).toBe(true)
      expect(merges).toEqual([])
    })
  })
})
