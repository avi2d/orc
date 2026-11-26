import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { runChat } from "../../packages/run/src/features/chat/chat"
import { binPath, type Fixture, orchestratorConfig, piFor, runOrc, sessionFor, until, waitPolls, withFixture } from "./chat-helpers"

const loginProvider = { id: "opencode-go", credential: "pi-login", nono: { upstream: "https://example.com/v1" } }

const chatToolsPath = new URL("../../packages/run/dist/chat-tools.ts", import.meta.url).pathname

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

const toolsFor = (fixture: Fixture) => sessionFor(fixture).call

const parkTask = async (fixture: Fixture, id: string, questions: ReadonlyArray<{ readonly id: string; readonly text: string }>): Promise<void> => {
  const file = join(fixture.home, "backlog", "new", id + ".md")
  const text = await readFile(file, "utf8")
  const end = text.indexOf("\n---\n", 4)
  const parked = "\nparked_branch: \"orc/" + id + "\"\nparked_questions: " + JSON.stringify(questions)
  await writeFile(file + ".tmp", text.slice(0, end) + parked + text.slice(end))
  await rename(file + ".tmp", file)
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
"orc_backlog_add,orc_backlog,orc_backlog_hold,orc_backlog_priority,orc_machines,orc_backlog_stop,orc_backlog_retry,orc_backlog_drop,orc_backlog_send_back,orc_backlog_note,orc_backlog_depend,orc_backlog_thread,orc_backlog_edit,orc_backlog_answer,orc_attention,orc_attention_answer,merge_task,orc_decision_board",
        "ORC_CHAT_ORC=" + JSON.stringify([process.execPath, binPath]),
        "ORC_CHAT_BOARDS=" + join(fixture.home, "boards")
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
      expect(await call("orc_backlog_add", { project: "orc", task: "# Fix the typo\n\nThe word teh in the intro.\n", machine: "mac" })).toBe("added orc-1 for orc on mac")
      const backlog = decodeBacklog(await call("orc_backlog", {}))
      expect(backlog.tasks).toEqual([{ id: "orc-1", title: "Fix the typo", project: "orc", machine: "mac", status: "new", dependsOn: [] }])
      expect(await readFile(join(fixture.home, "backlog", "new", "orc-1.md"), "utf8")).toContain("# Fix the typo\n\nThe word teh in the intro.\n")
    })
  }, 60_000)

  test("the add tool passes each dependency to orc instead of dropping them", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const call = toolsFor(fixture)
      await call("orc_backlog_add", { project: "orc", task: "# First\n" })
      await call("orc_backlog_add", { project: "orc", task: "# Second\n", dependsOn: ["orc-1"] })
      const backlog = decodeBacklog(await call("orc_backlog", {}))
      expect(backlog.tasks.map((task) => [task.id, task.dependsOn])).toEqual([["orc-1", []], ["orc-2", ["orc-1"]]])
    })
  }, 60_000)

  test("the add tool fails with orc's own refusal instead of a bare exit code", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const call = toolsFor(fixture)
      expect(await rejection(call("orc_backlog_add", { project: "nowhere", task: "# Lost\n" }))).toBe("orc: the project nowhere is not in " + join(fixture.home, "backlog", "projects.json"))
    })
  }, 60_000)

  test("an open held decision is listed again after the chat restarts, once per start, and the beat still refuses it", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const first = piFor(fixture, 50)
      await first.add({ project: "orc", task: "# Pick the API\n" })
      expect(await first.call("orc_backlog_hold", { id: "orc-1", reason: "REST or gRPC", until: "2026-12-01" })).toBe("held orc-1: REST or gRPC, until 2026-12-01")
      const heldPost = { customType: "orc-held-decision", content: "orc-1 Pick the API is held for the captain: REST or gRPC, until 2026-12-01", display: true }
      first.fire("session_start", { isIdle: () => true })
      await until(() => first.sent.length > 0, 10_000)
      await waitPolls(first)
      first.fire("session_shutdown")
      const reopened = piFor(fixture, 50)
      reopened.fire("session_start", { isIdle: () => true })
      await until(() => reopened.sent.length > 0, 10_000)
      await waitPolls(reopened)
      reopened.fire("session_shutdown")
      expect([first.sent, reopened.sent]).toEqual([[{ message: heldPost, options: { triggerTurn: false } }], [{ message: heldPost, options: { triggerTurn: false } }]])
      expect((await runOrc(fixture, ["backlog", "priority", "orc-1", "0"])).exitCode).toBe(0)
      const beat = await runOrc(fixture, ["beat"])
      expect(beat.stdout).toContain("waits orc-1: held for the captain: REST or gRPC, until 2026-12-01")
      expect(await Bun.file(join(fixture.home, "backlog", "new", "orc-1.md")).exists()).toBe(true)
    })
  }, 60_000)

  test("a parked question is listed once per chat start, again after a restart, and the answer tool resumes it instead of leaving it parked", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const first = piFor(fixture, 50)
      await first.add({ project: "orc", task: "# Pick the API\n" })
      await parkTask(fixture, "orc-1", [{ id: "question-4", text: "REST or gRPC?" }])
      const parkedPost = { customType: "orc-parked-question", content: "orc-1 Pick the API is parked on orc/orc-1 for the captain's answer to question-4: REST or gRPC?", display: true }
      first.fire("session_start", { isIdle: () => true })
      await until(() => first.sent.length > 0, 10_000)
      await waitPolls(first)
      first.fire("session_shutdown")
      const reopened = piFor(fixture, 50)
      reopened.fire("session_start", { isIdle: () => true })
      await until(() => reopened.sent.length > 0, 10_000)
      await waitPolls(reopened)
      reopened.fire("session_shutdown")
      expect([first.sent, reopened.sent]).toEqual([[{ message: parkedPost, options: { triggerTurn: false } }], [{ message: parkedPost, options: { triggerTurn: false } }]])
      expect(await reopened.call("orc_backlog_answer", { id: "orc-1", question: "question-4", words: "REST, and keep v1" })).toBe("answered question-4 on orc-1, so the beat resumes it on orc/orc-1")
      expect(await readFile(join(fixture.home, "backlog", "new", "orc-1.md"), "utf8")).toContain("\"answer\":\"REST, and keep v1\"")
    })
  }, 60_000)

  test("a task that parks while the chat runs is listed once on the next poll instead of waiting for a restart", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const pi = piFor(fixture, 50)
      await pi.add({ project: "orc", task: "# Pick the API\n" })
      pi.fire("session_start", { isIdle: () => true })
      await waitPolls(pi)
      expect(pi.sent).toEqual([])
      await parkTask(fixture, "orc-1", [{ id: "question-4", text: "REST or gRPC?" }, { id: "question-5", text: "" }])
      await until(() => pi.sent.length > 1, 10_000)
      await waitPolls(pi)
      pi.fire("session_shutdown")
      expect(pi.sent.map((sent) => sent.message)).toEqual([
        { customType: "orc-parked-question", content: "orc-1 Pick the API is parked on orc/orc-1 for the captain's answer to question-4: REST or gRPC?", display: true },
        { customType: "orc-parked-question", content: "orc-1 Pick the API is parked on orc/orc-1 for the captain's answer to question-5", display: true }
      ])
    })
  }, 60_000)

  test("a chat that starts mid-turn lists the held decision once Pi is idle instead of dropping it", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const pi = piFor(fixture, 50)
      await pi.add({ project: "orc", task: "# Pick the API\n" })
      await pi.call("orc_backlog_hold", { id: "orc-1", reason: "REST or gRPC" })
      let idle = false
      pi.fire("session_start", { isIdle: () => idle })
      await waitPolls(pi)
      expect(pi.sent).toEqual([])
      idle = true
      await until(() => pi.sent.length > 0, 10_000)
      await waitPolls(pi)
      pi.fire("session_shutdown")
      expect(pi.sent.map((sent) => sent.message)).toEqual([{ customType: "orc-held-decision", content: "orc-1 Pick the API is held for the captain: REST or gRPC", display: true }])
    })
  }, 60_000)

  test("an answered decision is not listed at chat start and the answer tool keeps the captain's words whole", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const pi = piFor(fixture, 50)
      await pi.add({ project: "orc", task: "# Pick the API\n" })
      await pi.add({ project: "orc", task: "# Pick the store\n" })
      await pi.call("orc_backlog_hold", { id: "orc-1", reason: "REST or gRPC" })
      await pi.call("orc_backlog_hold", { id: "orc-2", reason: "SQLite or Postgres" })
      const words = "REST --until never, and keep  v1"
      expect(await pi.call("orc_backlog_answer", { id: "orc-1", words })).toBe("answered orc-1, so the beat may start it")
      pi.fire("session_start", { isIdle: () => true })
      await until(() => pi.sent.length > 0, 10_000)
      await waitPolls(pi)
      pi.fire("session_shutdown")
      expect(pi.sent.map((sent) => sent.message)).toEqual([{ customType: "orc-held-decision", content: "orc-2 Pick the store is held for the captain: SQLite or Postgres", display: true }])
      expect(await readFile(join(fixture.home, "backlog", "new", "orc-1.md"), "utf8")).toContain("answer: " + JSON.stringify(words))
    })
  }, 60_000)

  test("the hold and answer tools fail with orc's own refusal and refuse an unknown field instead of dropping it", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const call = toolsFor(fixture)
      expect(await rejection(call("orc_backlog_hold", { id: "orc-9", reason: "why" }))).toBe("orc: the backlog holds no orc-9")
      expect(await rejection(call("orc_backlog_answer", { id: "orc-9", words: "yes" }))).toBe("orc: the backlog holds no orc-9")
      expect(await rejection(call("orc_backlog_hold", { id: "orc-1", reason: "why", priority: "high" }))).toStartWith("orc_backlog_hold takes ")
      expect(await rejection(call("orc_backlog_answer", { id: "orc-1" }))).toStartWith("orc_backlog_answer takes ")
    })
  }, 60_000)

  test("the add tool refuses an unknown field instead of dropping it", async () => {
    await withFixture(orchestratorConfig, 0, async (fixture) => {
      const call = toolsFor(fixture)
      expect(await rejection(call("orc_backlog_add", { project: "orc", task: "# Fast\n", priority: "high" }))).toStartWith("orc_backlog_add takes ")
      expect(await Bun.file(join(fixture.home, "backlog", "new", "orc-1.md")).exists()).toBe(false)
    })
  }, 60_000)
})

const processGroup = async (pid: number): Promise<number> => Number((await Bun.$`ps -o pgid= -p ${pid}`.text()).trim())

const hangUpChat = async () => {
  const home = await mkdtemp(join(tmpdir(), "orc-chat-"))
  try {
    await writeFile(join(home, "config.json"), JSON.stringify({ providers: [loginProvider], models: { orchestrator: "opencode-go/model" } }))
    return await Effect.runPromise(Effect.gen(function*() {
      const spawned = yield* Deferred.make<number>()
      const spawner = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
        const real = yield* ChildProcessSpawner.ChildProcessSpawner
        return ChildProcessSpawner.make((command) =>
          ChildProcess.isStandardCommand(command) && command.command === "pi"
            ? real.spawn(ChildProcess.make("sleep", ["30"], command.options)).pipe(
              Effect.tap((handle) => Deferred.succeed(spawned, handle.pid))
            )
            : real.spawn(command)
        )
      })).pipe(Layer.provide(BunServices.layer))
      const chat = yield* runChat(home, ["orc"], null).pipe(Effect.provide(Layer.merge(BunServices.layer, spawner)), Effect.forkChild)
      const pid = yield* Deferred.await(spawned)
      const piGroup = yield* Effect.promise(() => processGroup(pid))
      process.emit("SIGHUP")
      const exit = yield* Fiber.join(chat)
      const piRunning = yield* Effect.sync(() => {
        try {
          return process.kill(pid, 0)
        } catch {
          return false
        }
      })
      return { exit, piRunning, piGroup }
    }))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe("runChat", () => {
  test("chat spawns Pi in the chat's process group rather than a detached session the terminal's hangup misses", async () => {
    const { piGroup } = await hangUpChat()
    expect(piGroup).toBe(await processGroup(process.pid))
  })

  test("a hangup of orc chat stops Pi rather than leaving it running", async () => {
    const { exit, piRunning } = await hangUpChat()
    expect({ exit, piRunning }).toEqual({ exit: 129, piRunning: false })
  })
})
