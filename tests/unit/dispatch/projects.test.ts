import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { type Machine, type Project, readProjects } from "../../../packages/run/src/shared/config/dispatch-config"

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
  test("reads each upstream issue and pull request URL into its owner, repository and number instead of keeping only the text", async () => {
    await withBacklog(async (root) => {
      const upstream = ["https://github.com/badlogic/pi-mono/issues/412", "https://github.com/kunchenguid/no-mistakes/pull/88"]
      expect(await readProjectList(root, [{ ...projects[0], upstream }])).toEqual([{
        ...projects[0],
        upstream: [
          { url: upstream[0], owner: "badlogic", repo: "pi-mono", number: 412 },
          { url: upstream[1], owner: "kunchenguid", repo: "no-mistakes", number: 88 }
        ]
      }])
    })
  })
  test("refuses upstream that is no list instead of watching the one URL", async () => {
    await withBacklog(async (root) => {
      expect(await readProjectList(root, [{ ...projects[0], upstream: "https://github.com/acme/orc/pull/7" }])).toBe(
        "the project orc names upstream \"https://github.com/acme/orc/pull/7\", which is not a list of GitHub issue or pull request URLs"
      )
    })
  })
  test.each([
    ["a repository page", "https://github.com/acme/orc"],
    ["a comment anchor", "https://github.com/acme/orc/issues/3#issuecomment-1"],
    ["a GitLab merge request", "https://gitlab.com/acme/orc/-/merge_requests/3"],
    ["a plain http URL", "http://github.com/acme/orc/pull/3"],
    ["a number", 3]
  ])("refuses an upstream entry that is %s instead of skipping it", async (_, entry) => {
    await withBacklog(async (root) => {
      expect(await readProjectList(root, [{ ...projects[0], upstream: [entry] }])).toBe(
        "the project orc names the upstream entry " + JSON.stringify(entry) + ", which is not a GitHub issue or pull request URL such as https://github.com/owner/repo/pull/12"
      )
    })
  })
  test("refuses an upstream URL named twice instead of watching it once", async () => {
    await withBacklog(async (root) => {
      const url = "https://github.com/acme/orc/pull/7"
      expect(await readProjectList(root, [{ ...projects[0], upstream: [url, url] }])).toBe("the project orc names the upstream URL " + url + " twice")
    })
  })
  test.each([
    ["another case", "https://github.com/Acme/Orc/pull/7"],
    ["its issue URL", "https://github.com/acme/orc/issues/7"]
  ])("refuses a contribution named again in %s instead of watching it twice", async (_, again) => {
    await withBacklog(async (root) => {
      expect(await readProjectList(root, [{ ...projects[0], upstream: ["https://github.com/acme/orc/pull/7", again] }])).toBe("the project orc names the upstream URL " + again + " twice")
    })
  })
  test("reads a project without the key unchanged, with no instructions or upstream field", async () => {
    await withBacklog(async (root) => {
      expect(await readProjectList(root, projects)).toEqual(projects)
      expect((await readProjectList(root, projects))[0]).not.toHaveProperty("upstream")
    })
  })
})
