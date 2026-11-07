import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Result } from "effect"
import { readOrcConfig } from "../../packages/run/src/orc-config"

const readWith = async (config: unknown) => {
  const home = await mkdtemp(join(tmpdir(), "orc-config-"))
  try {
    await writeFile(join(home, "config.json"), JSON.stringify(config))
    return await Effect.runPromise(readOrcConfig(home).pipe(Effect.result, Effect.provide(BunServices.layer)))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe("readOrcConfig sandbox.read", () => {
  test("keeps the absolute folders the operator lists for the sandbox to read instead of dropping them", async () => {
    const result = await readWith({ providers: [], sandbox: { read: ["/Users/me/.cache/avi2dg-checks"] } })
    expect(Result.isSuccess(result) ? result.success.sandbox?.read : result.failure.detail).toEqual(["/Users/me/.cache/avi2dg-checks"])
  })

  test("refuses a relative folder rather than granting one resolved from wherever orc runs", async () => {
    const result = await readWith({ providers: [], sandbox: { read: [".cache/avi2dg-checks"] } })
    expect(Result.isFailure(result)).toBe(true)
  })
})
