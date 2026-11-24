import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { interpretedRunner } from "../../../packages/run/src/entities/heavy-queue/heavy-runner-entry"

describe("the runner a bun or node call starts", () => {
  let root: string

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orc-runner-entry-")))
    const modules = join(root, "node_modules")
    const packages: ReadonlyArray<readonly [string, unknown, ReadonlyArray<string>]> = [
      ["@avi2dg/checks", { name: "@avi2dg/checks", bin: { "checks-test": "src/test.ts", "checks-lint": "src/lint.ts" } }, ["src/test.ts", "src/lint.ts"]],
      ["@playwright/test", { name: "@playwright/test", bin: { playwright: "cli.js" } }, ["cli.js"]],
      ["jest", { name: "jest", bin: "bin/jest.js" }, ["bin/jest.js"]]
    ]
    for (const [name, manifest, files] of packages) {
      await mkdir(join(modules, name), { recursive: true })
      await writeFile(join(modules, name, "package.json"), JSON.stringify(manifest))
      for (const file of files) {
        await mkdir(join(modules, name, file, ".."), { recursive: true })
        await writeFile(join(modules, name, file), "")
      }
    }
    await mkdir(join(modules, ".bin"))
    await symlink("../@avi2dg/checks/src/test.ts", join(modules, ".bin", "checks-test"))
    await symlink("../@avi2dg/checks/src/lint.ts", join(modules, ".bin", "checks-lint"))
    await symlink("../@playwright/test/cli.js", join(modules, ".bin", "playwright"))
    await symlink("../jest/bin/jest.js", join(modules, ".bin", "jest"))
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test("bun starting the checks-test bin through its node_modules/.bin link is checks-test, not an unknown script", () => {
    expect(interpretedRunner("bun", [join(root, "node_modules/.bin/checks-test"), "--tier=unit"], root)).toBe("checks-test")
  })

  test("a relative bin path resolves against the caller's folder instead of the stand-in's", () => {
    expect(interpretedRunner("bun", ["run", "node_modules/.bin/checks-test"], root)).toBe("checks-test")
  })

  test("another bin of the checks package is no runner, so a lint through it is not refused", () => {
    expect(interpretedRunner("bun", ["node_modules/.bin/checks-lint", "tests/e2e"], root)).toBeNull()
  })

  test("playwright is a runner only with its test subcommand, so an install still runs", () => {
    expect(interpretedRunner("node", ["node_modules/.bin/playwright", "test"], root)).toBe("playwright test")
    expect(interpretedRunner("node", ["node_modules/.bin/playwright", "install"], root)).toBeNull()
  })

  test("a bin given as one string is named after the package, so jest is found without a bin map", () => {
    expect(interpretedRunner("node", ["node_modules/.bin/jest"], root)).toBe("jest")
  })

  test("the value of node's --require is not taken for the script it starts", () => {
    expect(interpretedRunner("node", ["--require", "node_modules/.bin/checks-lint", "node_modules/.bin/jest"], root)).toBe("jest")
  })

  test("node --test is a test run even with no file named", () => {
    expect(interpretedRunner("node", ["--test"], root)).toBe("node --test")
  })

  test("a file argument after node -e is no script, so inline code naming a runner path is not refused", () => {
    expect(interpretedRunner("node", ["-e", "1", "node_modules/.bin/jest"], root)).toBeNull()
  })

  test("a tool other than bun or node starts no script of its own", () => {
    expect(interpretedRunner("npm", ["node_modules/.bin/jest"], root)).toBeNull()
  })
})
