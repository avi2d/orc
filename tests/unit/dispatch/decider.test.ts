import { strict as assert } from "node:assert"
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { attentionJson, attentionText } from "../../../packages/run/src/features/attention-list/index"
import { claimDeciding, openItems, readAttention, routeTaskItems } from "../../../packages/run/src/entities/attention/attention"
import { addTask, claimTask, closeStartedTask, listTasks, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { type AskDecider, DeciderUnheard, decideReviewQuestions, type DeciderRequest } from "../../../packages/run/src/features/decider/index"
import { answerTask, askStartedTask, parkStartedTask } from "../../../packages/run/src/entities/parked-runs/index"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const intent = "# Retry the upload\nRetry a failed upload twice, then give up.\n"

const spec = { title: "Retry the upload", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-11-02T10:00:00.000Z", body: intent }

const claim = { beat: "beat-1", machine: "linux", account: "main", takenAt: "2026-11-02T10:01:00.000Z" }

const asked = "2026-11-02T10:20:00.000Z"
const r2 = { id: "r2", text: "How many retries?" }
const r3 = { id: "r3", text: "Keep the old flag name?" }
const r2Item = "orc-1.r2.2026-11-02T10_20_00_000Z"
const r3Item = "orc-1.r3.2026-11-02T10_20_00_000Z"

type AskedQuestion = { readonly id: string; readonly text: string }

const withAskingTask = async (body: (root: string) => Promise<void>, questions: readonly [AskedQuestion, ...ReadonlyArray<AskedQuestion>] = [r2, r3], taskBody: string = intent): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-decider-"))
  try {
    const record = await run(addTask(root, { ...spec, body: taskBody }))
    await run(claimTask(root, record.spec.id))
    await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
    await run(askStartedTask(root, "orc-1", { asked, questions }))
    await run(routeTaskItems(root, await run(listTasks(root)), asked))
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const replies = (byQuestion: Readonly<Record<string, string>>, heard: Array<DeciderRequest> = [], home = "/nonexistent/orc-home"): AskDecider => ({
  home,
  ask: (request) => {
    heard.push(request)
    const matching = Object.entries(byQuestion).filter(([text]) => request.prompt.includes(text))
    matching.sort((a, b) => request.prompt.lastIndexOf(b[0]) - request.prompt.lastIndexOf(a[0]))
    const first = matching.at(0)
    return first === undefined ? Effect.fail(new DeciderUnheard({ reason: "no reply in this test" })) : Effect.succeed(first[1])
  }
})

const answer = JSON.stringify({ decision: "answer", answer: "Two retries", rule: "Retry a failed upload twice, then give up.", reason: "the intent says twice" })
const escalate = JSON.stringify({ decision: "escalate", reason: "the intent leaves the flag name open" })

const itemFile = async (root: string, id: string): Promise<unknown> => JSON.parse(await readFile(join(root, "attention", id + ".json"), "utf8"))

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const filedAt = (filed: unknown, ...path: ReadonlyArray<string>): string | undefined => {
  let current: unknown = filed
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined
    }
    current = current[key]
  }
  return typeof current === "string" ? current : undefined
}

const decide = async (root: string, ask: AskDecider) => run(decideReviewQuestions(root, await run(listTasks(root)), ask))

describe("the decider", () => {
  test("a live question whose item cannot open never reaches the backlog instead of asking alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-decider-early-"))
    try {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
      await run(askStartedTask(root, "orc-1", { asked, questions: [r2] }))
      expect((await run(listTasks(root))).at(0)?.parked?.questions.map((question) => question.id)).toEqual(["r2"])
      expect((await run(openItems(root))).map((entry) => entry.id)).toEqual([r2Item])
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["decider"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    const blocked = await mkdtemp(join(tmpdir(), "orc-decider-blocked-"))
    try {
      const record = await run(addTask(blocked, spec))
      await run(claimTask(blocked, record.spec.id))
      await run(writeTaken(blocked, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: blocked + "/logs/orc-1.log" } } }))
      await writeFile(join(blocked, "attention"), "blocked")
      await assert.rejects(run(askStartedTask(blocked, "orc-1", { asked, questions: [r2] })))
      expect((await run(listTasks(blocked))).at(0)?.parked).toBeNull()
    } finally {
      await rm(blocked, { recursive: true, force: true })
    }
  })
  test("a parked question whose item cannot open stays taken instead of parking alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "orc-decider-parked-"))
    try {
      const record = await run(addTask(root, spec))
      await run(claimTask(root, record.spec.id))
      await run(writeTaken(root, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: root + "/logs/orc-1.log" } } }))
      await run(parkStartedTask(root, "orc-1", "orc/orc-1", [{ id: "r2", text: "How many retries?" }], "2026-11-02T10:35:00.000Z"))
      expect((await run(listTasks(root))).at(0)?.parked?.questions.map((question) => question.id)).toEqual(["r2"])
      expect((await run(openItems(root))).map((entry) => entry.id)).toEqual(["orc-1.r2.2026-11-02T10_35_00_000Z"])
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["decider"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    const blocked = await mkdtemp(join(tmpdir(), "orc-decider-park-blocked-"))
    try {
      const record = await run(addTask(blocked, spec))
      await run(claimTask(blocked, record.spec.id))
      await run(writeTaken(blocked, { spec: record.spec, hold: null, parked: null, state: { kind: "started", claim, started: { at: "2026-11-02T10:02:00.000Z", log: blocked + "/logs/orc-1.log" } } }))
      await writeFile(join(blocked, "attention"), "blocked")
      await assert.rejects(run(parkStartedTask(blocked, "orc-1", "orc/orc-1", [{ id: "r2", text: "How many retries?" }], "2026-11-02T10:35:00.000Z")))
      const task = (await run(listTasks(blocked))).at(0)
      expect(task?.state.kind).toBe("started")
      expect(task?.parked).toBeNull()
    } finally {
      await rm(blocked, { recursive: true, force: true })
    }
  })
  test("a review question the beat routes is owned by the decider, not handed straight to the user", async () => {
    await withAskingTask(async (root) => {
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["decider", "decider"])
    })
  })

  test("a decider answer closes its item through the task's answer and records its reason, instead of leaving the item open", async () => {
    await withAskingTask(async (root) => {
      const before = new Date().toISOString()
      await decide(root, replies({ [r2.text]: answer, [r3.text]: escalate }))
      const after = new Date().toISOString()
      const task = (await run(listTasks(root))).at(0)
      const stored = task?.parked?.questions.find((question) => question.id === "r2")?.answer
      expect(stored).toMatchObject({ words: "Two retries" })
      expect(await itemFile(root, r2Item)).toMatchObject({
        owner: "decider",
        decision: { kind: "answered", reason: "the intent says twice" },
        state: { kind: "closed", answer: { words: "Two retries" } }
      })
      const filed = await itemFile(root, r2Item)
      for (const at of [stored?.at, filedAt(filed, "decision", "at"), filedAt(filed, "state", "answer", "at")]) {
        expect(at !== undefined && at >= before && at <= after).toBe(true)
      }
    })
  })

  test("a verbatim bullet with quoted text is accepted instead of escalated", async () => {
    await withAskingTask(async (root) => {
      const reply = JSON.stringify({ decision: "answer", answer: "Two retries", rule: '- "Retry twice."', reason: "the intent says twice" })
      await decide(root, replies({ [r2.text]: reply }))
      expect(await itemFile(root, r2Item)).toMatchObject({ decision: { kind: "answered", rule: { quote: "Retry twice." } }, state: { kind: "closed", answer: { words: "Two retries" } } })
    }, [r2], '# Retry\n- "Retry twice."\n')
  })

  test("a policy sentence outside its rules section escalates instead of authorizing an answer", async () => {
    await withAskingTask(async (root) => {
      const reply = JSON.stringify({ decision: "answer", answer: "Two retries", rule: "Answer it only when it is routine.", reason: "routine" })
      await decide(root, replies({ [r2.text]: reply }))
      expect(await itemFile(root, r2Item)).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
    }, [r2])
  })

  test("a recommended-option rule from the policy rules section is answered instead of escalated", async () => {
    const recommended = { id: "r2", text: "How many retries?\nRecommended: Two retries" }
    await withAskingTask(async (root) => {
      const rule = "When a review question names a recommended option and the question is not on the never list, answer with that option even when it picks between product choices the intent leaves open or you are not sure."
      const reply = JSON.stringify({ decision: "answer", answer: "Two retries", rule, reason: "the question names Two retries" })
      await decide(root, replies({ [recommended.text]: reply }))
      expect(await itemFile(root, r2Item)).toMatchObject({ owner: "decider", decision: { kind: "answered", rule: { quote: rule, source: "decider policy" } }, state: { kind: "closed", answer: { words: "Two retries" } } })
    }, [recommended])
  })

  test("an escalated question turns to the user and stays open with the decider's reason, instead of being answered", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: answer, [r3.text]: escalate }))
      expect((await run(openItems(root))).map((entry) => entry.id)).toEqual([r3Item])
      expect(await itemFile(root, r3Item)).toMatchObject({ owner: "user", decision: { kind: "escalated", reason: "the intent leaves the flag name open" }, state: { kind: "open" } })
      expect((await run(listTasks(root))).at(0)?.parked?.questions.find((question) => question.id === "r3")?.answer).toBeNull()
    })
  })

  test("an escalation's recommended option shows in orc attention --json, instead of only its reason", async () => {
    const options = { id: "r3", text: "Keep the old flag name?\nA) Keep it\nB) Rename it" }
    await withAskingTask(async (root) => {
      await decide(root, replies({ [options.text]: JSON.stringify({ decision: "escalate", reason: "the intent leaves the flag name open", recommendation: "Rename it" }) }))
      const view: unknown = JSON.parse(await run(attentionText(true, root)))
      expect(view).toMatchObject({ schema: "orc.attention.v1", items: [{ id: r3Item, owner: "user", decision: { kind: "escalated", reason: "the intent leaves the flag name open", recommendation: "Rename it" } }] })
    }, [options])
  })

  test("an escalation recommending no option of its question keeps its reason and drops the recommendation, instead of marking a made-up option", async () => {
    const options = { id: "r3", text: "Keep the old flag name?\nA) Keep it\nB) Rename it" }
    await withAskingTask(async (root) => {
      await decide(root, replies({ [options.text]: JSON.stringify({ decision: "escalate", reason: "the intent leaves the flag name open", recommendation: "Drop the flag" }) }))
      const filed = await itemFile(root, r3Item)
      expect(filed).toMatchObject({ decision: { kind: "escalated", reason: "the intent leaves the flag name open" } })
      expect(filedAt(filed, "decision", "recommendation")).toBeUndefined()
    }, [options])
  })

  test("each question gets its own call carrying the task intent and the written policy, not one call for the batch", async () => {
    await withAskingTask(async (root) => {
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [r2.text]: escalate, [r3.text]: escalate }, heard))
      const policy = await readFile(join(import.meta.dir, "../../../packages/run/agents/decider-policy.md"), "utf8")
      expect(heard).toHaveLength(2)
      for (const [index, question] of [r2, r3].entries()) {
        expect(heard[index]?.policy).toBe(policy)
        expect(heard[index]?.prompt).toContain("Retry a failed upload twice, then give up.")
        expect(heard[index]?.prompt).toContain(question.text)
        expect(heard[index]?.prompt).not.toContain((index === 0 ? r3 : r2).text)
      }
    })
  })

  test("a question the user owns never reaches the decider, so an escalated one is not asked twice", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: escalate, [r3.text]: escalate }))
      const heard: Array<DeciderRequest> = []
      expect(await decide(root, replies({ [r2.text]: answer }, heard))).toEqual([])
      expect(heard).toEqual([])
    })
  })

  test("a decider answer lists under decided with its words, and leaves the list once its task closes, while a user answer never lists there", async () => {
    await withAskingTask(async (root) => {
      const before = new Date().toISOString()
      await decide(root, replies({ [r2.text]: answer, [r3.text]: escalate }))
      const after = new Date().toISOString()
      await run(answerTask(root, "orc-1", "r3=Keep the old flag", "2026-11-02T10:22:00.000Z"))
      await run(routeTaskItems(root, await run(listTasks(root)), "2026-11-02T10:22:00.000Z"))
      const decided = (await run(readAttention(root, await run(listTasks(root))))).decided
      expect(decided.map((entry) => entry.id)).toEqual([r2Item])
      const view = attentionJson(await run(openItems(root)), "2026-11-02T10:30:00.000Z", decided)
      expect(view.items).toEqual([])
      expect(view.decided).toHaveLength(1)
      const entry = view.decided.at(0)
      expect(entry).toMatchObject({
        id: r2Item,
        kind: "review-question",
        task: "orc-1",
        text: r2.text,
        asked,
        owner: "decider",
        decision: { kind: "answered", reason: "the intent says twice" },
        answer: { words: "Two retries" }
      })
      for (const at of [entry?.decision.at, entry?.answer.at]) {
        expect(at !== undefined && at >= before && at <= after).toBe(true)
      }
      expect(await run(attentionText(false, root))).toContain("Decided:\nanswered " + r2Item + ": Two retries (the intent says twice, quoting task orc-1: \"Retry a failed upload twice, then give up.\")")
      await run(closeStartedTask(root, "orc-1", "done", "the upload retries", { pr: null, report: null }, "2026-11-02T10:40:00.000Z"))
      expect((await run(readAttention(root, await run(listTasks(root))))).decided).toEqual([])
    })
  })

  test("a beat skips an item another beat is deciding instead of asking the model twice", async () => {
    await withAskingTask(async (root) => {
      const claimedAt = new Date().toISOString()
      expect(await run(claimDeciding(root, r2Item, claimedAt))).toBe(true)
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [r2.text]: answer, [r3.text]: escalate }, heard))
      expect(heard).toHaveLength(1)
      expect((await run(openItems(root))).map((entry) => entry.id)).toEqual([r2Item, r3Item])
      expect(await itemFile(root, r2Item)).toMatchObject({ owner: "decider", deciding: { at: claimedAt }, state: { kind: "open" } })
    })
  })

  test("a deciding mark older than the decider timeout is retaken instead of stalling the question", async () => {
    await withAskingTask(async (root) => {
      expect(await run(claimDeciding(root, r2Item, "2026-11-02T10:17:00.000Z"))).toBe(true)
      const heard: Array<DeciderRequest> = []
      const before = new Date().toISOString()
      await decide(root, replies({ [r2.text]: answer, [r3.text]: escalate }, heard))
      const after = new Date().toISOString()
      expect(heard).toHaveLength(2)
      expect(await itemFile(root, r2Item)).toMatchObject({
        decision: { kind: "answered", reason: "the intent says twice" },
        state: { kind: "closed", answer: { words: "Two retries" } }
      })
      const filed = await itemFile(root, r2Item)
      for (const at of [filedAt(filed, "decision", "at"), filedAt(filed, "state", "answer", "at")]) {
        expect(at !== undefined && at >= before && at <= after).toBe(true)
      }
    })
  })

  test("a reply orc cannot read or a call that fails escalates to the user instead of answering", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: "Sure, two retries sounds right." }))
      expect((await run(openItems(root))).map((entry) => entry.item.owner)).toEqual(["user", "user"])
      expect((await run(listTasks(root))).at(0)?.parked?.questions.every((question) => question.answer === null)).toBe(true)
    })
  })

  test("recorded lint and CI answers survive punctuation and line breaks in their cited rule instead of escalating", async () => {
    const questions = [
      { id: "lint-1", text: "linter found issues (exit code 1)" },
      { id: "ci-1", text: "CI check failing: changes - provider reported failure - https://github.com/avi2d/orc/actions/runs/45203821613/job/137794040179" },
      { id: "ci-2", text: "CI check failing: checks - provider reported failure - https://github.com/avi2d/orc/actions/runs/45203821613/job/137794138515" }
    ] as const
    const rule = "Hold engineering signals to the same standard: a lint failure, a failing test, a flaky test. Fix it when you see it, even when you did not cause it."
    const fix = "Fix it when you see it, even when you did not cause it."
    const answers = [
      "Fix the lint findings in the code and re-run the project's linter until it exits 0. Do not add suppressions such as eslint-disable, biome-ignore, @ts-ignore or @ts-expect-error, and do not stop linting the file. Keep the fixes inside the files this change touches, plus any other lint failure you see in the run, and keep the change small.",
      "Open the failing CI job at https://github.com/avi2d/orc/actions/runs/45203821613/job/137794040179 and read its actual error. If the cause is in this branch, fix it at the cause with no suppression comments and no rule turned off, then push and wait for every check to report. If the job failed for a reason outside the code, such as a provider or runner fault, rerun it once and say so plainly in the report instead of changing code. Keep the change inside the task's consumer-only scope.",
      "Fix the failing CI check. Open the failing job log at https://github.com/avi2d/orc/actions/runs/45203821613/job/137794138515, read the actual error, and fix its cause in the code. Do not add suppression comments, turn off a rule, skip or weaken a test, or widen the task beyond its intent. Push the fix and wait for every check to report green. If the failure is a flaky test or unrelated to this change, fix that too rather than rerunning blindly. If the log cannot be read or the cause needs a decision outside the task's intent, say so plainly."
    ]
    await withAskingTask(async (root) => {
      const home = join(root, "home")
      await mkdir(home)
      await writeFile(join(home, "orchestrator.md"), "## Fix what you see\n- Hold engineering signals to the same standard; a lint failure, a failing test, a flaky test.\n- Fix it when you see it, even when you did not cause it.\n")
      const response = Object.fromEntries(questions.map((question, index) => [question.text, JSON.stringify({ decision: "answer", answer: answers[index], rule: index === 0 ? rule.slice(0, rule.indexOf(" Fix it")) : index === 1 ? rule : fix, reason: "the rule requires fixing the failure" })]))
      await decide(root, replies(response, [], home))
      for (const question of questions) {
        const id = "orc-1." + question.id + ".2026-11-02T10_20_00_000Z"
        expect(await itemFile(root, id)).toMatchObject({ decision: { kind: "answered" }, state: { kind: "closed", answer: { words: answers[questions.indexOf(question)] } } })
      }
      expect(await itemFile(root, "orc-1.lint-1.2026-11-02T10_20_00_000Z")).toMatchObject({ decision: { rule: { quote: "Hold engineering signals to the same standard; a lint failure, a failing test, a flaky test." } } })
    }, questions)
  })

  test("a quotation that differs from the owner's rule only in a meaning mark such as <= for >= escalates instead of answering", async () => {
    const question = { id: "ci-1", text: "CI check failing: coverage - provider reported failure" }
    await withAskingTask(async (root) => {
      const home = join(root, "home")
      await mkdir(home)
      await writeFile(join(home, "orchestrator.md"), "## Coverage\n- Coverage must stay >= 80%.\n")
      await decide(root, replies({ [question.text]: JSON.stringify({ decision: "answer", answer: "Lower the coverage.", rule: "Coverage must stay <= 80%.", reason: "the rule caps coverage" }) }, [], home))
      expect(await itemFile(root, "orc-1.ci-1.2026-11-02T10_20_00_000Z")).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
    }, [question])
  })

  test("misquoted filenames, globs and negation escalate instead of conferring authority", async () => {
    const examples = [
      { source: "Use the file `_worker.js`.", quote: "Use the file `worker.js`." },
      { source: "Check `src/*.ts`.", quote: "Check `src/.ts`." },
      { source: "Return ! ready.", quote: "Return ready." }
    ]
    for (const example of examples) {
      await withAskingTask(async (root) => {
        const home = join(root, "home")
        await mkdir(home)
        await writeFile(join(home, "orchestrator.md"), "## Rules\n- " + example.source + "\n")
        await decide(root, replies({ [r2.text]: JSON.stringify({ decision: "answer", answer: "Proceed", rule: example.quote, reason: "the rule says so" }) }, [], home))
        expect(await itemFile(root, r2Item)).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
      }, [r2])
    }
  })

  test("recorded lint and CI quotations absent from the owner's rules still escalate", async () => {
    const question = { id: "ci-1", text: "CI check failing: changes - provider reported failure" }
    await withAskingTask(async (root) => {
      const home = join(root, "home")
      await mkdir(home)
      await writeFile(join(home, "orchestrator.md"), "## Decide or ask\n- Ask before a new goal or a wider scope.\n")
      const rule = "Hold engineering signals to the same standard: a lint failure, a failing test, a flaky test. Fix it when you see it, even when you did not cause it."
      await decide(root, replies({ [question.text]: JSON.stringify({ decision: "answer", answer: "Open the failing CI job and read its actual error.", rule, reason: "fix the failure" }) }, [], home))
      expect(await itemFile(root, "orc-1.ci-1.2026-11-02T10_20_00_000Z")).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
    }, [question])
  })

  test("an answer whose quoted rule is in no source escalates instead of answering on a made-up rule", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: JSON.stringify({ decision: "answer", answer: "Five retries", rule: "Retry a failed upload five times.", reason: "the rule says five" }) }))
      expect(await itemFile(root, r2Item)).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
      expect(filedAt(await itemFile(root, r2Item), "decision", "reason")).toContain("in none of the rules it read")
      expect((await run(listTasks(root))).at(0)?.parked?.questions.find((question) => question.id === "r2")?.answer).toBeNull()
    }, [r2])
  })

  test("an answer quoting a fragment of a policy sentence escalates instead of passing as a rule", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: JSON.stringify({ decision: "answer", answer: "Two retries", rule: "settle one question", reason: "the policy settles it" }) }))
      expect(await itemFile(root, r2Item)).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
      expect(filedAt(await itemFile(root, r2Item), "decision", "reason")).toContain("in none of the rules it read")
      expect((await run(listTasks(root))).at(0)?.parked?.questions.find((question) => question.id === "r2")?.answer).toBeNull()
    }, [r2])
  })

  test("an answer that quotes only a word or two of a source escalates instead of passing as a rule", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: JSON.stringify({ decision: "answer", answer: "Two retries", rule: "twice", reason: "the intent says twice" }) }))
      expect(await itemFile(root, r2Item)).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
    }, [r2])
  })

  const turnsIntent = [
    "# Fix by name opens empty turns",
    "In the Agents tab a Fix step opens as a plain monospace log with no color.",
    "",
    "Fix: every step that ran a Pi session, Fix and any other agent step",
    "included, opens in the same Turns view as Agent, with Raw beside it showing the log as today. Each turn card carries its number.",
    ""
  ].join("\n")
  const turnsQuestion = { id: "r4", text: "fix-by-name-opens-empty-turns: should only the Fix step open in Turns, or every Pi step? Recommended: every Pi step." }
  const turnsItem = "orc-1.r4.2026-11-02T10_20_00_000Z"
  const turnsRule = "every step that ran a Pi session, Fix and any other agent step included, opens in the same Turns view as Agent, with Raw beside it showing the log as today."

  test("the orc-64 answer quoting a clause inside a longer intent line is answered, instead of escalated for not being a whole line", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [turnsQuestion.text]: JSON.stringify({ decision: "answer", answer: "Every Pi step opens in Turns", rule: turnsRule, reason: "the intent names every Pi step" }) }))
      expect(await itemFile(root, turnsItem)).toMatchObject({
        owner: "decider",
        decision: { kind: "answered", rule: { quote: turnsRule, source: "task orc-1" } },
        state: { kind: "closed", answer: { words: "Every Pi step opens in Turns" } }
      })
    }, [turnsQuestion], turnsIntent)
  })

  test("an answer on an invented rule worded like the orc-64 intent escalates, instead of being accepted", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [turnsQuestion.text]: JSON.stringify({ decision: "answer", answer: "Only Fix opens in Turns", rule: "only the Fix step opens in the same Turns view as Agent.", reason: "the intent names Fix" }) }))
      expect(await itemFile(root, turnsItem)).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
      expect(filedAt(await itemFile(root, turnsItem), "decision", "reason")).toContain("in none of the rules it read")
    }, [turnsQuestion], turnsIntent)
  })

  test("the owner's rules and the project's instructions reach the prompt labelled, and an answer on the owner's rule keeps its quote and file, instead of a free reason", async () => {
    const r4 = { id: "r4", text: "pnpm or npm?" }
    await withAskingTask(async (root) => {
      const home = join(root, "home")
      await mkdir(home)
      const rules = join(home, "orchestrator.md")
      await writeFile(rules, "# Rules\n\nuse pnpm when a project has pnpm-lock.yaml\n")
      await writeFile(join(root, "orc.md"), "Run bun run lint before a change is done.\n")
      await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { linux: "/home/a/orc" }, instructions: "orc.md" }] }))
      const heard: Array<DeciderRequest> = []
      const reply = JSON.stringify({ decision: "answer", answer: "pnpm", rule: "\"use pnpm when a project has pnpm-lock.yaml\"", reason: "the project has pnpm-lock.yaml" })
      await decide(root, replies({ [r4.text]: reply }, heard, home))
      expect(heard).toHaveLength(1)
      expect(heard[0]?.prompt).toContain("The owner's rules, from " + rules + ":\n\n# Rules\n\nuse pnpm when a project has pnpm-lock.yaml")
      expect(heard[0]?.prompt).toContain("The instructions of the project orc, from " + join(root, "orc.md") + ":\n\nRun bun run lint before a change is done.")
      expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({
        decision: { kind: "answered", reason: "the project has pnpm-lock.yaml", rule: { quote: "use pnpm when a project has pnpm-lock.yaml", source: rules } },
        state: { kind: "closed", answer: { words: "pnpm" } }
      })
    }, [r4])
  })

  test("a duplicate link to an unanswered question escalates instead of answering with nothing", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: escalate, [r3.text]: JSON.stringify({ decision: "duplicate", of: r2Item }) }))
      expect(await itemFile(root, r3Item)).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
      expect(filedAt(await itemFile(root, r3Item), "decision", "reason")).toContain("no answered question of this task")
    })
  })

  test("a duplicate link to an answered question gives that question's answer and names it, instead of a new answer", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: answer, [r3.text]: JSON.stringify({ decision: "duplicate", of: r2Item }) }))
      expect(await itemFile(root, r3Item)).toMatchObject({ owner: "decider", decision: { kind: "duplicate", of: r2Item }, state: { kind: "closed", answer: { words: "Two retries" } } })
      expect((await run(listTasks(root))).at(0)?.parked?.questions.find((question) => question.id === "r3")?.answer).toMatchObject({ words: "Two retries", by: "decider" })
    })
  })

  test("an ask back hands the worker the decider's question and leaves the item open, instead of closing it as answered", async () => {
    const ask1 = { id: "ask-1", text: "Which retry count should the upload use?" }
    const item = "orc-1.ask-1.2026-11-02T10_20_00_000Z"
    await withAskingTask(async (root) => {
      await decide(root, replies({ [ask1.text]: JSON.stringify({ decision: "ask-back", question: "Does the upload run in CI?" }) }))
      expect(await itemFile(root, item)).toMatchObject({ kind: "worker-question", owner: "decider", decision: { kind: "asked-back", question: "Does the upload run in CI?" }, state: { kind: "open" } })
      const stored = (await run(listTasks(root))).at(0)?.parked?.questions.find((question) => question.id === "ask-1")?.answer
      expect(stored).toMatchObject({ by: "asked-back" })
      expect(stored?.words).toContain("Does the upload run in CI?")
      expect(await run(attentionText(false, root))).toContain("(asked the worker back: Does the upload run in CI?)")
    }, [ask1])
  })

  test("a follow-up carries the asked-back exchange in its prompt, instead of asking without that context", async () => {
    const ask1 = { id: "ask-1", text: "Which retry count should the upload use?" }
    const ask2 = { id: "ask-2", text: "It runs in CI, should it retry twice?" }
    const asked2 = new Date(Date.now() + 60_000).toISOString()
    await withAskingTask(async (root) => {
      await decide(root, replies({ [ask1.text]: JSON.stringify({ decision: "ask-back", question: "Does the upload run in CI?" }) }))
      await run(askStartedTask(root, "orc-1", { asked: asked2, questions: [ask2] }))
      await run(routeTaskItems(root, await run(listTasks(root)), asked2))
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [ask2.text]: escalate }, heard))
      expect(heard).toHaveLength(1)
      expect(heard[0]?.prompt).toContain("Which retry count should the upload use?")
      expect(heard[0]?.prompt).toContain("Does the upload run in CI?")
    }, [ask1])
  })

  test("a settled follow-up closes the earlier asked-back item, instead of leaving it open with no owner", async () => {
    const ask1 = { id: "ask-1", text: "Which retry count should the upload use?" }
    const ask2 = { id: "ask-2", text: "It runs in CI, should it retry twice?" }
    const asked2 = new Date(Date.now() + 60_000).toISOString()
    const item1 = "orc-1.ask-1.2026-11-02T10_20_00_000Z"
    const item2 = "orc-1.ask-2." + asked2.replace(/[^A-Za-z0-9_-]/g, "_")
    await withAskingTask(async (root) => {
      await decide(root, replies({ [ask1.text]: JSON.stringify({ decision: "ask-back", question: "Does the upload run in CI?" }) }))
      await run(askStartedTask(root, "orc-1", { asked: asked2, questions: [ask2] }))
      await run(routeTaskItems(root, await run(listTasks(root)), asked2))
      await decide(root, replies({ [ask2.text]: answer }))
      expect((await run(openItems(root))).map((entry) => entry.id)).not.toContain(item1)
      expect(await itemFile(root, item1)).toMatchObject({ state: { kind: "closed" } })
      expect(await itemFile(root, item2)).toMatchObject({ state: { kind: "closed", answer: { words: "Two retries" } } })
    }, [ask1])
  })

  test("an ask back on a review question escalates instead of asking a run that cannot reply", async () => {
    await withAskingTask(async (root) => {
      await decide(root, replies({ [r2.text]: JSON.stringify({ decision: "ask-back", question: "Does the upload run in CI?" }) }))
      expect(await itemFile(root, r2Item)).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
    }, [r2])
  })
})
