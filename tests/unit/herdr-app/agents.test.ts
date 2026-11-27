import { describe, expect, test } from "bun:test"
import { type StepTab, buildCards, cardAnswers, filterCards, lastTab, openedFilter, projectsOf, railLabel, sendBackArgs, stepTabs } from "../../../packages/herdr-app/src/agents"
import { durationLabel, rowFacts, shortModel, shortTitle, vendorOf } from "../../../packages/herdr-app/src/agent-row"
import { namedModels, opensTurns, runFacts } from "../../../packages/herdr-app/src/run-agent"
import { projectMenu } from "../../../packages/herdr-app/src/run-menus"
import type { Backlog, Run, Runs, Task } from "../../../packages/herdr-app/src/guard"
import type { InboxAnswer, InboxApproval } from "../../../packages/herdr-app/src/inbox"
import { askText } from "../../../packages/herdr-app/src/thread"

const run = (id: string, fields: Partial<Run>): Run => ({
  id, project: "/work/orc", branch: `orc/x-${id}`, status: "running", prLink: null, title: `run ${id}`, step: null, questions: 0, endReason: null, kind: null, delivery: null, worktree: null, ...fields
})

const task = (id: string, fields: Partial<Task>): Task => ({
  id, title: `task ${id}`, project: "orc", kind: "ship", status: "new", hold: null, parked: null, parkedOrigin: null, retriedRun: null, reason: null, prState: null, ...fields
})

const runs = (list: ReadonlyArray<Run>): Runs => ({ schema: "orc.runs.v1", runs: list })
const backlog = (tasks: ReadonlyArray<Task>, merged: ReadonlyArray<string> = [], projects: Backlog["projects"] = null): Backlog => ({ schema: "orc.backlog.v1", tasks, merged, projects })
const configured = (...names: ReadonlyArray<string>): Backlog["projects"] => names.map((name) => ({ name, paths: [] }))

const answer = (id: string, who: InboxAnswer["who"] = "worker"): InboxAnswer => ({
  key: `${id}/question`, kind: "question", task: id, title: `task ${id}`, who, asked: null,
  ask: askText("Which layout?"), recommendation: null, action: { kind: "answer", target: { kind: "question", id: "ask-1" } }
})

const approval: InboxApproval = {
  key: "orc-48/pr", kind: "pr", task: "orc-48", title: "task orc-48", who: "beat", asked: null,
  link: "https://github.com/o/r/pull/48", ask: askText("Merge the PR https://github.com/o/r/pull/48?"), recommendation: null,
  action: { kind: "merge", argv: ["merge", "orc-48", "--basis", "captain-word"] }
}

const board = buildCards(
  runs([
    run("20261113-090000-aaaaaa", { status: "succeeded", branch: "orc/orc-48", prLink: "https://github.com/o/r/pull/48" }),
    run("20261113-080000-bbbbbb", { status: "failed", endReason: "orc exited 1" }),
    run("20261113-070000-cccccc", { status: "running", step: { id: 4, name: "fix", attempt: 1, status: "running" } }),
    run("20261113-060000-dddddd", { status: "running", questions: 1, branch: "orc/herdr-1", project: "/work/herdr" }),
    run("20261113-050000-eeeeee", { status: "succeeded", prLink: "https://github.com/o/r/pull/12" })
  ]),
  backlog([task("orc-48", { status: "closed" }), task("orc-50", {}), task("herdr-1", { project: "herdr" })]),
  [approval, answer("herdr-1")]
)

describe("sending a PR back", () => {
  test("a sent-back conflict names the conflict on its Sent back card instead of turning into an approval the captain cannot press", () => {
    const id = "20261113-090000-aaaaaa"
    const prRun = run(id, { status: "succeeded", branch: "orc/orc-48", prLink: approval.link })
    const cards = buildCards(runs([prRun]), backlog([task("orc-48", { status: "new", parked: 0, parkedOrigin: id, merge: { stage: "conflicted", detail: "main" } })]))
    expect(cards.map((card) => [card.standing.status, card.where])).toEqual([
      ["Queued", "Waiting to start"],
      ["Done", "Sent back PR #48: Merge conflict"]
    ])
  })
  test("a sent-back red check names the failed check stage instead of a bare Sent back", () => {
    const id = "20261113-090000-aaaaaa"
    const prRun = run(id, { status: "succeeded", branch: "orc/orc-48", prLink: approval.link })
    const cards = buildCards(runs([prRun]), backlog([task("orc-48", { status: "new", parked: 0, parkedOrigin: id, merge: { stage: "check-failed", detail: "ci/test" } })]))
    expect(cards.map((card) => card.where)).toContain("Sent back PR #48: Check failed")
  })
  test("the approval card retains each recorded merge stage instead of showing only a generic merge", () => {
    const prRun = run("20261113-090000-aaaaaa", { status: "succeeded", branch: "orc/orc-48", prLink: approval.link })
    for (const stage of ["updating", "checks-running", "conflicted", "check-failed", "merged"] as const) {
      const [card] = buildCards(runs([prRun]), backlog([task("orc-48", { status: "closed", merge: { stage, detail: null } })]), [approval])
      expect(card.merge).toEqual({ stage, detail: null })
    }
  })
  const prRun = run("20261113-090000-aaaaaa", { status: "succeeded", branch: "orc/orc-48", prLink: "https://github.com/o/r/pull/48" })

  test("a closed task's open PR offers send-back with the captain's words, not an empty review", () => {
    const [card] = buildCards(runs([prRun]), backlog([task("orc-48", { status: "closed" })]), [approval])
    expect(card.sendBack).toBe("orc-48")
    expect(sendBackArgs({ sendBack: "orc-48" }, "  rename the flag ")).toEqual(["backlog", "send-back", "orc-48", "rename the flag"])
    expect(sendBackArgs({ sendBack: "orc-48" }, "   ")).toBeNull()
  })

  test("a merged PR offers no send-back instead of restarting a finished task", () => {
    const [card] = buildCards(runs([prRun]), backlog([task("orc-48", { status: "closed" })], ["orc-48"]))
    expect(card.sendBack).toBeNull()
  })

  test("a task still running toward its close offers no send-back that orc would refuse", () => {
    const [card] = buildCards(runs([prRun]), backlog([task("orc-48", { status: "started" })]))
    expect(card.sendBack).toBeNull()
  })

  test("a sent-back PR's old run reads Sent back, not still awaiting approval", () => {
    const cards = buildCards(runs([prRun]), backlog([task("orc-48", { status: "new", parked: 0, parkedOrigin: prRun.id })]))
    expect(cards.map((card) => [card.id, card.standing.status, card.where, card.sendBack])).toEqual([
      ["orc-48", "Queued", "Waiting to start", null],
      ["orc-48", "Done", "Sent back PR #48", null]
    ])
  })

  test("a retried run reads Retried once its resumed run starts, not Sent back as an older run", () => {
    const resumed = run("20261113-100000-bbbbbb", { branch: "orc/orc-48", step: { id: 1, name: "implement", attempt: 1, status: "running" } })
    const cards = buildCards(runs([resumed, prRun]), backlog([task("orc-48", { status: "started", parked: 0, parkedOrigin: prRun.id, retriedRun: prRun.id })]))
    expect(cards.map((card) => [card.runId, card.standing.status, card.where])).toEqual([
      [resumed.id, "Running", "Agent"],
      [prRun.id, "Done", "Retried PR #48"]
    ])
  })

  test("a succeeded run with no open attention record does not still ask for approval", () => {
    const cards = buildCards(runs([prRun]), backlog([task("orc-48", { status: "closed", prState: "open" })]))
    expect(cards.map((card) => [card.standing.status, card.where])).toEqual([["Done", "PR #48"]])
  })
})

describe("the runs list", () => {
  test("two runs of one task do not share a rail label", () => {
    const cards = buildCards(
      runs([run("20261113-090000-aaaaaa", { branch: "orc/orc-7", status: "failed" }), run("20261113-080000-bbbbbb", { branch: "orc/orc-7", status: "failed" })]),
      backlog([task("orc-7", { status: "new" })])
    )
    expect(cards.map(railLabel).sort()).toEqual(["aaaaaa", "bbbbbb", "orc-7"])
  })

  test("sorts Awaiting you, Running, Queued, Failed, Done instead of newest first", () => {
    expect(board.map((card) => card.standing.status)).toEqual(["Awaiting you", "Awaiting you", "Running", "Queued", "Failed", "Done"])
  })

  test("says where each run is now rather than its raw status", () => {
    expect(board.map((card) => card.where)).toEqual(["Approve PR #48", "Worker asks a question", "Fix", "Waiting to start", "orc exited 1", "PR #12"])
  })

  test("a run started outside the backlog carries no kind rather than a made-up one", () => {
    const cards = buildCards(runs([run("20261113-090000-aaaaaa", { status: "failed", branch: "orc/20261113-090000-aaaaaa" })]), backlog([]))
    expect(cards.map((card) => [card.id, card.kind])).toEqual([["20261113-090000-aaaaaa", null]])
  })

  test("a backlog task's run carries the task's kind, not the run's", () => {
    const cards = buildCards(runs([run("20261113-090000-aaaaaa", { branch: "orc/orc-7" })]), backlog([task("orc-7", { kind: "scout", status: "claimed" })]))
    expect(cards.map((card) => [card.id, card.kind])).toEqual([["orc-7", "scout"]])
  })

  test("a failed run with an open follow up task stays Failed while the task queues its resumption", () => {
    const cards = buildCards(
      runs([run("20261113-090000-aaaaaa", { status: "failed", branch: "orc/orc-7", endReason: "old", questions: 0 })]),
      backlog([task("orc-7", { status: "new" })])
    )
    expect(cards.map((card) => [card.id, card.runId, card.standing.status])).toEqual([["orc-7", null, "Queued"], ["orc-7", "20261113-090000-aaaaaa", "Failed"]])
  })

  test("a parked task with an open question keeps its own card beside its failed run", () => {
    const cards = buildCards(
      runs([run("20261113-090000-aaaaaa", { status: "failed", branch: "orc/orc-7", endReason: "old" })]),
      backlog([task("orc-7", { status: "new", parked: 1 })]),
      [answer("orc-7")]
    )
    expect(cards.map((card) => [card.id, card.runId, card.standing.status])).toEqual([["orc-7", null, "Awaiting you"], ["orc-7", "20261113-090000-aaaaaa", "Failed"]])
    expect(cards.filter((card) => card.standing.status === "Awaiting you").map((card) => card.where)).toEqual(["Worker asks a question"])
  })

  test("a stale run count does not leave an answered question's card Awaiting you", () => {
    const running = run("20261113-090000-aaaaaa", { branch: "orc/orc-7", questions: 1 })
    const [card] = buildCards(runs([running]), backlog([task("orc-7", { status: "started", parked: 1 })]), [])
    expect(card.standing.status).toBe("Running")
  })

  test("a live question belongs to its waiting run and not also to a task card with no run", () => {
    const running = run("20261113-090000-aaaaaa", { branch: "orc/orc-7", questions: 1 })
    const question = answer("orc-7")
    const cards = buildCards(runs([running]), backlog([task("orc-7", { status: "started", parked: 1 })]), [question])
    expect(cards.map((card) => [card.runId, card.standing.status, cardAnswers(card)])).toEqual([[running.id, "Awaiting you", [question]]])
  })

  test("parked question counts alone do not put an agent-owned question in Awaiting you", () => {
    const cards = buildCards(runs([]), backlog([task("orc-7", { status: "new", parked: 2 })]), [])
    expect(cards.map((card) => [card.id, card.standing.status])).toEqual([["orc-7", "Queued"]])
  })

  test("a recorded approval without a local run is not missing from the Agents tab", () => {
    const cards = buildCards(runs([]), backlog([task("orc-48", { status: "closed" })]), [approval])
    expect(cards.map((card) => [card.id, card.standing.status, card.where])).toEqual([["orc-48", "Awaiting you", "Approve PR #48"]])
  })

  test("a run whose PR merged outside orc is Done, not Awaiting you", () => {
    const cards = buildCards(
      runs([run("20261113-090000-aaaaaa", { status: "succeeded", branch: "orc/orc-46", prLink: "https://github.com/o/r/pull/46" })]),
      backlog([task("orc-46", { status: "closed", prState: "merged" })])
    )
    expect(cards.map((card) => [card.standing.status, card.where])).toEqual([["Done", "Merged PR #46"]])
  })

  test("a merged PR is not Awaiting you when orc still records a running question", () => {
    const cards = buildCards(
      runs([run("20261113-090000-aaaaaa", { status: "running", questions: 1, branch: "orc/orc-46", prLink: "https://github.com/o/r/pull/46" })]),
      backlog([task("orc-46", { status: "closed", prState: "merged" })])
    )
    expect(cards.map((card) => [card.standing.status, card.where])).toEqual([["Done", "Merged PR #46"]])
  })

  test("a run whose PR closed unmerged on GitHub is Failed, whatever the run recorded, not Awaiting you or Done", () => {
    const cards = buildCards(
      runs([
        run("20261113-090000-aaaaaa", { status: "succeeded", branch: "orc/orc-46", prLink: "https://github.com/o/r/pull/46" }),
        run("20261113-090000-bbbbbb", { status: "stopped", branch: "orc/orc-48", prLink: "https://github.com/o/r/pull/48", endReason: "stopped" })
      ]),
      backlog([task("orc-46", { status: "closed", prState: "closed" }), task("orc-48", { status: "closed", prState: "merged" })])
    )
    expect(cards.map((card) => [card.id, card.standing.status, card.where])).toEqual([["orc-46", "Failed", "Closed PR #46"], ["orc-48", "Done", "Merged PR #48"]])
  })

  test("a merged PR's run is Done, not still awaiting approval", () => {
    const cards = buildCards(
      runs([run("20261113-090000-aaaaaa", { status: "succeeded", branch: "orc/orc-48", prLink: "https://github.com/o/r/pull/48" })]),
      backlog([task("orc-48", { status: "closed" })], ["orc-48"])
    )
    expect(cards.map((card) => [card.standing.status, card.where])).toEqual([["Done", "Merged PR #48"]])
  })

  test("a task rerun three times shows every run, not only its newest run", () => {
    const cards = buildCards(
      runs([
        run("20261113-070000-cccccc", { status: "failed", branch: "orc/orc-7", endReason: "old" }),
        run("20261113-090000-aaaaaa", { status: "running", branch: "orc/orc-7" }),
        run("20261113-080000-bbbbbb", { status: "failed", branch: "orc/orc-7", endReason: "older" })
      ]),
      backlog([task("orc-7", { status: "closed" })])
    )
    expect(cards.map((card) => [card.id, card.runId])).toEqual([["orc-7", "20261113-090000-aaaaaa"], ["orc-7", "20261113-070000-cccccc"], ["orc-7", "20261113-080000-bbbbbb"]])
  })

  test("the find keeps runs whose id or title holds the words, not every run", () => {
    expect(filterCards(board, { project: null, allRuns: false }, "HERDR").map((card) => card.id)).toEqual(["herdr-1"])
    expect(filterCards(board, { project: null, allRuns: false }, "  ").length).toBe(board.length)
  })

  test("the Project filter keeps one project's runs, not every project's", () => {
    expect(filterCards(board, { project: "herdr", allRuns: false }).map((card) => card.where)).toEqual(["Worker asks a question"])
  })

  test("the find and the Project filter together keep runs that match both, not either", () => {
    expect(filterCards(board, { project: "herdr", allRuns: false }, "orc-48")).toEqual([])
  })

  test("each Project choice counts the runs it would show, not the whole list", () => {
    expect(projectMenu(board, { project: null, allRuns: false }).choices.map(({ name, count }) => [name, count])).toEqual([
      ["All", 6], ["herdr", 1], ["orc", 5], ["All runs", 6]
    ])
  })

  test("a select does not lose its chosen filter when the run list refreshes", () => {
    const filter = { project: "herdr", allRuns: false } as const
    const refreshed = buildCards(runs([run("20261113-100000-ffffff", { status: "running" })]), backlog([task("orc-50", {}), task("orc-51", {})]))
    expect(projectMenu(refreshed, filter).chosen).toEqual({ value: { project: "herdr", allRuns: false }, name: "herdr", count: 0 })
    expect(projectMenu(refreshed, filter).choices.map(({ name }) => name)).toEqual(["All", "orc", "All runs"])
  })
})

const tabText = (tab: StepTab): string => tab.kind === "next" ? `next ${tab.label}` : `${tab.status} ${tab.label}`

describe("the selected run's step tabs", () => {
  test("a failed Checks step is followed by the steps still to come, not left out", () => {
    const tabs = stepTabs({ status: "Running" }, [
      { id: 1, name: "implement", attempt: 1, status: "passed", from: null },
      { id: 2, name: "checks", attempt: 1, status: "failed", from: null }
    ], "ship", null)
    expect(tabs.map(tabText)).toEqual(["passed Agent", "failed Checks 1", "next Fix 1", "next Checks 2", "next No mistakes"])
  })

  test("a running step that waits on an answer still lists the steps to come, not only itself", () => {
    const tabs = stepTabs({ status: "Awaiting you", waiting: { on: "answer", items: [answer("orc-7")] } }, [{ id: 1, name: "implement", attempt: 1, status: "running", from: null }], "ship", null)
    expect(tabs.map(tabText)).toEqual(["running Agent", "next Checks 1", "next No mistakes"])
  })

  test("a run not yet started lists every step as still to come, not an empty row", () => {
    expect(stepTabs({ status: "Queued" }, [], "ship", null).map(tabText)).toEqual(["next Agent", "next Checks 1", "next No mistakes"])
  })

  test("a failed run lists no steps to come after the one that failed", () => {
    const tabs = stepTabs({ status: "Failed" }, [{ id: 1, name: "implement", attempt: 1, status: "failed", from: null }])
    expect(tabs.map(tabText)).toEqual(["failed Agent"])
  })

  test("a stopped run records its running step as failed, not still running", () => {
    const tabs = stepTabs({ status: "Failed" }, [{ id: 1, name: "implement", attempt: 1, status: "running", from: null }], "ship", null)
    expect(tabs.map(tabText)).toEqual(["failed Agent"])
  })

  test("a scout run shows only its Agent step, not Checks and PR", () => {
    expect(stepTabs({ status: "Queued" }, [], "scout", null).map(tabText)).toEqual(["next Agent"])
  })

  test("a resumed run puts its carried steps before its own, not carried checks after its delivery step", () => {
    const tabs = stepTabs({ status: "Done" }, [
      { id: 1, name: "implement", attempt: 1, status: "passed", from: "run-a" },
      { id: 2, name: "checks", attempt: 1, status: "failed", from: "run-a" },
      { id: 9, name: "no-mistakes", attempt: 1, status: "passed", from: null },
      { id: 3, name: "fix", attempt: 1, status: "passed", from: "run-a" },
      { id: 4, name: "checks", attempt: 2, status: "passed", from: "run-b" }
    ], "ship", null)
    expect(tabs.map(tabText)).toEqual(["passed Agent", "failed Checks 1", "passed Fix 1", "passed Checks 2", "passed No mistakes"])
    expect(tabs.map((tab) => tab.kind === "step" ? tab.from : "next")).toEqual(["run-a", "run-a", "run-a", "run-b", null])
  })

  test("Checks are numbered by their place in the run, not by an attempt that restarts at 1", () => {
    const tabs = stepTabs({ status: "Running" }, [
      { id: 1, name: "implement", attempt: 1, status: "passed", from: null },
      { id: 2, name: "checks", attempt: 1, status: "failed", from: null },
      { id: 3, name: "checks", attempt: 2, status: "failed", from: null },
      { id: 4, name: "fix", attempt: 1, status: "passed", from: null },
      { id: 5, name: "fix", attempt: 2, status: "passed", from: null },
      { id: 6, name: "checks", attempt: 1, status: "failed", from: null },
      { id: 7, name: "fix", attempt: 1, status: "running", from: null }
    ], "ship", null)
    expect(tabs.map(tabText)).toEqual(["passed Agent", "failed Checks 1", "failed Checks 2", "passed Fix 1", "passed Fix 2", "failed Checks 3", "running Fix 3", "next Checks 4", "next No mistakes"])
  })

  test("a failed checks round names its next fix after the fixes before it, not Fix 1 again", () => {
    const tabs = stepTabs({ status: "Running" }, [
      { id: 1, name: "implement", attempt: 1, status: "passed", from: null },
      { id: 2, name: "checks", attempt: 1, status: "failed", from: null },
      { id: 3, name: "fix", attempt: 1, status: "passed", from: null },
      { id: 4, name: "checks", attempt: 1, status: "failed", from: null }
    ], "ship", null)
    expect(tabs.map(tabText)).toEqual(["passed Agent", "failed Checks 1", "passed Fix 1", "failed Checks 2", "next Fix 2", "next Checks 3", "next No mistakes"])
  })

  test("a PR-delivered run ends in PR, not No mistakes", () => {
    expect(stepTabs({ status: "Queued" }, [], "ship", "direct-PR").map(tabText)).toEqual(["next Agent", "next Checks 1", "next PR"])
  })
})

describe("the row of a run", () => {
  const steps = [
    { id: 1, name: "implement", status: "passed", model: "claude-opus-5-5", thinking: "high" },
    { id: 2, name: "checks", status: "passed", model: null, thinking: null },
    { id: 3, name: "fix", status: "running", model: "claude-sonnet-5-5", thinking: "medium" }
  ] as const
  const started = "2026-11-13T14:25:09Z"
  const ended = "2026-11-13T15:15:07Z"
  const facts = runFacts({ started, ended: null, steps: steps.map((step) => ({ ...step, attempt: 1, piSessionFile: null, from: null })) })

  test("a short model drops the vendor prefix and shortens the effort, as in opus-5-5 h", () => {
    expect(shortModel({ model: "claude-opus-5-5", thinking: "high" })).toBe("opus-5-5 h")
    expect(shortModel({ model: "openai-codex/gpt-5.5", thinking: null })).toBe("5.5")
  })

  test("the logo names the model's vendor, not a guess for an unknown model", () => {
    expect([vendorOf("claude-opus-5-5"), vendorOf("openai-codex/gpt-5.5"), vendorOf("llama-4")]).toEqual(["claude", "openai", null])
  })

  test("a short title joins the id and the first title words, as in orc-258-agents-pane-ux", () => {
    expect(shortTitle("orc-258", "Agents pane UX")).toBe("orc-258-agents-pane-ux")
    expect(shortTitle("orc-7", "orc: Fix the beat lock")).toBe("orc-7-fix-the-beat")
    expect(shortTitle("orc-9", "—")).toBe("orc-9")
  })

  test("a duration rounds down to its largest whole unit, not a long sum of units", () => {
    expect([30_000, 59 * 60_000, 61 * 60_000, 25 * 3_600_000].map(durationLabel)).toEqual(["<1m", "59m", "1h", "1d"])
  })

  test("a running run shows the running step's model and the time since it started, not the Agent step's", () => {
    const row = rowFacts({ id: "orc-240", title: "Scorecard", standing: { status: "Running" } }, facts, Date.parse(ended))
    expect(row).toEqual({ title: "orc-240-scorecard", model: "sonnet-5-5 m", vendor: "claude", duration: "49m" })
  })

  test.each(["checks", "pr", "no-mistakes"])("a running %s step keeps the Agent model and logo instead of dropping them", (name) => {
    const running = runFacts({ started, ended: null, steps: [
      { ...steps[0], attempt: 1, piSessionFile: null, from: null },
      { id: 2, name, status: "running", model: null, thinking: null, attempt: 1, piSessionFile: null, from: null }
    ] })
    const row = rowFacts({ id: "orc-240", title: "Scorecard", standing: { status: "Running" } }, running, Date.parse(ended))
    expect([row.model, row.vendor]).toEqual(["opus-5-5 h", "claude"])
  })

  test("running Checks after Fix keeps the last model instead of returning to the Agent model", () => {
    const running = runFacts({ started, ended: null, steps: [
      ...steps.map((step) => ({ ...step, status: "passed" as const, attempt: 1, piSessionFile: null, from: null })),
      { id: 4, name: "checks", status: "running" as const, model: null, thinking: null, attempt: 1, piSessionFile: null, from: null }
    ] })
    const row = rowFacts({ id: "orc-240", title: "Scorecard", standing: { status: "Running" } }, running, Date.parse(ended))
    expect([row.model, row.vendor]).toEqual(["sonnet-5-5 m", "claude"])
  })

  test("a finished run shows the Agent step's model and its start to end time, not the time since it started", () => {
    const done = runFacts({ started, ended, steps: steps.map((step) => ({ ...step, status: "passed", attempt: 1, piSessionFile: null, from: null })) })
    const row = rowFacts({ id: "orc-240", title: "Scorecard", standing: { status: "Done" } }, done, Date.parse("2026-11-14T00:00:00Z"))
    expect([row.model, row.duration]).toEqual(["opus-5-5 h", "49m"])
  })

  test("a queued task shows no model and no duration, not a made-up one", () => {
    expect(rowFacts({ id: "orc-7", title: "A task", standing: { status: "Queued" } }, null, 0)).toEqual({ title: "orc-7-a-task", model: null, vendor: null, duration: null })
  })

  test("only the step whose model differs from the run's names it, not every agent step", () => {
    expect([...namedModels(steps)]).toEqual([[3, "claude-sonnet-5-5"]])
  })
})

describe("the pane a step opens in", () => {
  test("a Fix step with a Pi session opens in Turns, not as raw text", () => {
    expect(opensTurns({ name: "fix", piSessionFile: "/home/me/.pi/sessions/fix-1.jsonl" })).toBe(true)
  })

  test("any agent step with a Pi session opens in Turns, not only Agent and Fix", () => {
    expect(opensTurns({ name: "review", piSessionFile: "/home/me/.pi/sessions/review-1.jsonl" })).toBe(true)
  })

  test("a Checks step with no Pi session shows its log, not an empty Turns view", () => {
    expect(opensTurns({ name: "checks", piSessionFile: null })).toBe(false)
  })

  test("a Fix step with no Pi session shows its log, not an empty Turns view", () => {
    expect(opensTurns({ name: "fix", piSessionFile: null })).toBe(false)
  })
})

describe("the Approve step and the Changes column of a run", () => {
  const prRun = run("20261113-090000-aaaaaa", { status: "succeeded", branch: "orc/orc-48", prLink: "https://github.com/o/r/pull/48" })

  test("a run awaiting approval ends its tab row in Approve, not in its delivery step", () => {
    const [card] = buildCards(runs([prRun]), backlog([task("orc-48", { status: "closed" })]), [approval])
    expect(lastTab(card)).toBe("Approve")
  })

  test("an open PR that waits on no one ends in Send back, not Approve", () => {
    const [card] = buildCards(runs([prRun]), backlog([task("orc-48", { status: "closed", prState: "open" })]))
    expect([card.openPr, lastTab(card)]).toEqual([prRun.prLink, "Send back"])
  })

  test("a merged PR ends the tab row at its last step, with no Approve or Send back", () => {
    const [card] = buildCards(runs([prRun]), backlog([task("orc-48", { status: "closed" })], ["orc-48"]))
    expect(lastTab(card)).toBeNull()
  })

  test("a run that recorded no worktree has no checkout to diff, not its project folder", () => {
    const cards = buildCards(runs([
      run("20261113-090000-aaaaaa", { branch: "orc/orc-7", worktree: "/home/sam/.orc/worktrees/orc-1/orc/orc-7" }),
      run("20261113-080000-bbbbbb", { branch: "orc/orc-8" })
    ]), backlog([]))
    expect(cards.map((card) => card.checkout)).toEqual([{ worktree: "/home/sam/.orc/worktrees/orc-1/orc/orc-7", branch: "orc/orc-7" }, null])
  })
})

describe("the Project row", () => {
  const mixed = buildCards(
    runs([
      run("20261113-090000-aaaaaa", { status: "failed", endReason: "known failure" }),
      run("20261113-080000-bbbbbb", { status: "failed", endReason: "clone failure", project: "/work/orc-clone" })
    ]),
    backlog([task("orc-7", { project: "orc-dash" })], [], configured("orc"))
  )

  test("a run of a project orc does not know is hidden by default, not counted in the list", () => {
    expect(filterCards(mixed, { project: null, allRuns: false }).map((card) => card.where)).toEqual(["known failure"])
  })

  test("All runs still shows the runs of projects orc does not know, not only the known ones", () => {
    expect(filterCards(mixed, { project: null, allRuns: true }).map((card) => card.project)).toEqual(["orc-dash", "orc", "orc-clone"])
  })

  test("the Project row offers only projects in orc's projects file, not every project a run names", () => {
    expect(projectsOf(mixed)).toEqual(["orc"])
  })

  test("an unread projects file hides no project rather than every one", () => {
    const cards = buildCards(runs([run("20261113-080000-bbbbbb", { status: "failed", project: "/work/orc-clone" })]), backlog([]))
    expect(projectsOf(cards)).toEqual(["orc-clone"])
  })

  test("a taskless run in a known checkout is shown by default, not hidden as an unknown project", () => {
    const cards = buildCards(
      runs([run("20261113-090000-aaaaaa", { status: "failed", project: "/work/herdr-app", branch: "orc/20261113-090000-aaaaaa", endReason: "boom" })]),
      backlog([], [], [{ name: "herdr", paths: ["/work/herdr-app"] }])
    )
    expect(cards.map((card) => [card.project, card.known])).toEqual([["herdr", true]])
    expect(filterCards(cards, { project: null, allRuns: false }).map((card) => card.key)).toEqual(["20261113-090000-aaaaaa"])
  })

  test("a taskless run in no known checkout keeps its folder name, not another project's", () => {
    const cards = buildCards(
      runs([run("20261113-090000-aaaaaa", { status: "failed", project: "/work/stranger-app", branch: "orc/20261113-090000-aaaaaa", endReason: "boom" })]),
      backlog([], [], [{ name: "herdr", paths: ["/work/herdr-app"] }])
    )
    expect(cards.map((card) => [card.project, card.known])).toEqual([["stranger-app", false]])
    expect(filterCards(cards, { project: null, allRuns: false })).toEqual([])
  })

  test("a run of an unknown project opened from the Inbox switches to All runs, not a list that hides it", () => {
    const opened = openedFilter(mixed, "20261113-080000-bbbbbb")
    expect(opened).toEqual({ project: null, allRuns: true })
    expect(filterCards(mixed, opened).map((card) => card.key)).toContain("20261113-080000-bbbbbb")
  })

  test("a run of a known project opened from the Inbox keeps the default view, not All runs", () => {
    expect(openedFilter(mixed, "20261113-090000-aaaaaa")).toEqual({ project: null, allRuns: false })
  })

  test("leaving All runs for All drops an unknown project's selected run, not keeps it listed", () => {
    expect(filterCards(mixed, { project: null, allRuns: false }).map((card) => card.key)).not.toContain("20261113-080000-bbbbbb")
  })
})
