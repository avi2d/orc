import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Result } from "effect"
import { requireTokenFile, routeOfAgents, type TokenFileSource, tokenFileSource } from "../../packages/run/src/model-route"
import type { OrcConfig } from "../../packages/run/src/orc-config"

const model = "acme/coder-large"

const login = { id: "acme", credential: "pi-login" } as const

const keyed = { id: "keyed", credential: "token-file", tokenFile: { env: "ACME_TOKEN_FILE" } } as const

const config: OrcConfig = { file: "/home/me/.orc/config.json", providers: [login, keyed] }

const tokenFileProblem = (source: TokenFileSource): Promise<string | null> =>
  Effect.runPromise(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* requireTokenFile(fs, model, source).pipe(
      Effect.as(null),
      Effect.catch((error) => Effect.succeed(error.message))
    )
  }).pipe(Effect.provide(BunServices.layer)))

const fromVariable = (path: string | undefined): TokenFileSource => ({ path, origin: "the variable ACME_TOKEN_FILE" })

const withDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-model-route-"))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const writeToken = async (file: string, mode: number, text = "sk-unit-token"): Promise<void> => {
  await writeFile(file, text)
  await chmod(file, mode)
}

describe("routeOfAgents", () => {
  test("each model takes the provider config.json names for its prefix", () => {
    expect(routeOfAgents(config, { agent: model, fixer: "acme/coder-small" }, undefined)).toEqual(Result.succeed(login))
    expect(routeOfAgents(config, { agent: "keyed/one", fixer: "keyed/two" }, undefined)).toEqual(Result.succeed(keyed))
  })

  test("a provider that only starts with a configured id is not taken for it", () => {
    expect(Result.isFailure(routeOfAgents(config, { agent: "acme-proxy/coder", fixer: "acme-proxy/coder" }, undefined))).toBe(true)
  })

  test("a model whose provider is not configured is refused, naming the config file and no provider orc would route to", () => {
    const routed = routeOfAgents(config, { agent: "other/model", fixer: "other/model" }, undefined)
    const message = Result.isFailure(routed) ? routed.failure : ""
    expect(message).toContain("/home/me/.orc/config.json does not configure")
    expect(message).not.toContain("acme")
    expect(message).not.toContain("keyed")
  })

  test("a config with no providers refuses every model instead of falling back to a built-in one", () => {
    expect(Result.isFailure(routeOfAgents({ file: config.file, providers: [] }, { agent: model, fixer: model }, undefined))).toBe(true)
  })

  test("an implementer on a configured provider with a fixer elsewhere is refused with the config file only", () => {
    const routed = routeOfAgents(config, { agent: model, fixer: "other/model" }, undefined)
    const message = Result.isFailure(routed) ? routed.failure : ""
    expect(message).toContain(config.file)
    expect(message).not.toContain("other")
    expect(message).not.toContain(model)
    expect(message).not.toContain("other/model")
  })

  test("a pinned run with an unconfigured implementer is refused with the config file only", () => {
    const routed = routeOfAgents(config, { agent: "other/model", fixer: model }, "acme")
    const message = Result.isFailure(routed) ? routed.failure : ""
    expect(message).toContain(config.file)
    expect(message).not.toContain("other")
    expect(message).not.toContain("other/model")
    expect(message).not.toContain(model)
  })

  test("an implementer and fixer on different providers is refused rather than run on one route", () => {
    const routed = routeOfAgents(config, { agent: model, fixer: "keyed/two" }, undefined)
    expect(Result.isFailure(routed) ? routed.failure : "").toContain("name models from one provider")
  })

  test("--provider naming another provider than the implementer's is refused instead of handing its credential across", () => {
    const routed = routeOfAgents(config, { agent: "keyed/one", fixer: "keyed/two" }, "acme")
    expect(Result.isFailure(routed) ? routed.failure : "").toContain("--provider names acme")
  })

  test("--provider naming the implementer's provider routes as without it", () => {
    expect(routeOfAgents(config, { agent: "keyed/one", fixer: "keyed/two" }, "keyed")).toEqual(Result.succeed(keyed))
  })
})

describe("tokenFileSource", () => {
  test("a variable location reads the path from that variable, not from the token file's contents", () => {
    expect(tokenFileSource({ env: "ACME_TOKEN_FILE" }, undefined, { ACME_TOKEN_FILE: "/secrets/acme" }, config.file)).toEqual({ path: "/secrets/acme", origin: "the variable ACME_TOKEN_FILE" })
  })

  test("a path location takes the path config.json names", () => {
    expect(tokenFileSource({ path: "/secrets/acme" }, undefined, {}, config.file)).toEqual({ path: "/secrets/acme", origin: config.file })
  })

  test("--token-file wins over the configured location so a dispatched run uses its picked account", () => {
    expect(tokenFileSource({ env: "ACME_TOKEN_FILE" }, "/secrets/second", { ACME_TOKEN_FILE: "/secrets/main" }, config.file)).toEqual({ path: "/secrets/second", origin: "--token-file" })
  })
})

describe("requireTokenFile", () => {
  test("a non-empty regular file only its owner can read is accepted", async () => {
    await withDir(async (dir) => {
      await writeToken(join(dir, "token"), 0o600)
      expect(await tokenFileProblem(fromVariable(join(dir, "token")))).toBeNull()
    })
  })

  test("an unset or empty variable is refused instead of falling back to another login", async () => {
    expect(await tokenFileProblem(fromVariable(undefined))).toContain("ACME_TOKEN_FILE")
    expect(await tokenFileProblem(fromVariable(""))).toContain("which is unset")
  })

  test("a relative path is refused because the agent resolves it from another folder", async () => {
    expect(await tokenFileProblem(fromVariable("token"))).toContain("not an absolute path")
  })

  test("a file its group or other users can read is refused, naming its mode", async () => {
    await withDir(async (dir) => {
      await writeToken(join(dir, "group"), 0o640)
      await writeToken(join(dir, "world"), 0o604)
      expect(await tokenFileProblem(fromVariable(join(dir, "group")))).toContain("has mode 640")
      expect(await tokenFileProblem(fromVariable(join(dir, "world")))).toContain("has mode 604")
    })
  })

  test("a missing file, a folder and an empty file are each refused", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, "folder"), { mode: 0o700 })
      await writeToken(join(dir, "empty"), 0o600, "")
      expect(await tokenFileProblem(fromVariable(join(dir, "missing")))).toContain("cannot read the token file")
      expect(await tokenFileProblem(fromVariable(join(dir, "folder")))).toContain("is not a regular file")
      expect(await tokenFileProblem(fromVariable(join(dir, "empty")))).toContain("is empty")
    })
  })
})
