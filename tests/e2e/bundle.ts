import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

const root = new URL("../../", import.meta.url).pathname
const dist = join(root, "packages/run/dist")
const lock = join(root, "packages/run/.e2e-bundle-lock")
const files = ["bin.js", "chat-tools.ts", "heavy-standin-main.ts"]

export const bundlePath = join(dist, "bin.js")

export const ensureBundle = (): void => {
  const deadline = Date.now() + 120_000
  while (true) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      if (Date.now() >= deadline) throw new Error("timed out waiting for the e2e bundle lock")
      Bun.sleepSync(50)
    }
  }
  try {
    if (files.every((file) => existsSync(join(dist, file)))) return
    const result = Bun.spawnSync([process.execPath, "run", "bundle"], { cwd: root, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error("e2e bundle failed: " + result.stderr.toString())
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}
