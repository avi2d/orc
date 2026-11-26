import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Option } from "effect"
import { withFileClaim } from "../../packages/run/src/shared/lib/file-claim"

test("a dead owner's empty breaker cannot block a claimant or cause it to remove a replacement claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orc-claim-"))
  try {
    const file = join(dir, "claim")
    const dead = Bun.spawn(["true"])
    await dead.exited
    const held = JSON.stringify({ pid: dead.pid, at: Date.now(), token: "dead" })
    const breaker = file + "." + new Bun.CryptoHasher("sha256").update(held).digest("hex").slice(0, 16) + ".break"
    const replacement = JSON.stringify({ pid: process.pid, at: Date.now(), token: "replacement" })
    await writeFile(file, held)
    await writeFile(breaker, "")

    const result = await Effect.runPromise(withFileClaim(file, Effect.promise(async () => {
      await writeFile(file, replacement)
      return "acquired"
    })).pipe(Effect.provide(BunServices.layer)))

    expect(Option.getOrNull(result)).toBe("acquired")
    expect(await readFile(file, "utf8")).toBe(replacement)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
