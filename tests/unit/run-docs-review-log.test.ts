import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const runDoc = (page: string): string => readFileSync(new URL(`../../docs/run/${page}`, import.meta.url), "utf8")

test.each(["how-orc-runs-pi.md", "seeing-runs.md"])("%s names review-<n>.log, so a long review is not read as a stalled run", (page) => {
  expect(runDoc(page)).toContain("review-<n>.log")
})
