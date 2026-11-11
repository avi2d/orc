import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { parkedListing } from "../../packages/run/src/chat-parked"
import { chatSession, orcCommandVar } from "../../packages/run/src/chat-tools"

describe("the parked-question listing", () => {
  test("polling does not post a decider-owned question while posting a user-owned question", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-chat-owner-"))
    try {
      const backlog = join(dir, "backlog.json")
      const attention = join(dir, "attention.json")
      const asked = "2026-11-02T10:20:00.000Z"
      await writeFile(backlog, JSON.stringify({ tasks: [{
        id: "task-1", title: "Pick the API", status: "new", hold: null,
        parked: { branch: "orc/task-1", questions: [
          { id: "question-1", text: "Routine?", asked, answer: null },
          { id: "question-2", text: "Choice?", asked, answer: null }
        ] }
      }], events: [] }))
      await writeFile(attention, JSON.stringify({ items: [
        { id: "task-1.question-1.2026-11-02T10_20_00_000Z", kind: "review-question", task: "task-1", text: "Routine?", asked, owner: "decider" },
        { id: "task-1.question-2.2026-11-02T10_20_00_000Z", kind: "review-question", task: "task-1", text: "Choice?", asked, owner: "user" }
      ], decided: [] }))
      const env = { [orcCommandVar]: JSON.stringify(["sh", "-c", 'case "$3" in attention) cat "$2";; *) cat "$1";; esac', "sh", backlog, attention]) }
      const posted: Array<string> = []
      const session = chatSession(env, () => true, (text) => { posted.push(text) })
      await session.postParked()
      expect(posted).toEqual(["task-1 Pick the API is parked on orc/task-1 for the captain's answer to question-2: Choice?"])
      await writeFile(attention, JSON.stringify({ items: [], decided: [
        { id: "task-1.question-1.2026-11-02T10_20_00_000Z", owner: "decider" }
      ] }))
      session.listParkedAgain()
      posted.length = 0
      await session.postParked()
      expect(posted).toEqual(["task-1 Pick the API is parked on orc/task-1 for the captain's answer to question-2: Choice?"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test("a failed read or a busy Pi lists the parked question on a later poll instead of counting it shown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-chat-parked-"))
    try {
      const fixture = join(dir, "backlog.json")
      const env: Record<string, string | undefined> = { [orcCommandVar]: JSON.stringify(["sh", "-c", "exit 1"]) }
      const posted: Array<{ readonly text: string; readonly kind: string }> = []
      let open = true
      const session = chatSession(env, () => open, (text, kind) => {
        posted.push({ text, kind })
      })
      await session.postParked()
      await session.postParked()
      expect(posted.map((entry) => entry.kind)).toEqual(["parked"])
      await writeFile(fixture, JSON.stringify({
        tasks: [{
          id: "task-1",
          title: "Pick the API",
          status: "new",
          hold: null,
          parked: { branch: "orc/task-1", questions: [{ id: "question-4", text: "REST or gRPC?", asked: "2026-11-02T10:20:00.000Z", answer: null }] }
        }],
        events: []
      }))
      env[orcCommandVar] = JSON.stringify(["sh", "-c", 'case "$2" in attention) echo \'{"items":[],"decided":[]}\';; *) cat "$1";; esac', "sh", fixture])
      open = false
      await session.postParked()
      expect(posted).toHaveLength(1)
      open = true
      await session.postParked()
      await session.postParked()
      expect(posted.slice(1)).toEqual([{ text: "task-1 Pick the API is parked on orc/task-1 for the captain's answer to question-4: REST or gRPC?", kind: "parked" }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  test("a question asked again posts again instead of staying hidden as already shown", async () => {
    const task = (asked: string) => ({
      id: "task-1",
      title: "Pick the API",
      parked: { branch: "orc/task-1", questions: [{ id: "question-4", text: "REST or gRPC?", asked, answer: null }] }
    })
    let asked = "2026-11-02T10:20:00.000Z"
    const delivered: Array<string> = []
    const listing = parkedListing(Effect.sync(() => ({ tasks: [task(asked)], deciderOwned: new Set<string>() })), (text) => {
      delivered.push(text)
      return true
    })
    await Effect.runPromise(listing.post)
    expect(delivered).toHaveLength(1)
    asked = "2026-11-02T11:20:00.000Z"
    await Effect.runPromise(listing.post)
    expect(delivered).toHaveLength(2)
    expect(delivered[0]).toContain("question-4")
    expect(delivered[1]).toContain("question-4")
  })
})

describe("the startup held-decision listing", () => {
  test("a held-list error is posted once across polls instead of on every poll, then the held decision is listed once a later read succeeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orc-chat-held-"))
    try {
      const fixture = join(dir, "backlog.json")
      const env: Record<string, string | undefined> = { [orcCommandVar]: JSON.stringify(["sh", "-c", "exit 1"]) }
      const posted: Array<{ readonly text: string; readonly kind: string }> = []
      const session = chatSession(env, () => true, (text, kind) => {
        posted.push({ text, kind })
      })
      expect(await session.postHeld()).toBe(false)
      expect(posted).toHaveLength(1)
      expect(posted[0]?.kind).toBe("held")
      expect(await session.postHeld()).toBe(false)
      expect(posted).toHaveLength(1)
      await writeFile(
        fixture,
        JSON.stringify({ tasks: [{ id: "task-1", title: "Pick the API", status: "new", hold: { reason: "REST or gRPC", until: null, questions: [], answer: null }, parked: null }], events: [] })
      )
      env[orcCommandVar] = JSON.stringify(["sh", "-c", "cat " + fixture])
      expect(await session.postHeld()).toBe(true)
      expect(posted).toHaveLength(2)
      expect(posted[1]).toEqual({ text: "task-1 Pick the API is held for the captain: REST or gRPC", kind: "held" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
