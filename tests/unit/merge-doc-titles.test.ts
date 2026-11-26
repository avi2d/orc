import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const docs = new URL("../../docs/run/", import.meta.url)

test("rejects the beat's automatic merge section sharing the merge command page title", () => {
  const beat = readFileSync(new URL("beat-runs.md", docs), "utf8")
  const merge = readFileSync(new URL("merging-a-tasks-pr.md", docs), "utf8")
  const section = beat.match(/^## (.+)\n\nOn a project with `"yolo": true`/m)?.[1]
  const title = merge.match(/^# (.+)$/m)?.[1]
  expect(section).toBeDefined()
  expect(title).toBeDefined()
  expect(section).not.toBe(title)
})
