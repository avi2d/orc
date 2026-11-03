import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chatSession, orcCommandVar } from "../../packages/run/src/chat-tools"

describe("the parked-question listing", () => {
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
          parked: { branch: "orc/task-1", questions: [{ id: "question-4", text: "REST or gRPC?", answer: null }] }
        }],
        events: []
      }))
      env[orcCommandVar] = JSON.stringify(["sh", "-c", "cat " + fixture])
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
        JSON.stringify({ tasks: [{ id: "task-1", title: "Pick the API", status: "new", hold: { reason: "REST or gRPC", until: null, answer: null }, parked: null }], events: [] })
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
