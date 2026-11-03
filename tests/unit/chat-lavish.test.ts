import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { lavishLauncher } from "../../packages/run/src/chat-lavish"

const feedback = [
  "session:",
  "  file: /tmp/board.html",
  "  status: feedback",
  "prompts[2]{uid,prompt,selector,tag,text}:",
  "  \"1\",\"REST or gRPC?: gRPC\\n\\nContext data:\\n{\\n  \\\"card\\\": \\\"question-1\\\",\\n  \\\"answer\\\": \\\"gRPC\\\"\\n}\",html > body > main > section > form,orc-board-answer,\"REST or gRPC?: gRPC\"",
  "  \"2\",\"Ship it, but check the region\",html > body,prompt,\"Ship it, but check the region\"",
  "next_step: \"Apply the requested changes.\""
].join("\n")

const opened = [
  "session:",
  "  file: /tmp/board.html",
  "  url: \"http://127.0.0.1:4387/session/f11db70733bf420a\"",
  "  status: opened"
].join("\n")

const withLavish = async (output: string, body: (env: Record<string, string>, log: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-lavish-"))
  try {
    const log = join(dir, "args.log")
    await writeFile(join(dir, "out.txt"), output)
    await writeFile(join(dir, "lavish-axi"), "#!/bin/sh\nprintf '%s\\n' \"$@\" >> '" + log + "'\ncat '" + join(dir, "out.txt") + "'\n")
    await chmod(join(dir, "lavish-axi"), 0o755)
    await body({ PATH: dir + ":" + (process.env.PATH ?? "") }, log)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("the lavish-axi launcher", () => {
  test("a feedback poll yields each prompt's tag, text and context data instead of the raw TOON row, from a poll with no --owner that would show the board Working", async () => {
    await withLavish(feedback, async (env, log) => {
      const poll = await Effect.runPromise(lavishLauncher(env).poll("/tmp/board.html"))
      expect(poll).toEqual({
        kind: "feedback",
        prompts: [
          { tag: "orc-board-answer", text: "REST or gRPC?: gRPC", data: { card: "question-1", answer: "gRPC" } },
          { tag: "prompt", text: "Ship it, but check the region", data: null }
        ]
      })
      expect(await Bun.file(log).text()).toBe("poll\n/tmp/board.html\n--takeover\n")
    })
  })

  test("an ended session reads as closed instead of as feedback with no prompts", async () => {
    await withLavish("session:\n  file: /tmp/board.html\n  status: ended\n  ended_by: user\n", async (env) => {
      expect(await Effect.runPromise(lavishLauncher(env).poll("/tmp/board.html"))).toEqual({ kind: "closed", status: "ended" })
    })
  })

  test("what orc recorded goes back to the board through lavish-axi reply instead of leaving it unanswered", async () => {
    await withLavish("session:\n  file: /tmp/board.html\n  status: sent\n", async (env, log) => {
      await Effect.runPromise(lavishLauncher(env).reply("/tmp/board.html", "answered question-1 on task-1"))
      expect(await Bun.file(log).text()).toBe("reply\n/tmp/board.html\n--agent-reply\nanswered question-1 on task-1\n")
    })
  })

  test("opening reads the session URL and never asks lavish-axi to publish or open a browser", async () => {
    await withLavish(opened, async (env, log) => {
      expect(await Effect.runPromise(lavishLauncher(env).open("/tmp/board.html"))).toBe("http://127.0.0.1:4387/session/f11db70733bf420a")
      expect(await Bun.file(log).text()).toBe("/tmp/board.html\n--no-open\n")
    })
  })
})
