import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { run, setup, type Harness } from "./heavy-standin-harness"

describe("test refusal through the heavy stand-in", () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await setup(["bun", "bunx", "npm", "npx", "pnpm", "yarn", "go", "cargo", "pytest", "vitest", "jest", "playwright"])
  })

  afterAll(async () => {
    await rm(harness.root, { recursive: true, force: true })
  })

  test.each([
    "go test -v ./...",
    "pytest -v",
    "pytest tests -v",
    "cargo test -v",
    "cargo t -v",
    "bun test -v",
    "bun run test -- -v",
    "bunx vitest -v",
    "npm test -- -v",
    "npm run test -- -v",
    "npm exec -- jest -v",
    "npx jest -v",
    "pnpm test -- -v",
    "yarn test -v",
    "vitest run -v",
    "jest tests -v",
    "playwright test -h",
    "bun --cwd pkg test",
    "bun --cwd=pkg test",
    "bun --cwd pkg run test",
    "bun run --cwd pkg test",
    "bun --cwd pkg x vitest",
    "bunx --cwd pkg vitest",
    "npm --prefix pkg test",
    "npm --prefix=pkg run test",
    "pnpm -C dir test",
    "pnpm --dir dir test",
    "pnpm --dir=dir test",
    "pnpm -C dir run test",
    "pnpm run -C dir test",
    "pnpm --dir dir exec vitest",
    "pnpm --dir=dir dlx jest",
    "yarn --cwd pkg test",
    "yarn --cwd=pkg run test",
    "yarn workspace pkg test -v"
  ])("%s cannot reach the real runner through verbose or directory options", (command) => {
    const [tool = "", ...args] = command.split(" ")
    const result = run(harness, tool, args, { HEAVY_TESTS_CI_ONLY: "1" })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("orc heavy: " + command + " starts a test run")
  })

  test.each([
    "bun --version",
    "bun -v",
    "npm -v",
    "pnpm -v",
    "vitest -v",
    "jest -v",
    "pytest --version",
    "pytest --help",
    "cargo --version",
    "go version",
    "bun --cwd pkg run build",
    "bun --cwd=pkg run lint",
    "bun run --cwd pkg typecheck",
    "bun --cwd test run build",
    "bunx --cwd test tsc",
    "npm --prefix test run build",
    "pnpm -C test run lint",
    "pnpm --dir=test exec tsc",
    "pnpm run --dir test typecheck",
    "yarn --cwd test run build"
  ])("%s delegates unchanged instead of refusing a non-test command", async (command) => {
    const [tool = "", ...args] = command.split(" ")
    const result = run(harness, tool, args, { HEAVY_TESTS_CI_ONLY: "1", HEAVY_QUEUE_UNREACHABLE: "1" })
    expect(result.code).toBe(0)
    expect(result.stderr).not.toContain("starts a test run")
    expect(await readFile(join(harness.root, "tool.log"), "utf8")).toContain(command + "\n")
    expect(await harness.pueueLog()).toBe("")
  })
})
