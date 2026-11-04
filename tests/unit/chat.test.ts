import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { runChat } from "../../packages/run/src/chat"

const probeVar = "ORC_TEST_PROBE"

const packageProvider = {
  id: "claude-bridge",
  credential: "package",
  packages: ["npm:pi-claude-bridge"],
  env: { CLAUDE_CONFIG_DIR: "/accounts/second" }
}

const loginProvider = { id: "opencode-go", credential: "pi-login", nono: { upstream: "https://example.com/v1" } }

// The fake Pi writes the CLAUDE_CONFIG_DIR it really inherits, because the merge with the shell happens in the spawner.
const piSeesAccount = async (providers: ReadonlyArray<object>, orchestrator: string, shellAccount: string): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "orc-chat-"))
  const probe = join(home, "probe.txt")
  const shell = process.env.CLAUDE_CONFIG_DIR
  try {
    await writeFile(join(home, "config.json"), JSON.stringify({ providers, models: { orchestrator } }))
    process.env.CLAUDE_CONFIG_DIR = shellAccount
    const spawner = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, Effect.gen(function*() {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      return ChildProcessSpawner.make((command) =>
        ChildProcess.isStandardCommand(command) && command.command === "pi"
          ? real.spawn(ChildProcess.make("sh", ["-c", 'printf %s "$CLAUDE_CONFIG_DIR" > "$' + probeVar + '"'], {
            ...command.options,
            env: { ...command.options.env, [probeVar]: probe }
          }))
          : real.spawn(command)
      )
    })).pipe(Layer.provide(BunServices.layer))
    const exit = await Effect.runPromise(runChat(home, ["orc"]).pipe(Effect.provide(Layer.merge(BunServices.layer, spawner))))
    expect(exit).toBe(0)
    return await readFile(probe, "utf8")
  } finally {
    if (shell === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = shell
    }
    await rm(home, { recursive: true, force: true })
  }
}

describe("runChat", () => {
  test("a CLAUDE_CONFIG_DIR the shell exports does not override the orchestrator provider's env", async () => {
    expect(await piSeesAccount([packageProvider], "claude-bridge/claude-sonnet-5-5", "/accounts/main")).toBe("/accounts/second")
  })

  test("a provider with no env leaves the account the shell exports in place", async () => {
    expect(await piSeesAccount([loginProvider], "opencode-go/model", "/accounts/main")).toBe("/accounts/main")
  })

  test("an orchestrator model whose provider is not in config.json leaves the shell's account in place", async () => {
    expect(await piSeesAccount([packageProvider], "other/model", "/accounts/main")).toBe("/accounts/main")
  })
})
