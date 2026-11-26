import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const heavyQueueDoc = readFileSync(new URL("../../docs/run/heavy-queue.md", import.meta.url), "utf8")

test("heavy-queue.md says the Pi prompt permits build, lint or typecheck and leaves repository tests to CI, so a reader does not take the prompt for a test ban", () => {
  expect(heavyQueueDoc).toContain("Pi prompt")
  expect(heavyQueueDoc).toContain("You may run build, lint, or typecheck.")
})
