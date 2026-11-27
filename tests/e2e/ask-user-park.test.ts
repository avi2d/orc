import { describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
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
  test("an unanswered orc_ask about a generate-assets allowance below 20 percent parks the task with that question instead of closing it failed", async () => {
    await withFixture(async (fixture: Fixture) => {
      const question = {
        id: "ask-1",
        text: "The generate-assets reading shows the Codex weekly allowance at 12 percent, below its 20 percent threshold, so make the images anyway?\nA) Make them now\n   Leads to: Codex spends the rest of the weekly allowance\nB) Wait for the reset\n   Leads to: The design lands without images until the allowance resets"
      }
      await parksWith(fixture, await failedRunAsking(fixture, "implement", question), question)
    })
  }, runnerTimeout)
})
