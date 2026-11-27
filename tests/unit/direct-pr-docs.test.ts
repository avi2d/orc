import { expect, test } from "bun:test"
import { checkpointFileName } from "../../packages/run/src/features/running-a-task/review-turn"

test("direct-PR delivery names the checkpoint written by the review turn", async () => {
  const docs = await Bun.file(new URL("../../docs/run/delivery-modes.md", import.meta.url)).text()
  expect(checkpointFileName).toBe("review-checkpoint.json")
  expect(docs).toContain("`" + checkpointFileName + "`")
})
