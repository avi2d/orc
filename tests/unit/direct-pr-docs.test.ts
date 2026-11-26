import { expect, test } from "bun:test"

test("direct-PR delivery names the checkpoint written by the review turn", async () => {
  const source = await Bun.file(new URL("../../packages/run/src/features/running-a-task/review-turn.ts", import.meta.url)).text()
  const docs = await Bun.file(new URL("../../docs/run/delivery-modes.md", import.meta.url)).text()
  const name = source.match(/const checkpointFileName = "([^"]+)"/)?.[1]
  expect(name).toBe("review-checkpoint.json")
  expect(docs).toContain("`" + name + "`")
})
