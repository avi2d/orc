import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { skipReason } from "@avi2dg/checks/scripts/test-skips.ts"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { shellInAgent } from "../../packages/run/src/agent-exec"
import { openNonoExec } from "../../packages/run/src/nono-exec"

const git = (cwd: string, args: ReadonlyArray<string>): void => {
  const result = Bun.spawnSync(["git", "-c", "user.name=orc", "-c", "user.email=orc@example.com", ...args], { cwd, env: { PATH: Bun.env.PATH ?? "", HOME: Bun.env.HOME ?? "", GIT_CONFIG_NOSYSTEM: "1" } })
  if (result.exitCode !== 0) {
    throw new Error("git " + args.join(" ") + ": " + result.stderr.toString())
  }
}

// nono refuses a HOME whose state root falls under the /var or /tmp it grants, so the fixture home sits in the working tree.
const fixtureHome = (): Promise<string> => mkdtemp(join(process.cwd(), ".orc-nono-exec-home-"))

const seedCopy = async (dir: string): Promise<void> => {
  const main = join(dir, "main")
  await mkdir(main)
  git(main, ["init", "-q", "-b", "main"])
  await writeFile(join(main, "a.txt"), "a\n")
  git(main, ["add", "a.txt"])
  git(main, ["commit", "-qm", "seed"])
  git(main, ["worktree", "add", "-q", "-b", "orc/t", join(dir, "copy")])
}

const runInNono = (dir: string, home: string, command: string, readFolders: ReadonlyArray<string> = []) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const exec = yield* openNonoExec({
      worktree: join(dir, "copy"),
      piSessionDir: join(dir, "run", "session"),
      sessionsDir: join(dir, "run", "sessions"),
      hostEnv: { PATH: Bun.env.PATH, HOME: home },
      readFolders,
      env: { ORC_HOME: join(dir, "orc-home"), AGENT_TOKEN_FILE: "/k" }
    })
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* shellInAgent(spawner, exec, command)
  })).pipe(Effect.provide(BunServices.layer)))

describe("openNonoExec", () => {
  test.skipIf(Bun.which("nono") === null)(
    skipReason("needs nono on PATH to run the sandbox", "a sandboxed command writes the copy and the sessions folder, sees no ORC_ variable, and cannot write beside the copy"),
    async () => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), "orc-nono-exec-")))
      const home = await fixtureHome()
      try {
        await seedCopy(dir)
        const result = await runInNono(dir, home, [
          "env | grep '^ORC_' || true",
          "echo \"token=$AGENT_TOKEN_FILE bun=$BUN_OPTIONS\"",
          "echo made > made.txt",
          "echo session > \"" + join(dir, "run", "sessions", "s.jsonl") + "\"",
          "git add made.txt && git -c user.name=a -c user.email=a@b commit -qm made && echo committed",
          "echo escaped > \"" + join(dir, "beside.txt") + "\" 2>/dev/null || echo refused"
        ].join("; "))
        expect(result.stdout.split("\n").filter((line) => line !== "")).toEqual(["token=/k bun=--no-install", "committed", "refused"])
        expect(await readFile(join(dir, "copy", "made.txt"), "utf8")).toBe("made\n")
        expect(await readFile(join(dir, "run", "sessions", "s.jsonl"), "utf8")).toBe("session\n")
        expect(await Bun.file(join(dir, "beside.txt")).exists()).toBe(false)
      } finally {
        await rm(dir, { recursive: true, force: true })
        await rm(home, { recursive: true, force: true })
      }
    },
    60_000
  )

  test.skipIf(Bun.which("nono") === null)(
    skipReason("needs nono on PATH to run the sandbox", "a folder the operator lists is readable but not writable, and its unlisted sibling stays unreadable"),
    async () => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), "orc-nono-exec-")))
      const home = await fixtureHome()
      try {
        await seedCopy(dir)
        await mkdir(join(home, "cache"))
        await writeFile(join(home, "cache", "record"), "cached\n")
        await mkdir(join(home, "other"))
        await writeFile(join(home, "other", "secret"), "secret\n")
        const result = await runInNono(dir, home, [
          "cat \"" + join(home, "cache", "record") + "\"",
          "echo x > \"" + join(home, "cache", "new") + "\" 2>/dev/null || echo write-refused",
          "cat \"" + join(home, "other", "secret") + "\" 2>/dev/null || echo read-refused"
        ].join("; "), [join(home, "cache")])
        expect(result.stdout.split("\n").filter((line) => line !== "")).toEqual(["cached", "write-refused", "read-refused"])
      } finally {
        await rm(dir, { recursive: true, force: true })
        await rm(home, { recursive: true, force: true })
      }
    },
    60_000
  )
})
