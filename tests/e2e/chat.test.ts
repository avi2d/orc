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
  const session = chatSession(chatEnv(fixture), (text) => posted.push(text))
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
  const handlers = new Map<string, () => void>()
  const sent: Array<{ readonly message: unknown; readonly options: unknown }> = []
  const host: ChatHost = {
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (event, handler) => handlers.set(event, handler),
    sendMessage: (message, options) => sent.push({ message, options })
  }
  chatExtension(chatEnv(fixture), pollMillis)(host)
  const add = (params: unknown) => tools.get("orc_backlog_add")?.execute("call-1", params)
  return { add, sent, fire: (event: string) => handlers.get(event)?.() }
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
        "orc_backlog_add,orc_backlog",
        "ORC_CHAT_ORC=" + JSON.stringify([process.execPath, binPath])
      ])
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
      expect(chat.posted).toEqual(["orc chat cannot read the backlog to follow task-1: orc: " + broken + ": the task file opens with no --- frontmatter"])
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
      pi.fire("session_start")
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
      pi.fire("session_start")
      pi.fire("session_shutdown")
      await closeTask(fixture, "task-1", ranClosing("done", "", "https://github.com/acme/orc/pull/7"))
      await Bun.sleep(1_000)
      expect(pi.sent).toEqual([])
    })
  }, 60_000)

  test("posts nothing for a task another chat or the command line added", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const chat = sessionFor(fixture)
      await chat.call("orc_backlog_add", { project: "orc", task: "# Fix the typo\n" })
      await writeFile(join(fixture.dir, "task.md"), "# Elsewhere\n")
      expect((await runOrc(fixture, ["backlog", "add", "orc", join(fixture.dir, "task.md")])).exitCode).toBe(0)
      await closeTask(fixture, "task-2", ranClosing("done", "", "https://github.com/acme/orc/pull/8"))
      await chat.postClosed()
      expect(chat.posted).toEqual([])
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
