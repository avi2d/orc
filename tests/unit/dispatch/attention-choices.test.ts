import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { openRunDeaths, routePullRequest, routeTaskItems } from "../../../packages/run/src/entities/attention/attention"
import { routeFailingCommands } from "../../../packages/run/src/entities/attention/failing-command"
import type { TaskRecord } from "../../../packages/run/src/entities/backlog/index"
import type { PullRequestView } from "../../../packages/run/src/entities/pull-request/pr-view"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const withRoot = async (use: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-attention-choices-"))
  try {
    await use(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

interface StoredItem {
  readonly subject?: string
  readonly options?: ReadonlyArray<{ readonly text: string; readonly outcome?: string }>
  readonly recommendation?: string
}

const stored = async (root: string, id: string): Promise<StoredItem> => JSON.parse(await readFile(join(root, "attention", id + ".json"), "utf8")) as StoredItem

const choices = (item: StoredItem): unknown => ({ subject: item.subject, options: item.options?.map((option) => [option.text, option.outcome]), recommendation: item.recommendation })

const pr = "https://github.com/acme/orc/pull/7"

const head = "a".repeat(40)

const checked = (conclusion: string): PullRequestView => ({
  state: "OPEN",
  headRefOid: head,
  baseRefName: "main",
  statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion, startedAt: "2026-11-20T11:10:00.000Z" }]
})

const heldTask: TaskRecord = {
  spec: { id: "orc-2", title: "Pick the API", project: "orc", kind: "ship", internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: null, created: "2026-11-01T10:00:00.000Z", body: "# Pick the API\n" },
  hold: { reason: "REST or gRPC", until: "2026-11-10", questions: [], answer: null, at: null },
  parked: null,
  state: { kind: "new" }
}

describe("the choices on the items the beat opens", () => {
  test("a run-died item names its run and offers rerun or close, recommending rerun", async () => {
    await withRoot(async (root) => {
      await run(openRunDeaths(root, [{ kind: "closed", task: "orc-1", machine: "mac", outcome: "failed", reason: "exit 1", pr: null, report: null }], "2026-11-20T12:00:00.000Z"))
      expect(choices(await stored(root, "orc-1.run-died"))).toEqual({
        subject: "the run of orc-1 on mac",
        options: [
          ["rerun", "orc backlog add queues the task again, and the next beat starts a new run"],
          ["close", "the task stays closed failed, and no run starts"]
        ],
        recommendation: "rerun"
      })
    })
  })

  test("a check-red item names its PR and offers send back or close, recommending send back", async () => {
    await withRoot(async (root) => {
      await run(routePullRequest(root, "orc-1", pr, checked("FAILURE"), "2026-11-20T12:00:00.000Z"))
      expect(choices(await stored(root, "orc-1.check-red." + head))).toEqual({
        subject: "the PR " + pr + " of orc-1",
        options: [
          ["send back", "orc backlog send-back orc-1 <words> sends the PR back for another pass on the red check"],
          ["close", "the PR stays open with the red check, and nothing merges"]
        ],
        recommendation: "send back"
      })
    })
  })

  test("a pr-ready item names its PR and offers merge or hold, recommending merge", async () => {
    await withRoot(async (root) => {
      await run(routePullRequest(root, "orc-1", pr, checked("SUCCESS"), "2026-11-20T12:00:00.000Z"))
      expect(choices(await stored(root, "orc-1.pr-ready." + head))).toEqual({
        subject: "the PR " + pr + " of orc-1",
        options: [
          ["merge", "orc merge orc-1 merges the PR into main, and the item closes with the answer merged"],
          ["hold", "the PR stays open and unmerged, and the item stays open"]
        ],
        recommendation: "merge"
      })
    })
  })

  test("a failing-command item names the command and offers continue or stop, recommending continue", async () => {
    await withRoot(async (root) => {
      const since = "2026-11-20T12:00:00.000Z"
      await run(routeFailingCommands(root, [{ task: "orc-1", failing: { label: "bash", since } }], since))
      expect(choices(await stored(root, "orc-1.failing-command.2026-11-20T12_00_00_000Z"))).toEqual({
        subject: "the command bash in the run of orc-1",
        options: [
          ["continue", "the run carries on, and orc pauses it to ask if the command fails 6 times in a row"],
          ["stop", "orc backlog stop orc-1 kills the run and closes the task stopped"]
        ],
        recommendation: "continue"
      })
    })
  })

  test("an overdue-wait item names the hold and offers answer or drop, recommending answer", async () => {
    await withRoot(async (root) => {
      await run(routeTaskItems(root, [heldTask], "2026-11-20T12:00:00.000Z"))
      expect(choices(await stored(root, "orc-2.overdue-wait.2026-11-10"))).toEqual({
        subject: "the hold on orc-2: REST or gRPC",
        options: [
          ["answer", "orc backlog answer orc-2 <words> answers the hold, and the task can start"],
          ["drop", "orc backlog drop orc-2 <reason> drops the task, and it never starts"]
        ],
        recommendation: "answer"
      })
    })
  })
})
