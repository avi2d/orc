import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { chatSession } from "../../packages/run/src/features/chat/chat-tools"
import { chatEnv, closeTask, type Fixture, orchestratorConfig, piFor, ranClosing, runOrc, sessionFor, until, waitPolls, withFixture } from "./chat-helpers"

const startTask = async (fixture: Fixture, id: string): Promise<void> => {
  const from = join(fixture.home, "backlog", "new", id + ".md")
  const to = join(fixture.home, "backlog", "taken", id + ".md")
  const text = await readFile(from, "utf8")
  await mkdir(join(fixture.home, "backlog", "taken"), { recursive: true })
  await writeFile(from, text.replace("\n---\n", "\n" + ranClosing("done", "", null).slice(0, 6).join("\n") + "\n---\n"))
  await rename(from, to)
}

const finishTask = async (fixture: Fixture, id: string, pr: string): Promise<void> => {
  const from = join(fixture.home, "backlog", "taken", id + ".md")
  const to = join(fixture.home, "backlog", "closed", id + ".md")
  const text = await readFile(from, "utf8")
  await mkdir(join(fixture.home, "backlog", "closed"), { recursive: true })
  await writeFile(from, text.replace("\n---\n", "\n" + ranClosing("done", "", pr).slice(6).join("\n") + "\n---\n"))
  await rename(from, to)
}

describe("orc chat tools", () => {
  test("posts a task the chat added once when it closes, PR and all, not while it is open and not twice", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const chat = sessionFor(fixture)
      await chat.call("orc_backlog_add", { project: "orc", task: "# Fix the typo\n" })
      await chat.postClosed()
      expect(chat.posted).toEqual([])
      await closeTask(fixture, "orc-1", ranClosing("done", "", "https://github.com/acme/orc/pull/7"))
      await chat.postClosed()
      await chat.postClosed()
      expect(chat.posted).toEqual(["orc-1 Fix the typo closed done, PR https://github.com/acme/orc/pull/7"])
    })
  }, 60_000)

  test("a close whose post fails stays unposted so the next chat posts it instead of losing it", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Fix the typo\n" })
      await closeTask(fixture, "orc-1", ranClosing("done", "", "https://github.com/acme/orc/pull/7"))
      const failing = chatSession(chatEnv(fixture), () => true, () => {
        throw new Error("post failed")
      })
      await failing.postClosed().then(() => {
        throw new Error("expected postClosed to fail")
      }, () => undefined)
      expect(await readFile(join(fixture.home, "backlog", "closed", "orc-1.md"), "utf8")).not.toContain("posted_at")
      const next = sessionFor(fixture)
      await next.postClosed()
      expect(next.posted).toEqual(["orc-1 Fix the typo closed done, PR https://github.com/acme/orc/pull/7"])
    })
  }, 60_000)

  test("posts a failed task's reason and that it has no PR instead of a blank PR", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const chat = sessionFor(fixture)
      await chat.call("orc_backlog_add", { project: "orc", task: "# Fix the typo\n" })
      await closeTask(fixture, "orc-1", ranClosing("failed", "the run failed", null))
      await chat.postClosed()
      expect(chat.posted).toEqual(["orc-1 Fix the typo closed failed: the run failed, with no PR"])
    })
  }, 60_000)

  test("posts once that the backlog cannot be read instead of following in silence or on every poll", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const chat = sessionFor(fixture)
      await chat.call("orc_backlog_add", { project: "orc", task: "# Fix the typo\n" })
      const broken = join(fixture.home, "backlog", "new", "orc-9.md")
      await writeFile(broken, "no frontmatter\n")
      await chat.postClosed()
      await chat.postClosed()
      expect(chat.posted).toEqual(["orc chat cannot post the closed tasks and events: orc: " + broken + ": the task file opens with no --- frontmatter"])
      await rm(broken)
      await closeTask(fixture, "orc-1", ranClosing("done", "", "https://github.com/acme/orc/pull/7"))
      await chat.postClosed()
      expect(chat.posted.at(-1)).toBe("orc-1 Fix the typo closed done, PR https://github.com/acme/orc/pull/7")
    })
  }, 60_000)

  test("Pi gets the closed task as a shown message that starts no model turn, not one steered into a running turn", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const pi = piFor(fixture, 50)
      await pi.add({ project: "orc", task: "# Fix the typo\n" })
      await closeTask(fixture, "orc-1", ranClosing("done", "", "https://github.com/acme/orc/pull/7"))
      pi.fire("session_start", { isIdle: () => true })
      await until(() => pi.sent.length > 0, 10_000)
      pi.fire("session_shutdown")
      expect(pi.sent).toEqual([{
        message: { customType: "orc-task-closed", content: "orc-1 Fix the typo closed done, PR https://github.com/acme/orc/pull/7", display: true },
        options: { triggerTurn: false }
      }])
    })
  }, 60_000)

  test("Pi gets nothing once its session shuts down, instead of a post into a stale session", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const pi = piFor(fixture, 50)
      await pi.add({ project: "orc", task: "# Fix the typo\n" })
      pi.fire("session_start", { isIdle: () => true })
      await waitPolls(pi, 1)
      pi.fire("session_shutdown")
      await closeTask(fixture, "orc-1", ranClosing("done", "", "https://github.com/acme/orc/pull/7"))
      const witness = piFor(fixture, 50)
      witness.fire("session_start", { isIdle: () => false })
      await waitPolls(witness)
      witness.fire("session_shutdown")
      expect(pi.sent).toEqual([])
      expect(await readFile(join(fixture.home, "backlog", "closed", "orc-1.md"), "utf8")).not.toContain("posted_at")
    })
  }, 60_000)

  test("while Pi streams a turn the close waits unmarked until idle instead of being lost", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const pi = piFor(fixture, 50)
      await pi.add({ project: "orc", task: "# Fix the typo\n" })
      await closeTask(fixture, "orc-1", ranClosing("done", "", "https://github.com/acme/orc/pull/7"))
      let idle = false
      pi.fire("session_start", { isIdle: () => idle })
      await waitPolls(pi)
      expect(pi.sent).toEqual([])
      expect(await readFile(join(fixture.home, "backlog", "closed", "orc-1.md"), "utf8")).not.toContain("posted_at")
      idle = true
      await until(() => pi.sent.length > 0, 10_000)
      const postedFile = join(fixture.home, "backlog", "closed", "orc-1.md")
      await until(() => Bun.file(postedFile).size > 0, 1_000).catch(() => undefined)
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await readFile(postedFile, "utf8").catch(() => "")).includes("posted_at")) {
          break
        }
        await Bun.sleep(20)
      }
      pi.fire("session_shutdown")
      expect(pi.sent.map((entry) => entry.message)).toEqual([
        { customType: "orc-task-closed", content: "orc-1 Fix the typo closed done, PR https://github.com/acme/orc/pull/7", display: true }
      ])
      expect(await readFile(join(fixture.home, "backlog", "closed", "orc-1.md"), "utf8")).toContain("posted_at")
    })
  }, 60_000)

  test("a failed mark retries without reposting the close and still posts later closes", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const chat = sessionFor(fixture)
      await chat.call("orc_backlog_add", { project: "orc", task: "# First\n" })
      await chat.call("orc_backlog_add", { project: "orc", task: "# Second\n" })
      await closeTask(fixture, "orc-1", ranClosing("done", "", null))
      await closeTask(fixture, "orc-2", ranClosing("done", "", null))
      const closedDir = join(fixture.home, "backlog", "closed")
      await chmod(closedDir, 0o555)
      try {
        await chat.postClosed()
        expect(chat.posted.slice(0, 2)).toEqual([
          "orc-1 First closed done, with no PR",
          "orc-2 Second closed done, with no PR"
        ])
        expect(chat.posted[2]).toStartWith("orc chat cannot post the closed tasks and events: ")
        await chat.postClosed()
        expect(chat.posted.length).toBe(3)
      } finally {
        await chmod(closedDir, 0o755)
      }
      await chat.postClosed()
      expect(chat.posted.length).toBe(3)
      expect(await readFile(join(closedDir, "orc-1.md"), "utf8")).toContain("posted_at")
      expect(await readFile(join(closedDir, "orc-2.md"), "utf8")).toContain("posted_at")
    })
  }, 60_000)

  test("posts a task the command line added, not only the tasks this chat added", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const chat = sessionFor(fixture)
      await writeFile(join(fixture.dir, "task.md"), "# Elsewhere\n")
      expect((await runOrc(fixture, ["backlog", "add", "orc", join(fixture.dir, "task.md")])).exitCode).toBe(0)
      await closeTask(fixture, "orc-1", ranClosing("done", "", "https://github.com/acme/orc/pull/8"))
      await chat.postClosed()
      expect(chat.posted).toEqual(["orc-1 Elsewhere closed done, PR https://github.com/acme/orc/pull/8"])
    })
  }, 60_000)

  test("a posted close carries posted_at in its task file and postedAt in orc backlog --json, so no later chat posts it again", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const chat = sessionFor(fixture)
      await chat.call("orc_backlog_add", { project: "orc", task: "# Fix the typo\n" })
      await closeTask(fixture, "orc-1", ranClosing("done", "", "https://github.com/acme/orc/pull/7"))
      const before = Date.now()
      await chat.postClosed()
      const file = await readFile(join(fixture.home, "backlog", "closed", "orc-1.md"), "utf8")
      const postedAt = /^posted_at: "([^"]+)"$/m.exec(file)?.[1] ?? ""
      expect(Date.parse(postedAt)).toBeGreaterThanOrEqual(before - 1_000)
      const json: unknown = JSON.parse((await runOrc(fixture, ["backlog", "--json"])).stdout)
      expect(json).toMatchObject({ tasks: [{ id: "orc-1", status: "closed", postedAt }] })
      const later = sessionFor(fixture)
      await later.postClosed()
      expect(later.posted).toEqual([])
    })
  }, 60_000)

  test("orc backlog posted refuses an open task instead of marking a close that has not happened", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Fix the typo\n" })
      const result = await runOrc(fixture, ["backlog", "posted", "orc-1"])
      expect([result.exitCode, result.stderr.trim()]).toEqual([1, "orc: orc-1 moved while orc read it, so run the command again"])
    })
  }, 60_000)

  test("closing and reopening the chat while a task runs posts its close exactly once, not never and not on every start", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const first = piFor(fixture, 50)
      await first.add({ project: "orc", task: "# Fix the typo\n" })
      await startTask(fixture, "orc-1")
      first.fire("session_start", { isIdle: () => true })
      await waitPolls(first)
      first.fire("session_shutdown")
      await finishTask(fixture, "orc-1", "https://github.com/acme/orc/pull/7")
      const reopened = piFor(fixture, 50)
      reopened.fire("session_start", { isIdle: () => true })
      await until(() => reopened.sent.length > 0, 10_000)
      await waitPolls(reopened)
      reopened.fire("session_shutdown")
      const again = piFor(fixture, 50)
      again.fire("session_start", { isIdle: () => true })
      await waitPolls(again)
      again.fire("session_shutdown")
      expect([first.sent, reopened.sent.map((sent) => sent.message), again.sent]).toEqual([
        [],
        [{ customType: "orc-task-closed", content: "orc-1 Fix the typo closed done, PR https://github.com/acme/orc/pull/7", display: true }],
        []
      ])
    })
  }, 60_000)

  test("closing and reopening the chat posts the close exactly once when the task closes while the reopened chat runs", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const first = piFor(fixture, 50)
      await first.add({ project: "orc", task: "# Fix the typo\n" })
      await startTask(fixture, "orc-1")
      first.fire("session_start", { isIdle: () => true })
      first.fire("session_shutdown")
      const reopened = piFor(fixture, 50)
      reopened.fire("session_start", { isIdle: () => true })
      await waitPolls(reopened)
      await finishTask(fixture, "orc-1", "https://github.com/acme/orc/pull/7")
      await until(() => reopened.sent.length > 0, 10_000)
      await waitPolls(reopened)
      reopened.fire("session_shutdown")
      expect([first.sent, reopened.sent.map((sent) => sent.message)]).toEqual([
        [],
        [{ customType: "orc-task-closed", content: "orc-1 Fix the typo closed done, PR https://github.com/acme/orc/pull/7", display: true }]
      ])
    })
  }, 60_000)

  test("an alert fire the stream writes is posted once as its own message with no beat, not again on a later poll or after a restart", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const fire = { schemaVersion: 1, rule: "heavy-load", at: "2026-11-02T11:31:00.000Z", machine: "mac", since: "2026-11-02T11:25:00.000Z", crossed: ["cpu"] }
      await writeFile(join(fixture.home, "backlog", "alerts.jsonl"), JSON.stringify(fire) + "\n")
      const first = piFor(fixture, 50)
      first.fire("session_start", { isIdle: () => true })
      await until(() => first.sent.length > 0, 10_000)
      await waitPolls(first)
      first.fire("session_shutdown")
      const reopened = piFor(fixture, 50)
      reopened.fire("session_start", { isIdle: () => true })
      await waitPolls(reopened)
      reopened.fire("session_shutdown")
      expect([first.sent.map((sent) => sent.message), reopened.sent]).toEqual([
        [{ customType: "orc-event", content: "alert: mac over its cpu limit since 2026-11-02T11:25:00.000Z", display: true }],
        []
      ])
    })
  }, 60_000)
})
