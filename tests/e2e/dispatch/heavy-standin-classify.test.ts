import { afterEach, describe, expect, test } from "bun:test"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { run, setup, type Harness } from "./heavy-standin-harness"

let harnesses: Array<Harness> = []

afterEach(async () => {
  for (const harness of harnesses) {
    await rm(harness.root, { recursive: true, force: true })
  }
  harnesses = []
})

describe("the heavy stand-in", () => {
  test("classify names the queue decision without queueing", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun", "npm", "go"])) - 1]
    const classify = { HEAVY_CLASSIFY: "1" }
    expect(run(harness, "bun", ["test", "x"], classify).stdout.trim()).toBe("1 1")
    expect(run(harness, "bun", ["test", "--timeout", "20000"], classify).stdout.trim()).toBe("1 0")
    expect(run(harness, "bun", ["run", "dev"], classify).stdout.trim()).toBe("0 0")
    expect(run(harness, "npm", ["install"], classify).stdout.trim()).toBe("0 0")
    expect(run(harness, "go", ["test", "-timeout", "10m", "./..."], classify).stdout.trim()).toBe("1 0")
    expect(await harness.pueueLog()).toBe("")
  })

  test("bun x on a named test file queues with priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["x", "vitest", "login.test.ts"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("-o 1")
  })

  test("bun run dev never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["run", "dev"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
    expect(await readFile(join(harness.root, "tool.log"), "utf8")).toContain("bun run dev")
  })

  test("bun run test:ui never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["run", "test:ui"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
  })

  test("a bun test watch run never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["test", "--watch"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
  })

  test("a tsc watch run never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["tsc"])) - 1]
    const result = run(harness, "tsc", ["-w"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
  })

  test("a vitest watch run never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["vitest"])) - 1]
    const result = run(harness, "vitest", ["-w"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
  })

  test("a vitest dev run never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["vitest"])) - 1]
    const result = run(harness, "vitest", ["dev"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
  })

  test("a filtered pnpm test run queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["pnpm"])) - 1]
    const result = run(harness, "pnpm", ["--filter", "web", "test"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("a recursive pnpm test run queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["pnpm"])) - 1]
    const result = run(harness, "pnpm", ["-r", "test"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("a yarn workspace test run queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["yarn"])) - 1]
    const result = run(harness, "yarn", ["workspace", "web", "test"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("an npm test run under a directory flag queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["npm"])) - 1]
    const result = run(harness, "npm", ["--prefix", "web", "test"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("npm t queues like npm test", async () => {
    const harness = harnesses[harnesses.push(await setup(["npm"])) - 1]
    const result = run(harness, "npm", ["t"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("an npm exec of a heavy tool queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["npm"])) - 1]
    const result = run(harness, "npm", ["exec", "--", "vitest", "run"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("a filtered bun test run queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["--filter", "web", "test"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("bun run with a build argument past the script never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["bun"])) - 1]
    const result = run(harness, "bun", ["run", "scripts/release.ts", "build"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
  })

  test("npm run with a test flag past the script never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["npm"])) - 1]
    const result = run(harness, "npm", ["run", "deploy", "--", "--env", "test"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
  })

  test("a configured cargo subcommand queues through the built in body", async () => {
    const harness = harnesses[harnesses.push(await setup(["cargo"], ["cargo nextest"])) - 1]
    const result = run(harness, "cargo", ["nextest", "run"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("a configured npm subcommand queues through the built in body", async () => {
    const harness = harnesses[harnesses.push(await setup(["npm"], ["npm ci"])) - 1]
    const result = run(harness, "npm", ["ci"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("classify keeps priority on a filter past an option value", async () => {
    const harness = harnesses[harnesses.push(await setup(["pytest", "playwright"])) - 1]
    const classify = { HEAVY_CLASSIFY: "1" }
    expect(run(harness, "pytest", ["-c", "cfg.ini", "-k", "foo"], classify).stdout.trim()).toBe("1 1")
    expect(run(harness, "playwright", ["test", "--project", "chromium", "-g", "login"], classify).stdout.trim()).toBe("1 1")
    expect(await harness.pueueLog()).toBe("")
  })

  test("classify leaves watch runs out of the queue", async () => {
    const harness = harnesses[harnesses.push(await setup(["tsc", "vitest", "npx"])) - 1]
    const classify = { HEAVY_CLASSIFY: "1" }
    expect(run(harness, "tsc", ["-w"], classify).stdout.trim()).toBe("0 0")
    expect(run(harness, "vitest", ["-w"], classify).stdout.trim()).toBe("0 0")
    expect(run(harness, "vitest", ["dev"], classify).stdout.trim()).toBe("0 0")
    expect(run(harness, "npx", ["tsc", "-w"], classify).stdout.trim()).toBe("0 0")
    expect(await harness.pueueLog()).toBe("")
  })

  test("classify queues monorepo test runs", async () => {
    const harness = harnesses[harnesses.push(await setup(["pnpm", "yarn", "npm", "bun"])) - 1]
    const classify = { HEAVY_CLASSIFY: "1" }
    expect(run(harness, "pnpm", ["--filter", "web", "test"], classify).stdout.trim()).toBe("1 0")
    expect(run(harness, "pnpm", ["-r", "test"], classify).stdout.trim()).toBe("1 0")
    expect(run(harness, "yarn", ["workspace", "web", "test"], classify).stdout.trim()).toBe("1 0")
    expect(run(harness, "npm", ["--prefix", "web", "test"], classify).stdout.trim()).toBe("1 0")
    expect(run(harness, "npm", ["t"], classify).stdout.trim()).toBe("1 0")
    expect(run(harness, "npm", ["exec", "--", "vitest", "run"], classify).stdout.trim()).toBe("1 0")
    expect(run(harness, "bun", ["--filter", "web", "test"], classify).stdout.trim()).toBe("1 0")
    expect(await harness.pueueLog()).toBe("")
  })

  test("go test queues with priority on a named package", async () => {
    const harness = harnesses[harnesses.push(await setup(["go"])) - 1]
    const result = run(harness, "go", ["test", "./pkg/foo"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("-o 1")
  })

  test("a whole go test run queues without priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["go"])) - 1]
    const result = run(harness, "go", ["test", "./..."])
    expect(result.code).toBe(0)
    const log = await harness.pueueLog()
    expect(log).toContain("add --group heavy")
    expect(log).not.toContain("-o 1")
  })

  test("go vet queues without priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["go"])) - 1]
    const result = run(harness, "go", ["vet", "./..."])
    expect(result.code).toBe(0)
    const log = await harness.pueueLog()
    expect(log).toContain("add --group heavy")
    expect(log).not.toContain("-o 1")
  })

  test("go test with an option value queues without priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["go"])) - 1]
    const result = run(harness, "go", ["test", "-timeout", "10m", "./..."])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).not.toContain("-o 1")
  })

  test("go version never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["go"])) - 1]
    const result = run(harness, "go", ["version"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
    expect(await readFile(join(harness.root, "tool.log"), "utf8")).toContain("go version")
  })

  test("vitest run queues without priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["vitest"])) - 1]
    const result = run(harness, "vitest", ["run"])
    expect(result.code).toBe(0)
    const log = await harness.pueueLog()
    expect(log).toContain("add --group heavy")
    expect(log).not.toContain("-o 1")
  })

  test("vitest on a bare word queues with priority instead of waiting behind whole suites", async () => {
    const harness = harnesses[harnesses.push(await setup(["vitest"])) - 1]
    const result = run(harness, "vitest", ["login"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("-o 1")
  })

  test("vitest watch never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["vitest"])) - 1]
    const result = run(harness, "vitest", ["watch"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
  })

  test("jest on a bare word queues with priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["jest"])) - 1]
    const result = run(harness, "jest", ["login"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("-o 1")
  })

  test("eslint on a bare folder queues without priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["eslint"])) - 1]
    const result = run(harness, "eslint", ["src"])
    expect(result.code).toBe(0)
    const log = await harness.pueueLog()
    expect(log).toContain("add --group heavy")
    expect(log).not.toContain("-o 1")
  })

  test("tsc with an option value queues without priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["tsc"])) - 1]
    const result = run(harness, "tsc", ["-p", "tsconfig.json"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).not.toContain("-o 1")
  })

  test("npm run test with a filter queues with priority", async () => {
    const harness = harnesses[harnesses.push(await setup(["npm"])) - 1]
    const result = run(harness, "npm", ["run", "test", "--", "-t", "login"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("-o 1")
  })

  test("npm run test:watch never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["npm"])) - 1]
    const result = run(harness, "npm", ["run", "test:watch"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
  })

  test("npx runs a heavy tool through the queue", async () => {
    const harness = harnesses[harnesses.push(await setup(["npx"])) - 1]
    const result = run(harness, "npx", ["vitest", "run"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("a machine command queues under its first word", async () => {
    const harness = harnesses[harnesses.push(await setup(["checks-test"], ["checks-test"])) - 1]
    const result = run(harness, "checks-test", ["--changed"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("-o 1")
  })

  test("an unknown tool never queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["mytool"])) - 1]
    const result = run(harness, "mytool", ["foo"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toBe("")
    expect(await readFile(join(harness.root, "tool.log"), "utf8")).toContain("mytool foo")
  })

  test("xcodebuild queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["xcodebuild"])) - 1]
    const result = run(harness, "xcodebuild", ["-scheme", "App"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })

  test("xcrun simctl boot queues", async () => {
    const harness = harnesses[harnesses.push(await setup(["xcrun"])) - 1]
    const result = run(harness, "xcrun", ["simctl", "boot", "uuid"])
    expect(result.code).toBe(0)
    expect(await harness.pueueLog()).toContain("add --group heavy")
  })
})
