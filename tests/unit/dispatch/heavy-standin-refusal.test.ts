import { afterEach, describe, expect, test } from "bun:test"
import { refusedPathCall } from "../../../packages/run/src/entities/heavy-queue/heavy-standin-refusal"

describe("refusedPathCall under HEAVY_TESTS_CI_ONLY=1", () => {
  const previous = Bun.env.HEAVY_TESTS_CI_ONLY

  afterEach(() => {
    if (previous === undefined) {
      delete Bun.env.HEAVY_TESTS_CI_ONLY
    } else {
      Bun.env.HEAVY_TESTS_CI_ONLY = previous
    }
  })

  test.each([
    "nice -n 10 ./node_modules/.bin/vitest run",
    "sh -c 'cd . && ./node_modules/.bin/vitest run'"
  ])("refuses %s instead of letting the test run through", (command) => {
    Bun.env.HEAVY_TESTS_CI_ONLY = "1"
    expect(refusedPathCall(command, process.cwd())).toBe(true)
  })

  test("allows command -v instead of refusing a lookup", () => {
    Bun.env.HEAVY_TESTS_CI_ONLY = "1"
    expect(refusedPathCall("command -v ./node_modules/.bin/vitest", process.cwd())).toBe(false)
  })
})
