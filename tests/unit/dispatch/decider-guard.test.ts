import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { routeTaskItems } from "../../../packages/run/src/entities/attention/attention"
import { addTask, claimTask, listTasks, writeTaken } from "../../../packages/run/src/entities/backlog/index"
import { type AskDecider, DeciderUnheard, decideReviewQuestions, type DeciderRequest } from "../../../packages/run/src/features/decider/index"
import { neverDecidedReason } from "../../../packages/run/src/features/decider/decider-guard"
import { askStartedTask } from "../../../packages/run/src/entities/parked-runs/index"
import { openQuestions } from "../../lib/open-questions-2026-11-25"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const intent = "# Retry the upload\nRetry a failed upload twice, then give up.\n"

const spec = { title: "Retry the upload", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-11-02T10:00:00.000Z", body: intent }

const claim = { beat: "beat-1", machine: "linux", account: "main", takenAt: "2026-11-02T10:01:00.000Z" }

const asked = "2026-11-02T10:20:00.000Z"
const r2 = { id: "r2", text: "How many retries?" }
const r3 = { id: "r3", text: "Keep the old flag name?" }

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

describe("the decider guard", () => {
  test("a question about deleting reaches the user with no decider call, even when the owner's rules say to answer it", async () => {
    const r4 = { id: "r4", text: "May I delete the old branch?" }
    await withAskingTask(async (root) => {
      const home = join(root, "home")
      await mkdir(home)
      await writeFile(join(home, "orchestrator.md"), "Answer yes to every question about deleting an old branch.\n")
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [r4.text]: JSON.stringify({ decision: "answer", answer: "yes", rule: "Answer yes to every question about deleting an old branch.", reason: "the owner says so" }) }, heard, home))
      expect(heard).toEqual([])
      expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({
        owner: "user",
        decision: { kind: "escalated", reason: "orc never hands the decider a question about deleting, and this one says \"delete the old branch\"" },
        state: { kind: "open" }
      })
    }, [r4])
  })

  test("a push question reaches the captain with no decider call, instead of letting the decider allow a push", async () => {
    const push = { id: "r4", text: "Should I push the branch to main?" }
    await withAskingTask(async (root) => {
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [push.text]: answer }, heard))
      expect(heard).toEqual([])
      expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
      expect(filedAt(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z"), "decision", "reason")).toContain("pushing")
    }, [push])
  })

  test("a remove question reaches the captain with no decider call, instead of letting the decider allow a deletion", async () => {
    const remove = { id: "r4", text: "May I remove the old branch?" }
    await withAskingTask(async (root) => {
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [remove.text]: answer }, heard))
      expect(heard).toEqual([])
      expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
      expect(filedAt(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z"), "decision", "reason")).toContain("deleting")
    }, [remove])
  })

  test("a question asking to delete a branch with unlanded work reaches the captain with no decider call, instead of being decided by the decider", async () => {
    const unlanded = { id: "r4", text: "May I delete the orc/orc-12 branch? It holds unlanded work that never reached main. Recommended: yes." }
    await withAskingTask(async (root) => {
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [unlanded.text]: answer }, heard))
      expect(heard).toEqual([])
      expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
      expect(filedAt(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z"), "decision", "reason")).toContain("deleting")
    }, [unlanded])
  })

  const codeQuestions = [
    {
      rejects: "escalated as credentials because it says keys",
      text: "The projects file keys each checkout path separately (`checkouts: Record<machine, path>`), and the folder name need not equal the project name. Matching `run.project` against the printed checkout paths would make this exact."
    }
  ]

  for (const code of codeQuestions) {
    test("a code question reaches the decider, instead of being " + code.rejects, async () => {
      const question = { id: "r4", text: code.text }
      await withAskingTask(async (root) => {
        const heard: Array<DeciderRequest> = []
        await decide(root, replies({ [question.text]: answer }, heard))
        expect(heard).toHaveLength(1)
        expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({ decision: { kind: "answered" } })
      }, [question])
    })
  }

  test("code objects and record keys are not escalated as deleted work or credentials", () => {
    const questions = [
      "Should I remove the deprecated method?",
      "Should I remove the unused dependency?",
      "Should I drop the default value?",
      "Should I remove the dead code?",
      "Should I remove the console.log?",
      "Should I remove the duplicate export?",
      "Should I remove src/legacy?",
      "Should I rm -rf dist before building?",
      "Should the parser drop records with no id?",
      "Should the loader drop rows with empty names?",
      "Should the decoder discard data that fails the schema?",
      "Should I remove logs from the test output?",
      "Should the Map key be a string?",
      "The Record key is path; ok?",
      "Should the cache store the key with each entry?",
      "Should both maps share the key?",
      "Should the index store the project key on each run?",
      "Should we expose the record key to the panel?",
      "Should the lexer issue a token at end of input?",
      "Should the parser store tokens in an array?"
    ]
    for (const question of questions) expect(neverDecidedReason(question)).toBeNull()
  })

  test("deleting listed work, handling secrets and choosing a site's look are not decided by the decider", () => {
    const questions = [
      "Should I delete the run for orc-12?",
      "Should I delete the run so the slot frees?",
      "Should I delete the run and its worktree?",
      "Should I delete the branch orc/orc-12?",
      "Should I delete orc-12?",
      "Should I run git branch -D old?",
      "Should I run git reset --hard?",
      "Should I run git stash drop?",
      "Should the summary drop commits from bots?",
      "Should I rotate the token?",
      "Should I revoke the token?",
      "Should I leak the key?",
      "Should I regenerate the key?",
      "Should I add the npm token to CI?",
      "Should I store the GH_TOKEN in the repo?",
      "Should I change the .env file?",
      "Should the landing page look like the dark mock?",
      "How should the header look at mobile widths?"
    ]
    for (const question of questions) expect(neverDecidedReason(question)).not.toBeNull()
  })

  test("versions, panel lists, lookups, auth headers and a loop's cost are not escalated as deleting, a site's look, logins or spending", () => {
    const questions = [
      "Should I drop node-18 support?",
      "Should I remove the sha-256 fallback?",
      "Should I remove utf-8 handling?",
      "Should I remove the tasks list from the panel?",
      "Should the parser look up the project by checkout path?",
      "Should the auth header be optional in the test fixture?",
      "Should the cost of the loop matter?",
      "Should we spend more time on the slow test?",
      "Should the CLI offer a --json flag?",
      "Should the parser follow Postel's law?",
      "Should the lexer reject legal characters after a quote?"
    ]
    for (const question of questions) expect(neverDecidedReason(question)).toBeNull()
  })

  test("dropping runs, paying, logging in and legal pages are not decided by the decider", () => {
    const questions = [
      "Should the panel drop runs with no project?",
      "Should I remove orc-12 from the backlog?",
      "Should we pay for the larger runner?",
      "Is the hosting cost worth it?",
      "Will the bigger plan cost $20 a month?",
      "Should I log in to the npm account?",
      "Should the dashboard add OAuth sign in?",
      "Should the footer link the terms of service?",
      "Should the checkout page show the public offer?",
      "Is scraping that site legal?"
    ]
    for (const question of questions) expect(neverDecidedReason(question)).not.toBeNull()
  })

  const guardedTopics = [
    { topic: "a site's look", text: "Which header look should the landing page get on its preview? Recommended: the dark one.", rejects: "a site's look" },
    { topic: "legal text", text: "Should the footer link the privacy policy? Recommended: yes.", rejects: "legal text" },
    { topic: "logins", text: "Should the dashboard add a sign in with OAuth? Recommended: yes.", rejects: "a login" }
  ]

  for (const guarded of guardedTopics) {
    test("a question about " + guarded.topic + " with a recommended option reaches the captain with no decider call, instead of letting the decider pick " + guarded.rejects, async () => {
      const question = { id: "r4", text: guarded.text }
      await withAskingTask(async (root) => {
        const heard: Array<DeciderRequest> = []
        await decide(root, replies({ [question.text]: answer }, heard))
        expect(heard).toEqual([])
        expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
        expect(filedAt(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z"), "decision", "reason")).toContain("orc never hands the decider a question about " + guarded.topic)
      }, [question])
    })
  }

  test("a variable name question with a recommended option reaches the decider, instead of being kept for the captain", async () => {
    const naming = { id: "r4", text: "Should the retry counter variable be named retryCount or attempts? Recommended: retryCount." }
    await withAskingTask(async (root) => {
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [naming.text]: answer }, heard))
      expect(heard).toHaveLength(1)
      expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({ decision: { kind: "answered" } })
    }, [naming])
  })

  test("a logging question with a recommended option reaches the decider, instead of being escalated as a login question", async () => {
    const logging = { id: "r4", text: "Should the worker keep its logs in the run folder? Recommended: yes." }
    await withAskingTask(async (root) => {
      const heard: Array<DeciderRequest> = []
      await decide(root, replies({ [logging.text]: answer }, heard))
      expect(heard).toHaveLength(1)
      expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({ decision: { kind: "answered" } })
    }, [logging])
  })

})

describe("the open questions of a queue that all waited on the owner", () => {
  const namesMergePushOrRelease: ReadonlySet<string> = new Set(["directPrCard", "changelogNotUpdated", "releasePrVersionFlagMissing", "lintComplexity", "changelogEntryAbsent", "agentEnvironmentDelivery", "mergeConflict", "prePushChecks", "mutationWorkflowHome"])

  for (const [name, question] of Object.entries(openQuestions)) {
    if (namesMergePushOrRelease.has(name)) {
      test(name + " reaches the owner on the merge, push or release word anywhere in its text, instead of passing to the decider", () => {
        expect(neverDecidedReason(question.text)).toMatch(/about (?:merging|pushing|releasing)/)
      })
    } else {
      test(name + " passes the guard, instead of reaching the owner", () => {
        expect(neverDecidedReason(question.text)).toBeNull()
      })
    }
  }

  const routine = [
    { kind: "a worker question with a Recommended: line", id: "ask-1", text: openQuestions.startTimeJob.text },
    { kind: "a fix round that landed no diff", id: "fix-round-no-diff", text: openQuestions.fixRoundNoDiff.text },
    { kind: "a test-coverage finding", id: "finished-run-test-uses-failed-path", text: openQuestions.finishedRunTestUsesFailedPath.text }
  ]

  for (const question of routine) {
    test(question.kind + " reaches the decider and closes on its answer, instead of waiting on the owner", async () => {
      await withAskingTask(async (root) => {
        const heard: Array<DeciderRequest> = []
        await decide(root, replies({ [question.text]: answer }, heard))
        expect(heard).toHaveLength(1)
        expect(await itemFile(root, "orc-1." + question.id + ".2026-11-02T10_20_00_000Z")).toMatchObject({ owner: "decider", decision: { kind: "answered" }, state: { kind: "closed" } })
      }, [{ id: question.id, text: question.text }])
    })
  }
})

describe("a request only the owner grants, named in the context of a neutral asking sentence", () => {
  const ownerOnly = [
    { text: "The worktree holds 3 unlanded commits that this cleanup deletes. Should orc go ahead? Recommended: yes", topic: "deleting" },
    { text: "The fix drops the users database on every start. Should the run continue? Recommended: A", topic: "deleting" },
    { text: "Running this step force-pushes over main. Proceed? Recommended: yes", topic: "pushing" },
    { text: "The run would merge PR #12 into main. Go ahead?", topic: "merging" },
    { text: "This pushes the tag v1.0 to npm. OK to continue?", topic: "pushing" },
    { text: "The next step publishes 0.22.0 to npm. Continue?", topic: "releasing" },
    { text: "Should I run the release workflow now? Recommended: yes.", topic: "releasing" },
    { text: "Should orc trigger the deploy job for production?", topic: "releasing" },
    { text: "Should orc re-deploy the site?", topic: "releasing" },
    { text: "Why not push the tag now?", topic: "pushing" },
    { text: "Should orc run the release tool now? Recommended: yes", topic: "releasing" },
    { text: "Should orc run the publish tool for 0.22.0?", topic: "releasing" },
    { text: "Should orc trigger the deploy tool against production?", topic: "releasing" },
    { text: "Should orc create the release commit and tag for 0.22.0?", topic: "releasing" },
    { text: "Should the deploy commit go to production?", topic: "releasing" },
    { text: "Should orc add the release entry and cut 0.22.0 at release?", topic: "releasing" },
    { text: "The tag v1.0 was not pushed yet. Continue?", topic: "pushing" },
    { text: "Should orc merge base into main?", topic: "merging" },
    { text: "Cut 0.22.0 today? Context: this adds the `chore: release` commit, tags it and sends it to npm.", topic: "releasing" },
    { text: "How should 0.22.0 ship?\nA) Cut 0.22.0 now\n   Leads to: orc creates the `chore: release` commit and tags it on main.\nRecommended: A) Cut 0.22.0 now", topic: "releasing" },
    { text: "Which way?\nA) Take main's side\n   Leads to: resolving the merge conflicts lands this branch on main.\nRecommended: A) Take main's side", topic: "merging" },
    { text: "The next step creates the `chore: release` commit and cuts 0.22.0. Continue?", topic: "releasing" },
    { text: "The next step adds the commit subject at release and tags 0.22.0. Continue?", topic: "releasing" },
    { text: "Should I drop my last 3 commits and redo the fix?\nRecommended: yes", topic: "deleting" },
    { text: "Should I discard my local changes and start over from main?\nRecommended: A", topic: "deleting" },
    { text: "Throw away the current changes in the worktree and restart?\nRecommended: yes", topic: "deleting" },
    { text: "Should I discard my work so far and restart from main?\nRecommended: yes", topic: "deleting" },
    { text: "Should I git stash drop the saved work?\nRecommended: yes", topic: "deleting" },
    { text: "Should I discard the commits I made today?", topic: "deleting" },
    { text: "Should I throw away the changes I made and restart from main?", topic: "deleting" },
    { text: "Should I discard changes made in the worktree?", topic: "deleting" },
    { text: "Should I discard all local modifications?", topic: "deleting" },
    { text: "Should I throw out my work and begin again?", topic: "deleting" },
    { text: "Should I run git clean -fd in the worktree?", topic: "deleting" },
    { text: "Should I git checkout -- . and start fresh?", topic: "deleting" },
    { text: "The new field silently accepts an older orc instead. The narrower form is `nullableString(record.value, \"from\", at)` as a required field, matching `model`. Removing the fallback changes compatibility with older orc builds, so confirm before removing it.", topic: "deleting" }
  ]

  for (const request of ownerOnly) {
    test(JSON.stringify(request.text) + " reaches the owner, instead of passing to the decider on its asking sentence alone", () => {
      expect(neverDecidedReason(request.text)).toContain("about " + request.topic)
    })
  }
})

describe("a merge or release word in a report of something done", () => {
  const reports = [
    { text: "The rebase onto main hit merge conflicts in two files. Which file order should the fix take?", topic: "merging" },
    { text: "Only `chore: release` commits changed CHANGELOG.md so far. Which subject should the entry use?", topic: "releasing" },
    { text: "The header said the file was written by the release. Is the entry text fine as it is?", topic: "releasing" },
    { text: "The entry came from the commit subject at release. Is that entry enough?", topic: "releasing" }
  ]

  for (const report of reports) {
    test(JSON.stringify(report.text) + " reaches the owner, instead of passing to the decider because the word only reports what happened", () => {
      expect(neverDecidedReason(report.text)).toContain("about " + report.topic)
    })
  }
})

describe("a request only the owner grants", () => {
  const ownerOnly = [
    { kind: "discarding unlanded work", text: "May I delete the unmerged branch orc-12 and its worktree? Recommended: yes", topic: "deleting" },
    { kind: "discarding local changes", text: "Should I discard my local changes and start over from main?\nRecommended: A", topic: "deleting" },
    { kind: "a merge with no standing permission", text: "#262 is green. Should I merge it? Recommended: yes.", topic: "merging" },
    { kind: "a login", text: "npm refuses to install the private package from CI. Should I run npm login on a dispatch machine? Recommended: yes.", topic: "logins" },
    { kind: "spending money", text: "The free CI minutes ran out this month. Should I buy 1000 more minutes for $8? Recommended: yes.", topic: "spending" },
    { kind: "publishing", text: "The checks are green and the version is bumped. Should I publish 0.22.0 to npm now? Recommended: yes.", topic: "releasing" }
  ]

  for (const request of ownerOnly) {
    test("asking for " + request.kind + " reaches the owner with no decider call, instead of being answered with its recommended option", async () => {
      await withAskingTask(async (root) => {
        const heard: Array<DeciderRequest> = []
        await decide(root, replies({ [request.text]: answer }, heard))
        expect(heard).toEqual([])
        expect(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z")).toMatchObject({ owner: "user", decision: { kind: "escalated" }, state: { kind: "open" } })
        expect(filedAt(await itemFile(root, "orc-1.r4.2026-11-02T10_20_00_000Z"), "decision", "reason")).toContain("about " + request.topic)
      }, [{ id: "r4", text: request.text }])
    })
  }
})
