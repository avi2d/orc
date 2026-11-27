import { expect, test } from "bun:test"
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Option } from "effect"
import { withFileClaim } from "../../packages/run/src/shared/lib/file-claim"

const inClaimDir = async (use: (file: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), "orc-claim-"))
  try {
    await use(join(dir, "claim"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const claimGuardMode = (prepare: (guard: string) => Promise<void>) => inClaimDir(async (file) => {
  await prepare(file + ".guard")
  const result = await Effect.runPromise(withFileClaim(file, Effect.succeed("acquired")).pipe(Effect.provide(BunServices.layer)))
  expect(Option.getOrNull(result)).toBe("acquired")
  expect((await stat(file + ".guard")).mode & 0o777).toBe(0o600)
})

test.skipIf(process.platform === "win32")("a new guard is not created with unpredictable permissions", () => claimGuardMode(async () => {}))

test.skipIf(process.platform === "win32")("a guard with bad permissions does not block a claim", () => claimGuardMode(async (guard) => {
  await writeFile(guard, "")
  await chmod(guard, 0o050)
}))

test("an old empty breaker cannot block a claimant or cause it to remove a replacement claim", () => inClaimDir(async (file) => {
  const dead = Bun.spawn([process.execPath, "-e", ""])
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
}))

test("a live holder excludes another claimant but killing it releases the claim", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orc-claim-"))
  const file = join(dir, "claim")
  const ready = join(dir, "ready")
  const module = import.meta.resolve("../../packages/run/src/shared/lib/file-claim")
  const script = `
    import { writeFile } from "node:fs/promises"
    import { BunServices } from "@effect/platform-bun"
    import { Effect } from "effect"
    import { withFileClaim } from ${JSON.stringify(module)}
    await Effect.runPromise(withFileClaim(${JSON.stringify(file)}, Effect.promise(async () => {
      await writeFile(${JSON.stringify(ready)}, "ready")
      await new Promise(() => {})
    })).pipe(Effect.provide(BunServices.layer)))
  `
  const child = Bun.spawn([process.execPath, "-e", script], { stderr: "pipe" })
  try {
    let started = false
    for (let attempt = 0; attempt < 200; attempt++) {
      started = await access(ready).then(() => true, () => false)
      if (started) break
      await Bun.sleep(25)
    }
    expect(started).toBe(true)
    const take = () => Effect.runPromise(withFileClaim(file, Effect.succeed("acquired")).pipe(Effect.provide(BunServices.layer)))
    expect(Option.isNone(await take())).toBe(true)
    child.kill("SIGKILL")
    await child.exited
    expect(Option.getOrNull(await take())).toBe("acquired")
  } finally {
    child.kill("SIGKILL")
    await child.exited
    await rm(dir, { recursive: true, force: true })
  }
}, 15_000)
