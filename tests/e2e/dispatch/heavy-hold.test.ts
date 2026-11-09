import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Schema } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { heavyHoldLabel, withHeavyHold } from "../../../packages/run/src/dispatch/heavy-hold"

const realEnv = (): Record<string, string | undefined> => ({ ...process.env, HOME: homedir() })

const realPueue = (args: ReadonlyArray<string>): { stdout: string; exitCode: number } => {
  const result = Bun.spawnSync(["pueue", ...args], { stdout: "pipe", stderr: "ignore", env: realEnv() })
  return { stdout: result.stdout.toString(), exitCode: result.exitCode ?? 1 }
}

const noPueue = (): boolean => {
  try {
    return realPueue(["status", "--json"]).exitCode !== 0
  } catch {
    return true
  }
}

const fakePueue = `#!/bin/sh
echo "pueue $*" >> "$FAKE_PUEUE_LOG"
case "$1" in
  group) echo '{}';;
  status) echo '{"tasks":{},"groups":{}}';;
  add) echo 7;;
esac
exit 0
`

const withFakePueue = async <A>(fn: (log: string) => Promise<A>): Promise<A> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-hold-fake-"))
  const log = join(dir, "pueue.log")
  await writeFile(join(dir, "pueue"), fakePueue, { mode: 0o755 })
  await writeFile(log, "")
  const path = process.env.PATH ?? ""
  const savedLog = process.env.FAKE_PUEUE_LOG
  process.env.PATH = dir + ":" + path
  process.env.FAKE_PUEUE_LOG = log
  try {
    return await fn(log)
  } finally {
    process.env.PATH = path
    if (savedLog === undefined) {
      delete process.env.FAKE_PUEUE_LOG
    } else {
      process.env.FAKE_PUEUE_LOG = savedLog
    }
    await rm(dir, { recursive: true, force: true })
  }
}

const holdVerbs = async (log: string): Promise<ReadonlyArray<string>> => {
  const text = await Bun.file(log).text()
  return text.split("\n").filter((line) => line !== "").map((line) => line.split(" ")[1] ?? "")
}

const skipReason = (reason: string, behavior: string): string => reason + " (" + behavior + ")"

const StatusState = Schema.Struct({
  tasks: Schema.Record(Schema.String, Schema.Struct({
    id: Schema.Int,
    label: Schema.NullOr(Schema.String),
    group: Schema.String,
    status: Schema.Record(Schema.String, Schema.Unknown)
  }))
})

const statusOf = (group: string): Array<{ id: number; label: string | null; status: string }> => {
  const out = realPueue(["status", "--json"])
  const state = Schema.decodeUnknownSync(StatusState)(JSON.parse(out.stdout))
  return Object.values(state.tasks)
    .filter((task) => task.group === group)
    .map((task) => ({ id: task.id, label: task.label, status: Object.keys(task.status)[0] ?? "?" }))
}

const cleanGroup = (group: string): void => {
  realPueue(["clean", "--group", group])
  realPueue(["group", "remove", group])
}

const waitFor = async (group: string, id: number, alive: boolean): Promise<string> => {
  const deadline = Date.now() + 15_000
  let status = "gone"
  while (Date.now() < deadline) {
    status = statusOf(group).find((task) => task.id === id)?.status ?? "gone"
    if (alive ? status === "Running" : status !== "Running" && status !== "Queued") {
      return status
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return status
}

describe("the heavy hold", () => {
  test.skipIf(noPueue())(
    skipReason("needs pueue to hold the queue slot", "a held slot runs the use between acquire and release"),
    async () => {
      await withFakePueue(async (log) => {
        const seen = await Effect.runPromise(
          withHeavyHold("heavy", () => Effect.succeed("used")).pipe(Effect.provide(BunServices.layer))
        )
        expect(seen).toBe("used")
        const verbs = await holdVerbs(log)
        expect(verbs).toEqual(["group", "group", "status", "add", "wait", "kill", "wait", "remove"])
      })
    }
  )

  test.skipIf(noPueue())(
    skipReason("needs pueue to hold the queue slot", "a hold task leaves Running once its owner dies"),
    async () => {
      const group = "orc-hold-test"
      try {
        realPueue(["group", "add", group])
        const owner = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore", env: realEnv() })
        const added = Bun.spawnSync(["pueue", "add", "--group", group, "--label", heavyHoldLabel, "--print-task-id", "--escape", "--",
          "sh", "-c", 'while kill -0 "$1" 2>/dev/null; do sleep 5; done', "orc-heavy-exit", String(owner.pid)],
          { stdout: "pipe", stderr: "ignore", env: realEnv() })
        const id = Number(added.stdout.toString().trim())
        expect(Number.isInteger(id)).toBe(true)
        expect(await waitFor(group, id, true)).toBe("Running")
        owner.kill(9)
        expect(["Done", "gone"]).toContain(await waitFor(group, id, false))
      } finally {
        cleanGroup(group)
      }
    },
    60_000
  )
})
