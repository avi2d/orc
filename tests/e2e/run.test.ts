import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { runAgentStep } from "../../src/run"

const git = (dir: string, args: ReadonlyArray<string>): void => {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir })
  if (result.exitCode !== 0) {
    throw new Error("the git fixture failed: git " + args.join(" "))
  }
}

const withRepo = async (use: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-run-unit-"))
  try {
    git(dir, ["init", "-q"])
    git(dir, ["config", "user.name", "orc test"])
    git(dir, ["config", "user.email", "orc@test.invalid"])
    await writeFile(join(dir, "seed.txt"), "seed\n")
    git(dir, ["add", "seed.txt"])
    git(dir, ["commit", "-qm", "seed"])
    await use(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const withHome = async (use: (home: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(join(tmpdir(), "orc-run-home-"))
  try {
    await use(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const refusal = (input: {
  readonly cwd: string
  readonly taskFile: string
  readonly home: string
  readonly branch?: string
  readonly agentsDir?: string
}): Promise<string> =>
  Effect.runPromise(
    runAgentStep({ cwd: input.cwd, taskFile: input.taskFile, branch: input.branch, homeDir: input.home, runId: "test-run-1", agentsDir: input.agentsDir }).pipe(
      Effect.provide(BunServices.layer),
      Effect.as("ran"),
      Effect.catchTag("OrcRunError", (cause) => Effect.succeed(cause.message))
    )
  )

describe("runAgentStep refusals", () => {
  test("a directory in no git checkout is refused", async () => {
    await withHome(async (home) => {
      const dir = await mkdtemp(join(tmpdir(), "orc-run-plain-"))
      try {
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home })).toContain("sits in no git checkout")
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  test("a checkout with uncommitted changes is refused", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await writeFile(join(dir, "draft.txt"), "uncommitted\n")
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home })).toContain("uncommitted changes")
      })
    })
  })

  test("a firstmate checkout is refused", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        await writeFile(join(dir, ".fm-slot-owner"), "some-slot\n")
        git(dir, ["add", ".fm-slot-owner"])
        git(dir, ["commit", "-qm", "slot marker"])
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home })).toContain("firstmate checkout")
      })
    })
  })

  test("an unusable branch name is refused", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home, branch: "bad..name" })).toContain("no usable branch name")
      })
    })
  })

  test("a missing task file is refused", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        expect(await refusal({ cwd: dir, taskFile: join(dir, "missing.md"), home, branch: "orc/test" })).toContain("cannot read the task file")
      })
    })
  })

  test("a model orc cannot route is refused", async () => {
    await withRepo(async (dir) => {
      await withHome(async (home) => {
        const agentsDir = join(home, "agents")
        await writeFile(join(dir, "task.md"), "Do nothing.\n")
        git(dir, ["add", "task.md"])
        git(dir, ["commit", "-qm", "task"])
        await mkdir(agentsDir, { recursive: true })
        await writeFile(join(agentsDir, "implementer.md"), "---\nmodel: example.com/other-model\nthinking: low\ntools: read\n---\nDo it.\n")
        expect(await refusal({ cwd: dir, taskFile: join(dir, "task.md"), home, branch: "orc/test", agentsDir })).toContain("routes only opencode-go models")
      })
    })
  })
})
