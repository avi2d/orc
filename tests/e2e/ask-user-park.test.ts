import { describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { backlogTaskOne, refuseOnQuestions, startOnLinux } from "./parked-helpers"
import { orcOk, queuedArgs, runnerTimeout, withFixture, type Fixture } from "./runner-helpers"

const failedRunAsking = async (fixture: Fixture, stepName: string, question: { readonly id: string; readonly text: string }): Promise<string> => {
  await startOnLinux(fixture)
  await refuseOnQuestions(fixture, [question], stepName)
  return orcOk(fixture, ["beat"])
}

const parksWith = async (fixture: Fixture, parked: string, question: { readonly id: string; readonly text: string }): Promise<void> => {
  expect(parked).toContain(`parked orc-1 on orc/orc-1 for the captain's answer to ${question.id}`)
  expect(parked).not.toContain("closed orc-1")
  expect(await backlogTaskOne(fixture)).toMatchObject({
    id: "orc-1",
    status: "new",
    parked: { branch: "orc/orc-1", questions: [{ ...question, answer: null }] }
  })
}

describe("an ask-user finding parks as a question", () => {
  test("an unanswered ask-user finding parks with its text and resumes with its answer instead of closing failed", async () => {
    await withFixture(async (fixture: Fixture) => {
      const question = { id: "r2", text: "changes product behavior" }
      await parksWith(fixture, await failedRunAsking(fixture, "no-mistakes", question), question)
      expect(await orcOk(fixture, ["backlog", "answer", "orc-1", "r2=Keep the flag"])).toBe("answered r2 on orc-1, so the beat resumes it on orc/orc-1\n")
      await rm(join(fixture.pueue, "add-args"), { force: true })
      expect(await orcOk(fixture, ["beat"])).toContain("started orc-1")
      const added = await queuedArgs(fixture)
      expect(added?.slice(added.indexOf("--answer"), added.indexOf("--answer") + 2)).toEqual(["--answer", "r2=Keep the flag"])
    })
  }, runnerTimeout)
})

describe("a worker question about a low image allowance parks as a question", () => {
  test("an orc_ask about a generate-assets allowance below 20 percent that times out parks the task with its options and recommendation instead of closing it failed", async () => {
    await withFixture(async (fixture: Fixture) => {
      const options = [
        { text: "Make them now", outcome: "Codex spends the rest of the weekly allowance" },
        { text: "Wait for the reset", outcome: "The design lands without images until the allowance resets" }
      ]
      const recommendation = "Wait for the reset"
      const text = [
        "Make the images with the Codex weekly allowance at 12 percent?",
        "Context: generate-assets read the allowance below its 20 percent threshold.",
        "A) Make them now",
        "   Leads to: Codex spends the rest of the weekly allowance",
        "B) Wait for the reset",
        "   Leads to: The design lands without images until the allowance resets",
        "Recommended: B) Wait for the reset"
      ].join("\n")
      const question = { id: "ask-1", text, options, recommendation }
      await startOnLinux(fixture)
      await refuseOnQuestions(fixture, [{ id: "ask-1", text }], "implement")
      const runDir = join(fixture.home, "runs", "run-1")
      await mkdir(runDir, { recursive: true })
      await writeFile(join(runDir, "asking.json"), JSON.stringify({
        asked: "2026-11-02T10:20:00.000Z",
        until: "2026-11-02T10:30:00.000Z",
        questions: [question]
      }))
      await parksWith(fixture, await orcOk(fixture, ["beat"]), question)
    })
  }, runnerTimeout)
})
