import { expect, test } from "bun:test"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { backlogTaskOne, refuseOnQuestions, startOnLinux } from "./parked-helpers"
import { binPath, type Fixture, mainToken, orcOk, queuedArgs, runnerTimeout, withFixture } from "./runner-helpers"

const writeQuota = (fixture: Fixture, remainingPercent: number) =>
  writeFile(join(fixture.dir, "reviewer-quota.json"), JSON.stringify({
    schema: "orc.quota.v1",
    accounts: [{ name: "main", remainingPercent: 90 }, { name: "beta-main", remainingPercent }]
  }))

const configureReviewers = async (fixture: Fixture) => {
  const quotaCommand = join(fixture.dir, "bin", "reviewer-quota")
  await writeFile(quotaCommand, "#!/bin/sh\ncat \"" + join(fixture.dir, "reviewer-quota.json") + "\"\n")
  await chmod(quotaCommand, 0o755)
  await writeFile(join(fixture.home, "config.json"), JSON.stringify({
    providers: [{ id: "acme", credential: "pi-login" }, { id: "beta", credential: "pi-login" }],
    reviewers: [{ provider: "acme", model: "acme/coder" }, { provider: "beta", model: "beta/reviewer" }]
  }))
  await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
    machines: [{ name: "linux", slots: 1, start: [process.execPath, binPath, "runner", "start"] }],
    quota: {
      provider: "acme",
      command: [quotaCommand],
      accounts: [{ name: "main", tokenFile: mainToken }, { name: "beta-main", kind: "none", provider: "beta", models: { implementer: "beta/coder", fixer: "beta/coder" } }],
      floorPercent: 15
    }
  }))
}

test("the beat resumes the same run instead of waiting when the reviewer account recovers above the original account", async () => {
  await withFixture(async (fixture) => {
    await startOnLinux(fixture)
    await configureReviewers(fixture)
    await writeQuota(fixture, 2)
    await refuseOnQuestions(fixture, [], "review")
    const reason = "beta-main 2% left, floor 15%"
    const runDir = join(fixture.home, "runs", "run-1")
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, "reviewer-wait.json"), JSON.stringify({ implementerProviders: ["acme"], reason, head: "0".repeat(40), sentPerRound: [] }))

    expect(await orcOk(fixture, ["beat"])).toContain("parked orc-1 on orc/orc-1: " + reason)
    expect(await backlogTaskOne(fixture)).toMatchObject({ parked: { questions: [] } })
    const waiting = await orcOk(fixture, ["beat"])
    expect(waiting).toContain("waits orc-1:")
    expect(waiting).toContain(reason)
    expect(waiting).not.toContain("started orc-1")
    expect(await Bun.file(join(fixture.pueue, "add-args")).exists()).toBe(false)

    await writeQuota(fixture, 95)
    expect(await orcOk(fixture, ["beat"])).toContain("started orc-1 on linux with beta-main")
    const added = await queuedArgs(fixture)
    expect(added).toContain("ORC_DISPATCH_RESUME_RUN=run-1")
    expect(added?.slice(added.indexOf("--branch"))).toEqual([
      "--branch", "orc/orc-1", "--sandbox", "none", "--provider", "beta",
      "--implementer-model", "beta/coder", "--fixer-model", "beta/coder", "--delivery", "orc"
    ])
  })
}, runnerTimeout)
