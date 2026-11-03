import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chatSession } from "../../packages/run/src/chat-tools"

export const binPath = new URL("../../packages/run/src/bin.ts", import.meta.url).pathname

export interface Fixture {
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
    "printf 'ORC_CHAT_BOARDS=%s\\n' \"$ORC_CHAT_BOARDS\" >> '" + log + "'",
    "exit " + exitCode,
    ""
  ].join("\n")

export const withFixture = async (config: unknown, piExit: number, body: (fixture: Fixture) => Promise<void>): Promise<void> => {
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

export const runOrc = async (fixture: Fixture, args: ReadonlyArray<string>): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
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

export const orchestratorConfig = { providers: [], models: { orchestrator: "acme/orchestrator-1" } }

export const chatEnv = (fixture: Fixture): Record<string, string | undefined> => ({ ...process.env, ...fixture.env, ORC_CHAT_ORC: JSON.stringify([process.execPath, binPath]) })

export interface ChatSessionCalls {
  readonly call: (name: string, params: unknown) => Promise<string>
  readonly posted: ReadonlyArray<string>
  readonly postClosed: () => Promise<void>
}

export const sessionFor = (fixture: Fixture): ChatSessionCalls => {
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

export const ranClosing = (outcome: "done" | "failed", reason: string, pr: string | null): ReadonlyArray<string> => [
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

export const closeTask = async (fixture: Fixture, id: string, fields: ReadonlyArray<string>): Promise<void> => {
  const from = join(fixture.home, "backlog", "new", id + ".md")
  const to = join(fixture.home, "backlog", "closed", id + ".md")
  const text = await readFile(from, "utf8")
  await mkdir(join(fixture.home, "backlog", "closed"), { recursive: true })
  await writeFile(from, text.replace("\n---\n", "\n" + fields.join("\n") + "\n---\n"))
  await rename(from, to)
}
