import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { runAgentStep } from "../../src/run"
import { listRuns, openDatabase } from "../../src/run-history"

const git = (dir: string, args: ReadonlyArray<string>): void => {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir })
  if (result.exitCode !== 0) {
    throw new Error("the git fixture failed: git " + args.join(" "))
  }
}

describe("orc run through the agent step", () => {
  test.skipIf(process.env["ORC_PI_E2E"] !== "1")("a live agent run commits on its branch", async () => {
    const repo = await mkdtemp(join(tmpdir(), "orc-agent-repo-"))
    const home = await mkdtemp(join(tmpdir(), "orc-agent-home-"))
    try {
      git(repo, ["init", "-q"])
      git(repo, ["config", "user.name", "orc test"])
      git(repo, ["config", "user.email", "orc@test.invalid"])
      await writeFile(join(repo, "task.md"), "Create greeting.txt in the repo root holding the single line hello from orc, then commit it.\n")
      git(repo, ["add", "task.md"])
      git(repo, ["commit", "-qm", "task"])
      const report = await Effect.runPromise(
        runAgentStep({ cwd: repo, taskFile: join(repo, "task.md"), branch: "orc/e2e-agent", homeDir: home, runId: "e2e-agent-1" }).pipe(
          Effect.provide(BunServices.layer)
        )
      )
      expect(report.completed).toBe(true)
      expect(report.commits?.length).toBe(1)
      const log = Bun.spawnSync(["git", "log", "orc/e2e-agent", "--format=%s"], { cwd: repo })
      expect(log.exitCode).toBe(0)
      const runs = await Effect.runPromise(
        openDatabase(home).pipe(
          Effect.provide(BunServices.layer),
          Effect.flatMap((db) =>
            Effect.acquireUseRelease(Effect.succeed(db), (open) => listRuns(open), (open) => Effect.sync(() => open.close()))
          )
        )
      )
      expect(runs.map((run) => run.id)).toContain("e2e-agent-1")
    } finally {
      await rm(repo, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  }, 600_000)
})
