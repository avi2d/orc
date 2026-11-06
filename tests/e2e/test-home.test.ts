import { describe, expect, test } from "bun:test"
import { tmpdir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { realpathSync } from "node:fs"
import { orcHomeDir } from "../../packages/run/src/run-history"

const accountOrc = join(userInfo().homedir, ".orc")

const within = (path: string, folder: string): boolean => path === folder || path.startsWith(folder + "/")

const testRoot = dirname(Bun.env.ORC_HOME ?? "")

describe("the test preload", () => {
  test("points ORC_HOME and HOME at one fresh temp folder instead of the account's home", () => {
    expect(within(testRoot, realpathSync(tmpdir()))).toBe(true)
    expect(Bun.env.ORC_HOME).toBe(join(testRoot, "orc-home"))
    expect(Bun.env.HOME).toBe(join(testRoot, "home"))
  })

  test("leaves the orc home a test reads by default outside the account's ~/.orc", () => {
    expect(within(orcHomeDir(Bun.env.ORC_HOME), accountOrc)).toBe(false)
  })

  test("hands a child process the temp home, so an orc it starts never reaches ~/.orc", () => {
    const child = Bun.spawnSync([process.execPath, "-e", "console.log(require('node:os').homedir())"], { env: process.env })
    expect(child.stdout.toString().trim()).toBe(join(testRoot, "home"))
  })
})
