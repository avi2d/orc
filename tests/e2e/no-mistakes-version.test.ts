import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { noMistakesVersionProblem } from "../../src/no-mistakes"

const versionProblem = async (script: string): Promise<string | null> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-nm-version-"))
  try {
    const binary = join(dir, "nm-elsewhere")
    await writeFile(binary, "#!/bin/sh\n" + script + "\n")
    await chmod(binary, 0o755)
    return await Effect.runPromise(Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return yield* noMistakesVersionProblem({ spawner, binary, pathEnv: process.env.PATH ?? "", git: Bun.which("git") ?? "git" }, dir)
    }).pipe(Effect.provide(BunServices.layer)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const printsVersion = (version: string): string => "echo 'no-mistakes version " + version + " (b529e95) 2026-10-24T13:25:56Z'"

describe("the no-mistakes version orc drives", () => {
  test("a release older than v1.90.0 is refused naming its version and the minimum", async () => {
    for (const version of ["v1.84.0", "v1.89.0"]) {
      const problem = await versionProblem(printsVersion(version))
      expect(problem).toContain(version.slice(1))
      expect(problem).toContain("v1.90.0 or later")
      expect(problem).toContain("https://github.com/kunchenguid/no-mistakes/releases")
    }
  })

  test("v1.90.0, a later minor release and a fork build are accepted", async () => {
    for (const version of ["v1.90.0", "v1.100.2", "v1.100.1+avi2d.26", "v2.0.0"]) {
      expect(await versionProblem(printsVersion(version))).toBeNull()
    }
  })

  test("a binary that prints no version is accepted", async () => {
    expect(await versionProblem("echo 'a wrapper'")).toBeNull()
  })

  test("a binary whose --version fails is refused naming the binary and the install", async () => {
    const problem = await versionProblem("echo 'not installed' >&2; exit 127")
    expect(problem).toContain("nm-elsewhere --version failed: not installed")
    expect(problem).toContain("https://github.com/kunchenguid/no-mistakes")
  })
})
