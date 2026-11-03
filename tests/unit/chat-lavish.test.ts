import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { boardHostAddress, lavishLauncher, pickBoardHost } from "../../packages/run/src/chat-lavish"

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
      expect(await Bun.file(log).text()).toBe("poll\n/tmp/board.html\n")
    })
  })

  test("an ended session reads as closed instead of as feedback with no prompts", async () => {
    await withLavish("session:\n  file: /tmp/board.html\n  status: ended\n  ended_by: user\n", async (env) => {
      expect(await Effect.runPromise(lavishLauncher(env).poll("/tmp/board.html"))).toEqual({ kind: "closed", status: "ended" })
    })
  })

  test("a disconnected browser reads as waiting instead of closed while its session stays open", async () => {
    await withLavish("session:\n  file: /tmp/board.html\n  status: browser_disconnected\n", async (env) => {
      expect(await Effect.runPromise(lavishLauncher(env).poll("/tmp/board.html"))).toEqual({ kind: "waiting" })
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
      expect(await Effect.runPromise(lavishLauncher(env).open("/tmp/board.html"))).toEqual({
        url: "http://127.0.0.1:4387/session/f11db70733bf420a",
        networkWarning: ""
      })
      expect(await Bun.file(log).text()).toBe("/tmp/board.html\n--no-open\n--reopen\n")
    })
  })

  test("opening keeps a network warning lavish-axi reports instead of dropping it", async () => {
    await withLavish(opened + "\nnetwork_warning: \"192.168.1.62 is unreachable from here\"", async (env) => {
      expect(await Effect.runPromise(lavishLauncher(env).open("/tmp/board.html"))).toEqual({
        url: "http://127.0.0.1:4387/session/f11db70733bf420a",
        networkWarning: "192.168.1.62 is unreachable from here"
      })
    })
  })
})

describe("the board host choice", () => {
  const table = {
    lo: [{ address: "127.0.0.1", family: "IPv4" as const, internal: true }],
    tail: [{ address: "100.64.0.7", family: "IPv4" as const, internal: false }],
    ten: [{ address: "10.0.2.15", family: "IPv4" as const, internal: false }],
    lan: [{ address: "172.16.4.9", family: "IPv4" as const, internal: false }],
    home: [{ address: "192.168.1.62", family: "IPv4" as const, internal: false }],
    public: [{ address: "203.0.113.5", family: "IPv4" as const, internal: false }],
    link: [{ address: "169.254.10.20", family: "IPv4" as const, internal: false }]
  }

  test("a home LAN address wins over a tailnet name, a 10 address and a 172.16 address, and loopback never binds", async () => {
    expect(pickBoardHost(table)).toBe("192.168.1.62")
    expect(pickBoardHost({ lo: table.lo, tail: table.tail, ten: table.ten, lan: table.lan })).toBe("10.0.2.15")
    expect(pickBoardHost({ lo: table.lo, tail: table.tail, lan: table.lan })).toBe("172.16.4.9")
    expect(pickBoardHost({ lo: table.lo, tail: table.tail })).toBeNull()
    expect(pickBoardHost({ lo: table.lo, public: table.public })).toBeNull()
    expect(pickBoardHost({ lo: table.lo, link: table.link })).toBeNull()
    expect(boardHostAddress({}, { lo: table.lo, public: table.public })).toBe("127.0.0.1")
  })

  test("ORC_BOARD_HOST names the bound address as given instead of the picked LAN address", async () => {
    expect(boardHostAddress({ ORC_BOARD_HOST: "captain.lan" }, table)).toBe("captain.lan")
    expect(boardHostAddress({ ORC_BOARD_HOST: "127.0.0.1" }, table)).toBe("127.0.0.1")
    expect(boardHostAddress({ ORC_BOARD_HOST: "  " }, table)).toBe("192.168.1.62")
    expect(boardHostAddress({}, { lo: table.lo })).toBe("127.0.0.1")
  })

  const seenHost = async (env: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "orc-lavish-host-"))
    try {
      const seen = join(dir, "host.txt")
      await writeFile(join(dir, "out.txt"), opened)
      await writeFile(join(dir, "lavish-axi"), "#!/bin/sh\nprintf '%s' \"$LAVISH_AXI_HOST\" > '" + seen + "'\ncat '" + join(dir, "out.txt") + "'\n")
      await chmod(join(dir, "lavish-axi"), 0o755)
      const full = { PATH: dir + ":" + (process.env.PATH ?? ""), ...env }
      expect((await Effect.runPromise(lavishLauncher(full).open("/tmp/board.html"))).url).toBe("http://127.0.0.1:4387/session/f11db70733bf420a")
      return Bun.file(seen).text()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  test("the launcher hands its bound address to lavish-axi in LAVISH_AXI_HOST instead of leaving it unset", async () => {
    expect(await seenHost({ ORC_BOARD_HOST: "captain.lan" })).toBe("captain.lan")
  })

  test("a shell LAVISH_AXI_HOST never changes the bound address, which ORC_BOARD_HOST or the picked LAN names", async () => {
    expect(await seenHost({ ORC_BOARD_HOST: "captain.lan", LAVISH_AXI_HOST: "someone-else" })).toBe("captain.lan")
    expect(await seenHost({ LAVISH_AXI_HOST: "someone-else" })).not.toBe("someone-else")
  })
})
