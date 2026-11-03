import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { type Machine, type Project, readProjects } from "../../../packages/run/src/dispatch/config"

const machines: ReadonlyArray<Machine> = [{ name: "mac", slots: 1, start: ["true"] }, { name: "linux", slots: 2, start: ["true"] }]

const projects: ReadonlyArray<Project> = [{ name: "orc", checkouts: { mac: "/Users/a/orc", linux: "/home/a/orc" } }]

const withBacklog = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orc-projects-")))
  try {
    await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const readProjectList = async (root: string, list: ReadonlyArray<object>): Promise<ReadonlyArray<Project> | string> => {
  const file = join(root, "projects.json")
  await writeFile(file, JSON.stringify({ projects: list }))
  return Effect.runPromise(readProjects(file, machines).pipe(
    Effect.catchTag("ConfigError", (error) => Effect.succeed(error.detail)),
    Effect.provide(BunServices.layer)
  ))
}

describe("readProjects", () => {
  test("resolves a relative instructions path against the projects file's folder instead of the working folder", async () => {
    await withBacklog(async (root) => {
      await mkdir(join(root, "notes"))
      await writeFile(join(root, "notes", "orc.md"), "Report in English.\n")
      expect(await readProjectList(root, [{ ...projects[0], instructions: "notes/orc.md" }])).toEqual([{ ...projects[0], instructions: join(root, "notes", "orc.md") }])
    })
  })
  test("keeps an absolute instructions path as named", async () => {
    await withBacklog(async (root) => {
      const file = join(root, "orc-instructions.md")
      await writeFile(file, "Report in English.\n")
      expect(await readProjectList(root, [{ ...projects[0], instructions: file }])).toEqual([{ ...projects[0], instructions: file }])
    })
  })
  test("refuses an instructions file that is missing instead of reading the project without it", async () => {
    await withBacklog(async (root) => {
      expect(await readProjectList(root, [{ ...projects[0], instructions: "gone.md" }])).toBe("the project orc names the instructions file " + join(root, "gone.md") + ", which is no file")
    })
  })
  test("refuses instructions that name a folder instead of a file", async () => {
    await withBacklog(async (root) => {
      await mkdir(join(root, "notes"))
      expect(await readProjectList(root, [{ ...projects[0], instructions: "notes" }])).toBe("the project orc names the instructions file " + join(root, "notes") + ", which is no file")
    })
  })
  test("refuses instructions that are no string instead of dropping them", async () => {
    await withBacklog(async (root) => {
      expect(await readProjectList(root, [{ ...projects[0], instructions: 3 }])).toBe("the project orc names instructions 3, which is not a file path")
    })
  })
  test("reads a project without the key unchanged, with no instructions field", async () => {
    await withBacklog(async (root) => {
      expect(await readProjectList(root, projects)).toEqual(projects)
    })
  })
})
