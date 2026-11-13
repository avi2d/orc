import { expect, test } from "bun:test"
import { join } from "node:path"
import { git, seedRepo } from "../run-helpers"
import { runOrc, runnerTimeout, withFixture } from "../runner-helpers"

test("a queued parked resume refuses missing history at execution instead of ignoring its run pin", async () => {
  await withFixture(async (fixture) => {
    await seedRepo(fixture.checkout)
    git(fixture.checkout, ["branch", "orc/orc-1"])
    const result = await runOrc({ ...fixture, dir: fixture.checkout }, [
      "run", join(fixture.dir, "task.md"), "--branch", "orc/orc-1", "--sandbox", "none"
    ], { ORC_DISPATCH_RESUME_RUN: "missing-run", HEAVY_QUEUE_BYPASS: "disposable resume fixture" })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("cannot resume missing-run")
    expect(result.stderr).toContain("no previous run is available")
  })
}, runnerTimeout)
