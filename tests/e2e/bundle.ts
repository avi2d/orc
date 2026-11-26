import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const dist = join(root, "packages/run/dist")
const lock = join(dist, ".e2e-bundle-lock")
const files = ["bin.js", "chat-tools.ts", "heavy-standin-main.ts"]

export const bundlePath = join(dist, "bin.js")

const bundleExists = (): boolean => files.every((file) => existsSync(join(dist, file)))

const hasCode = (error: unknown, ...codes: ReadonlyArray<string>): boolean =>
  error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code)

const releaseLock = (owner: string | undefined): void => {
  try {
    if (owner !== undefined) rmdirSync(join(lock, owner))
    rmdirSync(lock)
  } catch (error) {
    if (!hasCode(error, "ENOENT", "ENOTEMPTY", "EEXIST")) throw error
  }
}

const removeAbandonedLock = (): void => {
  let owners: Array<string>
  try {
    owners = readdirSync(lock)
  } catch (error) {
    if (hasCode(error, "ENOENT")) return
    throw error
  }
  if (owners.length === 0) {
    releaseLock(undefined)
    return
  }
  const owner = owners[0]
  const pid = Number(owner)
  if (owners.length !== 1 || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("invalid e2e bundle lock owner")
  }
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (hasCode(error, "ESRCH")) releaseLock(owner)
    else if (!hasCode(error, "EPERM")) throw error
  }
}

export const ensureBundle = (): void => {
  mkdirSync(dist, { recursive: true })
  const pending = mkdtempSync(join(dist, ".e2e-bundle-"))
  const owner = String(process.pid)
  try {
    mkdirSync(join(pending, owner))
    const deadline = Date.now() + 120_000
    while (true) {
      try {
        renameSync(pending, lock)
        break
      } catch (error) {
        if (!hasCode(error, "EEXIST", "ENOTEMPTY", "EACCES", "EPERM")) throw error
      }
      removeAbandonedLock()
      if (Date.now() >= deadline) throw new Error("timed out waiting for the e2e bundle lock")
      Bun.sleepSync(50)
    }
    try {
      if (bundleExists()) return
      const result = Bun.spawnSync([process.execPath, "run", "bundle"], { cwd: root, stdout: "pipe", stderr: "pipe" })
      if (result.exitCode !== 0) throw new Error("e2e bundle failed: " + result.stderr.toString())
    } finally {
      releaseLock(owner)
    }
  } finally {
    rmSync(pending, { recursive: true, force: true })
  }
}
