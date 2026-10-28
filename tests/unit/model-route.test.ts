import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Result } from "effect"
import { requireClaudeTokenFile, routeOfAgents } from "../../packages/run/src/model-route"

const model = "anthropic/claude-sonnet-4-5"

const tokenFileProblem = (tokenFile: string | undefined): Promise<string | null> =>
  Effect.runPromise(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* requireClaudeTokenFile(fs, model, tokenFile).pipe(
      Effect.as(null),
      Effect.catch((error) => Effect.succeed(error.message))
    )
  }).pipe(Effect.provide(BunServices.layer)))

const withDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-model-route-"))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const writeToken = async (file: string, mode: number, text = "sk-ant-oat01-unit"): Promise<void> => {
  await writeFile(file, text)
  await chmod(file, mode)
}

describe("routeOfAgents", () => {
  test("opencode-go models take the opencode-go route and anthropic models the Claude route", () => {
    expect(routeOfAgents({ agent: "opencode-go/muse-spark", fixer: "opencode-go/muse-spark" })).toEqual(Result.succeed("opencode-go"))
    expect(routeOfAgents({ agent: model, fixer: "anthropic/claude-opus-4-5" })).toEqual(Result.succeed("claude"))
  })

  test("a provider that only starts with anthropic is not routed to Claude", () => {
    expect(Result.isFailure(routeOfAgents({ agent: "anthropic-proxy/claude-sonnet-4-5", fixer: "anthropic-proxy/claude-sonnet-4-5" }))).toBe(true)
  })

  test("an implementer and fixer on different providers is refused rather than run on one route", () => {
    const routed = routeOfAgents({ agent: model, fixer: "opencode-go/muse-spark" })
    expect(Result.isFailure(routed) ? routed.failure : "").toContain("name models from one provider")
  })
})

describe("requireClaudeTokenFile", () => {
  test("a non-empty regular file only its owner can read is accepted", async () => {
    await withDir(async (dir) => {
      await writeToken(join(dir, "token"), 0o600)
      expect(await tokenFileProblem(join(dir, "token"))).toBeNull()
    })
  })

  test("an unset or empty variable is refused instead of falling back to another login", async () => {
    expect(await tokenFileProblem(undefined)).toContain("ORC_CLAUDE_TOKEN_FILE")
    expect(await tokenFileProblem("")).toContain("which is unset")
  })

  test("a relative path is refused because the agent resolves it from another folder", async () => {
    expect(await tokenFileProblem("token")).toContain("not an absolute path")
  })

  test("a file its group or other users can read is refused, naming its mode", async () => {
    await withDir(async (dir) => {
      await writeToken(join(dir, "group"), 0o640)
      await writeToken(join(dir, "world"), 0o604)
      expect(await tokenFileProblem(join(dir, "group"))).toContain("has mode 640")
      expect(await tokenFileProblem(join(dir, "world"))).toContain("has mode 604")
    })
  })

  test("a missing file, a folder and an empty file are each refused", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, "folder"), { mode: 0o700 })
      await writeToken(join(dir, "empty"), 0o600, "")
      expect(await tokenFileProblem(join(dir, "missing"))).toContain("cannot read the Claude token file")
      expect(await tokenFileProblem(join(dir, "folder"))).toContain("is not a regular file")
      expect(await tokenFileProblem(join(dir, "empty"))).toContain("is empty")
    })
  })
})
