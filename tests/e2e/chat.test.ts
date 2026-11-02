import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { chatExtension, chatSession, type ChatTool } from "../../packages/run/src/chat-tools"

const binPath = new URL("../../packages/run/src/bin.ts", import.meta.url).pathname
const chatToolsPath = new URL("../../packages/run/src/chat-tools.ts", import.meta.url).pathname

interface Fixture {
  readonly dir: string
  readonly home: string
  readonly env: Record<string, string>
  readonly piLog: string
}

const fakePi = (log: string, exitCode: number): string =>
  [
    "#!/bin/sh",
    "for arg in \"$@\"; do printf '%s\\n' \"$arg\" >> '" + log + "'; done",
    "printf 'ORC_CHAT_ORC=%s\\n' \"$ORC_CHAT_ORC\" >> '" + log + "'",
    "exit " + exitCode,
    ""
  ].join("\n")

const withFixture = async (config: unknown, piExit: number, body: (fixture: Fixture) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-chat-e2e-"))
  try {
    const bin = join(dir, "bin")
    const home = join(dir, "home")
    const piLog = join(dir, "pi.log")
    await mkdir(bin, { recursive: true })
    await mkdir(join(home, "backlog"), { recursive: true })
    await writeFile(join(bin, "pi"), fakePi(piLog, piExit))
    await chmod(join(bin, "pi"), 0o755)
    if (config !== null) {
      await writeFile(join(home, "config.json"), JSON.stringify(config))
    }
    await writeFile(join(home, "backlog", "dispatch.json"), JSON.stringify({
      machines: [{ name: "mac", slots: 1, start: ["true"] }],
      quota: { provider: "acme", command: ["true"], accounts: [{ name: "main", tokenFile: "/x" }], floorPercent: 15 }
    }))
    await writeFile(join(home, "backlog", "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: dir } }] }))
    await body({ dir, home, env: { ORC_HOME: home, PATH: bin + ":" + (process.env.PATH ?? "") }, piLog })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const runOrc = async (fixture: Fixture, args: ReadonlyArray<string>): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, binPath, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: fixture.dir,
    env: { ...process.env, ...fixture.env }
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}

const BacklogJson = Schema.fromJsonString(Schema.Struct({
  tasks: Schema.Array(Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    project: Schema.String,
    machine: Schema.NullOr(Schema.String),
    status: Schema.String,
    dependsOn: Schema.Array(Schema.String)
  }))
}))

const decodeBacklog = Schema.decodeUnknownSync(BacklogJson)

const orchestratorConfig = { providers: [], models: { orchestrator: "acme/orchestrator-1" } }

const chatEnv = (fixture: Fixture) => ({ ...process.env, ...fixture.env, ORC_CHAT_ORC: JSON.stringify([process.execPath, binPath]) })

const sessionFor = (fixture: Fixture) => {
  const posted: Array<string> = []
  const session = chatSession(chatEnv(fixture), () => true, (text) => posted.push(text))
  const byName = new Map(session.tools.map((tool) => [tool.name, tool]))
  const call = (name: string, params: unknown) => {
    const tool = byName.get(name)
    if (tool === undefined) {
      throw new Error("orc chat has no tool " + name)
    }
    return tool.execute("call-1", params).then((result) => result.content.map((block) => block.text).join(""))
  }
  return { call, posted, postClosed: session.postClosed }
}

const toolsFor = (fixture: Fixture) => sessionFor(fixture).call

const ranClosing = (outcome: "done" | "failed", reason: string, pr: string | null): ReadonlyArray<string> => [
  "beat: \"beat-1\"",
  "taken_for: \"mac\"",
  "account: \"main\"",
  "taken_at: \"2026-11-02T10:01:00.000Z\"",
  "started_at: \"2026-11-02T10:02:00.000Z\"",
  "start_log: \"/tmp/task.log\"",
  "outcome: " + JSON.stringify(outcome),
  "closed_at: \"2026-11-02T11:00:00.000Z\"",
  "reason: " + JSON.stringify(reason),
  ...(pr === null ? [] : ["pr: " + JSON.stringify(pr)])
]

type ChatHost = Parameters<ReturnType<typeof chatExtension>>[0]

const piFor = (fixture: Fixture, pollMillis: number) => {
  const tools = new Map<string, ChatTool>()
  const handlers = new Map<string, (event: string, ctx?: { isIdle: () => boolean }) => void>()
  const sent: Array<{ readonly message: unknown; readonly options: unknown }> = []
  const host: ChatHost = {
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (event, handler) => handlers.set(event, handler),
    sendMessage: (message, options) => sent.push({ message, options })
  }
  chatExtension(chatEnv(fixture), pollMillis)(host)
  const add = (params: unknown) => tools.get("orc_backlog_add")?.execute("call-1", params)
  const call = (name: string, params: unknown) => tools.get(name)?.execute("call-1", params).then((result) => result.content.map((block) => block.text).join(""))
  return { add, call, sent, fire: (event: string, ctx?: { isIdle: () => boolean }) => handlers.get(event)?.(event, ctx) }
}

const until = async (done: () => boolean, millis: number): Promise<void> => {
  const end = Date.now() + millis
  while (!done() && Date.now() < end) {
    await Bun.sleep(20)
  }
}

const closeTask = async (fixture: Fixture, id: string, fields: ReadonlyArray<string>): Promise<void> => {
  const from = join(fixture.home, "backlog", "new", id + ".md")
  const to = join(fixture.home, "backlog", "closed", id + ".md")
  const text = await readFile(from, "utf8")
  await mkdir(join(fixture.home, "backlog", "closed"), { recursive: true })
  await writeFile(from, text.replace("\n---\n", "\n" + fields.join("\n") + "\n---\n"))
  await rename(from, to)
}

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

const rejection = (pending: Promise<string>): Promise<string> =>
  pending.then((text) => "resolved with " + text, (error: unknown) => error instanceof Error ? error.message : String(error))

describe("orc chat", () => {
  test("starts pi on models.orchestrator with only the chat tools, not on Pi's default model and tools", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const result = await runOrc(fixture, ["chat"])
      expect(result.stderr).toBe("")
      expect(result.exitCode).toBe(0)
      const lines = (await readFile(fixture.piLog, "utf8")).trimEnd().split("\n")
      expect(lines).toEqual([
        "--model",
        "acme/orchestrator-1",
        "--extension",
        chatToolsPath,
        "--tools",
        "orc_backlog_add,orc_backlog,orc_backlog_hold,orc_backlog_answer",
        "ORC_CHAT_ORC=" + JSON.stringify([process.execPath, binPath])
      ])
    })
  }, 60_000)

  test("appends orchestrator.md to pi's system prompt and names it on the first line instead of starting without the rules", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const rules = join(fixture.home, "orchestrator.md")
      await writeFile(rules, "# Rules\n")
      const result = await runOrc(fixture, ["chat"])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.split("\n")[0]).toBe("orc chat loaded the rules in " + rules)
      const lines = (await readFile(fixture.piLog, "utf8")).trimEnd().split("\n")
      expect(lines.slice(lines.indexOf("--append-system-prompt"), lines.indexOf("--append-system-prompt") + 2)).toEqual(["--append-system-prompt", rules])
    })
  }, 60_000)

  test("passes pi no rules flag for a missing orchestrator.md and says none were found, instead of a path pi cannot read", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const result = await runOrc(fixture, ["chat"])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.split("\n")[0]).toBe("orc chat found no rules at " + join(fixture.home, "orchestrator.md"))
      const lines = (await readFile(fixture.piLog, "utf8")).trimEnd().split("\n")
      expect(lines).not.toContain("--append-system-prompt")
      expect(lines).not.toContain(join(fixture.home, "orchestrator.md"))
    })
  }, 60_000)

  test("refuses with no models.orchestrator instead of starting pi on Pi's default model", async () => {
    await withFixture({ providers: [], models: { implementer: "acme/implementer-1" } }, 0, async (fixture) => {
      const result = await runOrc(fixture, ["chat"])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("orc chat needs models.orchestrator in " + join(fixture.home, "config.json"))
      expect(await Bun.file(fixture.piLog).exists()).toBe(false)
    })
  }, 60_000)

  test("exits non-zero when pi does instead of reporting a failed chat as success", async () => {
    await withFixture(orchestratorConfig, 3, async (fixture) => {
      const result = await runOrc(fixture, ["chat"])
      expect(result.exitCode).not.toBe(0)
    })
  }, 60_000)
})

describe("orc chat tools", () => {
  test("a task the add tool takes lands in the backlog through orc backlog add, title, machine and all", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const call = toolsFor(fixture)
      expect(await call("orc_backlog_add", { project: "orc", task: "# Fix the typo\n\nThe word teh in the intro.\n", machine: "mac" })).toBe("added task-1 for orc on mac")
      const backlog = decodeBacklog(await call("orc_backlog", {}))
      expect(backlog.tasks).toEqual([{ id: "task-1", title: "Fix the typo", project: "orc", machine: "mac", status: "new", dependsOn: [] }])
      expect(await readFile(join(fixture.home, "backlog", "new", "task-1.md"), "utf8")).toContain("# Fix the typo\n\nThe word teh in the intro.\n")
    })
  }, 60_000)

  test("the add tool passes each dependency to orc instead of dropping them", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const call = toolsFor(fixture)
      await call("orc_backlog_add", { project: "orc", task: "# First\n" })
      await call("orc_backlog_add", { project: "orc", task: "# Second\n", dependsOn: ["task-1"] })
      const backlog = decodeBacklog(await call("orc_backlog", {}))
      expect(backlog.tasks.map((task) => [task.id, task.dependsOn])).toEqual([["task-1", []], ["task-2", ["task-1"]]])
    })
  }, 60_000)

  test("the add tool fails with orc's own refusal instead of a bare exit code", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const call = toolsFor(fixture)
      expect(await rejection(call("orc_backlog_add", { project: "nowhere", task: "# Lost\n" }))).toBe("orc: the project nowhere is not in " + join(fixture.home, "backlog", "projects.json"))
    })
  }, 60_000)

  test("posts a task the chat added once when it closes, PR and all, not while it is open and not twice", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const chat = sessionFor(fixture)
      await chat.call("orc_backlog_add", { project: "orc", task: "# Fix the typo\n" })
      await chat.postClosed()
      expect(chat.posted).toEqual([])
      await closeTask(fixture, "task-1", ranClosing("done", "", "https://github.com/acme/orc/pull/7"))
      await chat.postClosed()
      await chat.postClosed()
      expect(chat.posted).toEqual(["task-1 Fix the typo closed done, PR https://github.com/acme/orc/pull/7"])
    })
  }, 60_000)

  test("a close whose post fails stays unposted so the next chat posts it instead of losing it", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Fix the typo\n" })
      await closeTask(fixture, "task-1", ranClosing("done", "", "https://github.com/acme/orc/pull/7"))
      const failing = chatSession(chatEnv(fixture), () => true, () => {
        throw new Error("post failed")
      })
      await failing.postClosed().then(() => {
        throw new Error("expected postClosed to fail")
      }, () => undefined)
      expect(await readFile(join(fixture.home, "backlog", "closed", "task-1.md"), "utf8")).not.toContain("posted_at")
      const next = sessionFor(fixture)
      await next.postClosed()
      expect(next.posted).toEqual(["task-1 Fix the typo closed done, PR https://github.com/acme/orc/pull/7"])
    })
  }, 60_000)

  test("posts a failed task's reason and that it has no PR instead of a blank PR", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const chat = sessionFor(fixture)
      await chat.call("orc_backlog_add", { project: "orc", task: "# Fix the typo\n" })
      await closeTask(fixture, "task-1", ranClosing("failed", "the run failed", null))
      await chat.postClosed()
      expect(chat.posted).toEqual(["task-1 Fix the typo closed failed: the run failed, with no PR"])
    })
  }, 60_000)

  test("posts once that the backlog cannot be read instead of following in silence or on every poll", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const chat = sessionFor(fixture)
      await chat.call("orc_backlog_add", { project: "orc", task: "# Fix the typo\n" })
      const broken = join(fixture.home, "backlog", "new", "task-9.md")
      await writeFile(broken, "no frontmatter\n")
      await chat.postClosed()
      await chat.postClosed()
      expect(chat.posted).toEqual(["orc chat cannot post the closed tasks: orc: " + broken + ": the task file opens with no --- frontmatter"])
      await rm(broken)
      await closeTask(fixture, "task-1", ranClosing("done", "", "https://github.com/acme/orc/pull/7"))
      await chat.postClosed()
      expect(chat.posted.at(-1)).toBe("task-1 Fix the typo closed done, PR https://github.com/acme/orc/pull/7")
    })
  }, 60_000)

  test("Pi gets the closed task as a shown message that starts no model turn, not one steered into a running turn", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const pi = piFor(fixture, 50)
      await pi.add({ project: "orc", task: "# Fix the typo\n" })
      await closeTask(fixture, "task-1", ranClosing("done", "", "https://github.com/acme/orc/pull/7"))
      pi.fire("session_start", { isIdle: () => true })
      await until(() => pi.sent.length > 0, 10_000)
      pi.fire("session_shutdown")
      expect(pi.sent).toEqual([{
        message: { customType: "orc-task-closed", content: "task-1 Fix the typo closed done, PR https://github.com/acme/orc/pull/7", display: true },
        options: { triggerTurn: false }
      }])
    })
  }, 60_000)

  test("Pi gets nothing once its session shuts down, instead of a post into a stale session", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const pi = piFor(fixture, 50)
      await pi.add({ project: "orc", task: "# Fix the typo\n" })
      pi.fire("session_start", { isIdle: () => true })
      pi.fire("session_shutdown")
      await closeTask(fixture, "task-1", ranClosing("done", "", "https://github.com/acme/orc/pull/7"))
      await Bun.sleep(1_000)
      expect(pi.sent).toEqual([])
      expect(await readFile(join(fixture.home, "backlog", "closed", "task-1.md"), "utf8")).not.toContain("posted_at")
    })
  }, 60_000)

  test("while Pi streams a turn the close waits unmarked until idle instead of being lost", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const pi = piFor(fixture, 50)
      await pi.add({ project: "orc", task: "# Fix the typo\n" })
      await closeTask(fixture, "task-1", ranClosing("done", "", "https://github.com/acme/orc/pull/7"))
      let idle = false
      pi.fire("session_start", { isIdle: () => idle })
      await Bun.sleep(500)
      expect(pi.sent).toEqual([])
      expect(await readFile(join(fixture.home, "backlog", "closed", "task-1.md"), "utf8")).not.toContain("posted_at")
      idle = true
      await until(() => pi.sent.length > 0, 10_000)
      const postedFile = join(fixture.home, "backlog", "closed", "task-1.md")
      await until(() => Bun.file(postedFile).size > 0, 1_000).catch(() => undefined)
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await readFile(postedFile, "utf8")).includes("posted_at")) {
          break
        }
        await Bun.sleep(20)
      }
      pi.fire("session_shutdown")
      expect(pi.sent.map((entry) => entry.message)).toEqual([
        { customType: "orc-task-closed", content: "task-1 Fix the typo closed done, PR https://github.com/acme/orc/pull/7", display: true }
      ])
      expect(await readFile(join(fixture.home, "backlog", "closed", "task-1.md"), "utf8")).toContain("posted_at")
    })
  }, 60_000)

  test("a failed mark retries without reposting the close and still posts later closes", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const chat = sessionFor(fixture)
      await chat.call("orc_backlog_add", { project: "orc", task: "# First\n" })
      await chat.call("orc_backlog_add", { project: "orc", task: "# Second\n" })
      await closeTask(fixture, "task-1", ranClosing("done", "", null))
      await closeTask(fixture, "task-2", ranClosing("done", "", null))
      const closedDir = join(fixture.home, "backlog", "closed")
      await chmod(closedDir, 0o555)
      try {
        await chat.postClosed()
        expect(chat.posted.slice(0, 2)).toEqual([
          "task-1 First closed done, with no PR",
          "task-2 Second closed done, with no PR"
        ])
        expect(chat.posted[2]).toStartWith("orc chat cannot post the closed tasks: ")
        await chat.postClosed()
        expect(chat.posted.length).toBe(3)
      } finally {
        await chmod(closedDir, 0o755)
      }
      await chat.postClosed()
      expect(chat.posted.length).toBe(3)
      expect(await readFile(join(closedDir, "task-1.md"), "utf8")).toContain("posted_at")
      expect(await readFile(join(closedDir, "task-2.md"), "utf8")).toContain("posted_at")
    })
  }, 60_000)

  test("posts a task the command line added, not only the tasks this chat added", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const chat = sessionFor(fixture)
      await writeFile(join(fixture.dir, "task.md"), "# Elsewhere\n")
      expect((await runOrc(fixture, ["backlog", "add", "orc", join(fixture.dir, "task.md")])).exitCode).toBe(0)
      await closeTask(fixture, "task-1", ranClosing("done", "", "https://github.com/acme/orc/pull/8"))
      await chat.postClosed()
      expect(chat.posted).toEqual(["task-1 Elsewhere closed done, PR https://github.com/acme/orc/pull/8"])
    })
  }, 60_000)

  test("a posted close carries posted_at in its task file and postedAt in orc backlog --json, so no later chat posts it again", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const chat = sessionFor(fixture)
      await chat.call("orc_backlog_add", { project: "orc", task: "# Fix the typo\n" })
      await closeTask(fixture, "task-1", ranClosing("done", "", "https://github.com/acme/orc/pull/7"))
      const before = Date.now()
      await chat.postClosed()
      const file = await readFile(join(fixture.home, "backlog", "closed", "task-1.md"), "utf8")
      const postedAt = /^posted_at: "([^"]+)"$/m.exec(file)?.[1] ?? ""
      expect(Date.parse(postedAt)).toBeGreaterThanOrEqual(before - 1_000)
      const json: unknown = JSON.parse((await runOrc(fixture, ["backlog", "--json"])).stdout)
      expect(json).toMatchObject({ tasks: [{ id: "task-1", status: "closed", postedAt }] })
      const later = sessionFor(fixture)
      await later.postClosed()
      expect(later.posted).toEqual([])
    })
  }, 60_000)

  test("orc backlog posted refuses an open task instead of marking a close that has not happened", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      await sessionFor(fixture).call("orc_backlog_add", { project: "orc", task: "# Fix the typo\n" })
      const result = await runOrc(fixture, ["backlog", "posted", "task-1"])
      expect([result.exitCode, result.stderr.trim()]).toEqual([1, "orc: the backlog holds no closed task-1"])
    })
  }, 60_000)

  test("closing and reopening the chat while a task runs posts its close exactly once, not never and not on every start", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const first = piFor(fixture, 50)
      await first.add({ project: "orc", task: "# Fix the typo\n" })
      await startTask(fixture, "task-1")
      first.fire("session_start", { isIdle: () => true })
      await Bun.sleep(300)
      first.fire("session_shutdown")
      await finishTask(fixture, "task-1", "https://github.com/acme/orc/pull/7")
      const reopened = piFor(fixture, 50)
      reopened.fire("session_start", { isIdle: () => true })
      await until(() => reopened.sent.length > 0, 10_000)
      await Bun.sleep(500)
      reopened.fire("session_shutdown")
      const again = piFor(fixture, 50)
      again.fire("session_start", { isIdle: () => true })
      await Bun.sleep(1_000)
      again.fire("session_shutdown")
      expect([first.sent, reopened.sent.map((sent) => sent.message), again.sent]).toEqual([
        [],
        [{ customType: "orc-task-closed", content: "task-1 Fix the typo closed done, PR https://github.com/acme/orc/pull/7", display: true }],
        []
      ])
    })
  }, 60_000)

  test("closing and reopening the chat posts the close exactly once when the task closes while the reopened chat runs", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const first = piFor(fixture, 50)
      await first.add({ project: "orc", task: "# Fix the typo\n" })
      await startTask(fixture, "task-1")
      first.fire("session_start", { isIdle: () => true })
      first.fire("session_shutdown")
      const reopened = piFor(fixture, 50)
      reopened.fire("session_start", { isIdle: () => true })
      await Bun.sleep(300)
      await finishTask(fixture, "task-1", "https://github.com/acme/orc/pull/7")
      await until(() => reopened.sent.length > 0, 10_000)
      await Bun.sleep(500)
      reopened.fire("session_shutdown")
      expect([first.sent, reopened.sent.map((sent) => sent.message)]).toEqual([
        [],
        [{ customType: "orc-task-closed", content: "task-1 Fix the typo closed done, PR https://github.com/acme/orc/pull/7", display: true }]
      ])
    })
  }, 60_000)

  test("an open held decision is listed again after the chat restarts, once per start, and the beat still refuses it", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const first = piFor(fixture, 50)
      await first.add({ project: "orc", task: "# Pick the API\n" })
      expect(await first.call("orc_backlog_hold", { id: "task-1", reason: "REST or gRPC", until: "2026-12-01" })).toBe("held task-1: REST or gRPC, until 2026-12-01")
      const heldPost = { customType: "orc-held-decision", content: "task-1 Pick the API is held for the captain: REST or gRPC, until 2026-12-01", display: true }
      first.fire("session_start", { isIdle: () => true })
      await until(() => first.sent.length > 0, 10_000)
      await Bun.sleep(500)
      first.fire("session_shutdown")
      const reopened = piFor(fixture, 50)
      reopened.fire("session_start", { isIdle: () => true })
      await until(() => reopened.sent.length > 0, 10_000)
      await Bun.sleep(500)
      reopened.fire("session_shutdown")
      expect([first.sent, reopened.sent]).toEqual([[{ message: heldPost, options: { triggerTurn: false } }], [{ message: heldPost, options: { triggerTurn: false } }]])
      const beat = await runOrc(fixture, ["beat"])
      expect(beat.stdout).toContain("waits task-1: held for the captain: REST or gRPC, until 2026-12-01")
      expect(await Bun.file(join(fixture.home, "backlog", "new", "task-1.md")).exists()).toBe(true)
    })
  }, 60_000)

  test("a chat that starts mid-turn lists the held decision once Pi is idle instead of dropping it", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const pi = piFor(fixture, 50)
      await pi.add({ project: "orc", task: "# Pick the API\n" })
      await pi.call("orc_backlog_hold", { id: "task-1", reason: "REST or gRPC" })
      let idle = false
      pi.fire("session_start", { isIdle: () => idle })
      await Bun.sleep(500)
      expect(pi.sent).toEqual([])
      idle = true
      await until(() => pi.sent.length > 0, 10_000)
      await Bun.sleep(500)
      pi.fire("session_shutdown")
      expect(pi.sent.map((sent) => sent.message)).toEqual([{ customType: "orc-held-decision", content: "task-1 Pick the API is held for the captain: REST or gRPC", display: true }])
    })
  }, 60_000)

  test("an answered decision is not listed at chat start and the answer tool keeps the captain's words whole", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const pi = piFor(fixture, 50)
      await pi.add({ project: "orc", task: "# Pick the API\n" })
      await pi.add({ project: "orc", task: "# Pick the store\n" })
      await pi.call("orc_backlog_hold", { id: "task-1", reason: "REST or gRPC" })
      await pi.call("orc_backlog_hold", { id: "task-2", reason: "SQLite or Postgres" })
      const words = "REST --until never, and keep  v1"
      expect(await pi.call("orc_backlog_answer", { id: "task-1", words })).toBe("answered task-1, so the beat may start it")
      pi.fire("session_start", { isIdle: () => true })
      await until(() => pi.sent.length > 0, 10_000)
      await Bun.sleep(500)
      pi.fire("session_shutdown")
      expect(pi.sent.map((sent) => sent.message)).toEqual([{ customType: "orc-held-decision", content: "task-2 Pick the store is held for the captain: SQLite or Postgres", display: true }])
      expect(await readFile(join(fixture.home, "backlog", "new", "task-1.md"), "utf8")).toContain("answer: " + JSON.stringify(words))
    })
  }, 60_000)

  test("the hold and answer tools fail with orc's own refusal and refuse an unknown field instead of dropping it", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const call = toolsFor(fixture)
      expect(await rejection(call("orc_backlog_hold", { id: "task-9", reason: "why" }))).toBe("orc: the backlog holds no task-9")
      expect(await rejection(call("orc_backlog_answer", { id: "task-9", words: "yes" }))).toBe("orc: the backlog holds no task-9")
      expect(await rejection(call("orc_backlog_hold", { id: "task-1", reason: "why", priority: "high" }))).toStartWith("orc_backlog_hold takes ")
      expect(await rejection(call("orc_backlog_answer", { id: "task-1" }))).toStartWith("orc_backlog_answer takes ")
    })
  }, 60_000)

  test("the add tool refuses an unknown field instead of dropping it", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const call = toolsFor(fixture)
      expect(await rejection(call("orc_backlog_add", { project: "orc", task: "# Fast\n", priority: "high" }))).toStartWith("orc_backlog_add takes ")
      expect(await Bun.file(join(fixture.home, "backlog", "new", "task-1.md")).exists()).toBe(false)
    })
  }, 60_000)
})
