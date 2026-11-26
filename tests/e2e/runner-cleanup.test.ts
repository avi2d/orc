import { expect, test } from "bun:test"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { binPath, fakeQuota, orcOk, runnerTimeout, startWaitMillis, withFixture } from "./runner-helpers"

const waitForFile = async (file: string): Promise<string> => {
  const deadline = Date.now() + startWaitMillis
  while (Date.now() < deadline) {
    const value = await readFile(file, "utf8").catch(() => null)
    if (value !== null) return value
    await Bun.sleep(20)
  }
  throw new Error("never saw " + file)
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("a detached runner blocked on the fake pueue lock exits after its fixture is removed instead of surviving the test", async () => {
  let pid = 0
  try {
    await withFixture(async (fixture) => {
      await fakeQuota(fixture)
      const start = join(fixture.dir, "start")
      const pidFile = join(fixture.dir, "runner-pid")
      const entered = join(fixture.dir, "entered")
      await writeFile(start, '#!/bin/sh\necho $$ > "' + pidFile + '"\nexec "$@"\n', { mode: 0o755 })
      const pueue = join(fixture.dir, "bin", "pueue")
      await rename(pueue, pueue + "-base")
      await writeFile(pueue, '#!/bin/sh\nif [ "$1" = "add" ] || [ "$1 $2" = "group add" ]; then touch "' + entered + '"; fi\nexec "$0-base" "$@"\n', { mode: 0o755 })
      await chmod(pueue, 0o755)
      await mkdir(join(fixture.pueue, "group-lock"))
      await writeFile(join(fixture.pueue, "status.json"), JSON.stringify({ tasks: {}, groups: {} }))
      await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
        machines: [{ name: "linux", slots: 1, start: [start, process.execPath, binPath, "runner", "start"] }],
        quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", kind: "none" }], floorPercent: 15 }
      }))
      await orcOk(fixture, ["backlog", "add", "orc", "task.md", "--priority", "0", "--machine", "linux"])
      await orcOk(fixture, ["beat"])
      pid = Number((await waitForFile(pidFile)).trim())
      await waitForFile(entered)
      expect(alive(pid)).toBe(true)
    })
    const deadline = Date.now() + startWaitMillis
    while (alive(pid) && Date.now() < deadline) await Bun.sleep(20)
    expect(alive(pid)).toBe(false)
  } finally {
    if (pid > 0 && alive(pid)) {
      try { process.kill(-pid, "SIGKILL") } catch {}
    }
  }
}, runnerTimeout)
