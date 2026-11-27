import { expect, test } from "bun:test"
import { Effect } from "effect"
import { openDirectPr, type PullRequestOpener } from "../../packages/run/src/entities/pull-request/index"

test("body preparation waits for push and an absent open PR rather than running for an existing PR", async () => {
  const events: Array<string> = []
  const reply = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 })
  const link = "https://example.org/owner/repo/pull/1"
  const opener: PullRequestOpener = {
    fetch: Effect.succeed(reply()),
    push: Effect.sync(() => { events.push("push"); return reply() }),
    existing: Effect.sync(() => { events.push("existing"); return reply() }),
    create: () => Effect.sync(() => { events.push("create"); return reply(link) })
  }
  const prepare = Effect.sync(() => { events.push("prepare"); return "body.md" })
  await Effect.runPromise(openDirectPr(opener, "branch", "title", prepare))
  expect(events).toEqual(["push", "existing", "prepare", "create"])
  events.length = 0
  await Effect.runPromise(openDirectPr({ ...opener, existing: Effect.sync(() => { events.push("existing"); return reply(link) }) }, "branch", "title", prepare))
  expect(events).toEqual(["push", "existing"])
})
