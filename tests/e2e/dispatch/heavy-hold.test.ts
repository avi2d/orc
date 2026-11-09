import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"
import { heavyHoldLabel } from "../../../packages/run/src/dispatch/heavy-hold"

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

const waitForHold = async (group: string): Promise<number> => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const held = statusOf(group).find((task) => task.label === heavyHoldLabel && task.status === "Running")
    if (held !== undefined) {
      return held.id
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error("no running hold task in " + group)
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
    skipReason("needs pueue to hold the queue slot", "a hold task leaves Running once its owner dies"),
    async () => {
      const group = "orc-hold-test"
      try {
        const child = Bun.spawn(["bun", join(import.meta.dir, "heavy-hold-child.ts"), group], {
          stdout: "ignore",
          stderr: "ignore",
          env: realEnv()
        })
        const id = await waitForHold(group)
        child.kill(9)
        expect(["Done", "gone"]).toContain(await waitFor(group, id, false))
      } finally {
        cleanGroup(group)
      }
    },
    60_000
  )
})
