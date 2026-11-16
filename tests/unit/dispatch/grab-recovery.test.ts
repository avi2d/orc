import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { addTask, listTasks } from "../../../packages/run/src/entities/backlog/index"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const spec = { title: "Fix the thing", project: "orc", kind: "ship" as const, internal: false, machine: null, parent: null, split: null, dependsOn: [], priority: 0 as const, created: "2026-10-27T10:00:00.000Z", body: "# Fix the thing\n" }

const withRoot = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "orc-grab-"))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// Linux caps pids at 2^22 and macOS at 99999, so no process ever holds this one.
const deadPid = 2 ** 31 - 1

const grabbedName = (id: string, pid: number): string => "." + id + ".grab-" + pid + "-" + crypto.randomUUID() + ".tmp"

describe("a grab left by a killed process", () => {
  test("puts the task back in its folder with its text unchanged before the listing reads it", async () => {
    await withRoot(async (root) => {
      await run(addTask(root, spec))
      const file = join(root, "new", "orc-1.md")
      const text = await readFile(file, "utf8")
      await rename(file, join(root, "new", grabbedName("orc-1", deadPid)))
      const tasks = await run(listTasks(root))
      expect(tasks.map((task) => task.spec.id)).toEqual(["orc-1"])
      expect(await readFile(file, "utf8")).toBe(text)
      expect(await readdir(join(root, "new"))).toEqual(["orc-1.md"])
    })
  })

  test("keeps the finished result and removes the grab when the killed process already wrote it", async () => {
    await withRoot(async (root) => {
      await run(addTask(root, spec))
      const file = join(root, "new", "orc-1.md")
      const rewritten = (await readFile(file, "utf8")).replaceAll("Fix the thing", "Fix the other thing")
      await rename(file, join(root, "new", grabbedName("orc-1", deadPid)))
      await writeFile(file, rewritten)
      const tasks = await run(listTasks(root))
      expect(tasks.map((task) => task.spec.title)).toEqual(["Fix the other thing"])
      expect(await readdir(join(root, "new"))).toEqual(["orc-1.md"])
      expect(await readFile(file, "utf8")).toBe(rewritten)
    })
  })

  test("leaves a grab that a live process still holds", async () => {
    await withRoot(async (root) => {
      await run(addTask(root, spec))
      const grabbed = grabbedName("orc-1", process.pid)
      await rename(join(root, "new", "orc-1.md"), join(root, "new", grabbed))
      expect(await run(listTasks(root))).toEqual([])
      expect(await readdir(join(root, "new"))).toEqual([grabbed])
    })
  })
})
