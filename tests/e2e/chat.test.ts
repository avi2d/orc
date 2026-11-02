import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { chatTools } from "../../packages/run/src/chat-tools"

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

const toolsFor = (fixture: Fixture) => {
  const env = { ...process.env, ...fixture.env, ORC_CHAT_ORC: JSON.stringify([process.execPath, binPath]) }
  const byName = new Map(chatTools(env).map((tool) => [tool.name, tool]))
  return (name: string, params: unknown) => {
    const tool = byName.get(name)
    if (tool === undefined) {
      throw new Error("orc chat has no tool " + name)
    }
    return tool.execute("call-1", params).then((result) => result.content.map((block) => block.text).join(""))
  }
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
  })

  test("refuses with no models.orchestrator instead of starting pi on Pi's default model", async () => {
    await withFixture({ providers: [], models: { implementer: "acme/implementer-1" } }, 0, async (fixture) => {
      const result = await runOrc(fixture, ["chat"])
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("orc chat needs models.orchestrator in " + join(fixture.home, "config.json"))
      expect(await Bun.file(fixture.piLog).exists()).toBe(false)
    })
  })

  test("exits non-zero when pi does instead of reporting a failed chat as success", async () => {
    await withFixture(orchestratorConfig, 3, async (fixture) => {
      const result = await runOrc(fixture, ["chat"])
      expect(result.exitCode).not.toBe(0)
    })
  })
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
  })

  test("the add tool passes each dependency to orc instead of dropping them", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const call = toolsFor(fixture)
      await call("orc_backlog_add", { project: "orc", task: "# First\n" })
      await call("orc_backlog_add", { project: "orc", task: "# Second\n", dependsOn: ["task-1"] })
      const backlog = decodeBacklog(await call("orc_backlog", {}))
      expect(backlog.tasks.map((task) => [task.id, task.dependsOn])).toEqual([["task-1", []], ["task-2", ["task-1"]]])
    })
  })

  test("the add tool fails with orc's own refusal instead of a bare exit code", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const call = toolsFor(fixture)
      expect(await rejection(call("orc_backlog_add", { project: "nowhere", task: "# Lost\n" }))).toBe("orc: the project nowhere is not in " + join(fixture.home, "backlog", "projects.json"))
    })
  })

  test("the add tool refuses an unknown field instead of dropping it", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const call = toolsFor(fixture)
      expect(await rejection(call("orc_backlog_add", { project: "orc", task: "# Fast\n", priority: "high" }))).toStartWith("orc_backlog_add takes ")
      expect(await Bun.file(join(fixture.home, "backlog", "new", "task-1.md")).exists()).toBe(false)
    })
  })
})
