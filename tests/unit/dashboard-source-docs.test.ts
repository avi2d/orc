import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"

test("rejects dashboard source commands without a checkout setup link", async () => {
  const docs = new URL("../../docs/", import.meta.url)
  const files = (await readdir(docs)).filter((file) => /^dash.*\.md$/.test(file))
  const pages = await Promise.all(files.map(async (file) => ({
    file,
    source: await readFile(new URL(file, docs), "utf8")
  })))
  const sourcePages = pages.filter(({ source }) => /\bbun run (?:dashboard(?:-print)?|resources-json|tasks-(?:sample|live-json))\b/.test(source))
  expect(sourcePages.map(({ file }) => file).sort()).toEqual([
    "dash-dashboard.md",
    "dash-resources.md",
    "dash-tasks.md",
    "dash.md"
  ])
  for (const { file, source } of sourcePages) {
    expect(source, file).toContain("](contribute.md#run-orc-from-a-checkout)")
  }
})
