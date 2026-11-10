import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const beatTimeout = 120_000
const startWaitMillis = 10_000
const binPath = new URL("../../../packages/run/src/bin.ts", import.meta.url).pathname

interface Fixture {
  readonly dir: string
  readonly env: Record<string, string>
  readonly startLog: string
}

const runOrc = async (fixture: Fixture, args: ReadonlyArray<string>): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn([process.execPath, binPath, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: fixture.dir,
    env: { ...process.env, ...fixture.env }
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}

const orcOk = async (fixture: Fixture, args: ReadonlyArray<string>): Promise<string> => {
  const result = await runOrc(fixture, args)
  if (result.exitCode !== 0) {
    throw new Error("orc " + args.join(" ") + " exited " + result.exitCode + ": " + result.stderr)
  }
  return result.stdout
}

const refusal = async (fixture: Fixture, args: ReadonlyArray<string>): Promise<readonly [number, string]> => {
  const result = await runOrc(fixture, args)
  return [result.exitCode, result.stderr.split("\n")[0] ?? ""]
}

const withFixture = async (body: (fixture: Fixture) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-parent-e2e-"))
  try {
    const bin = join(dir, "bin")
    const backlog = join(dir, "home", "backlog")
    const startLog = join(dir, "starts.log")
    await mkdir(bin, { recursive: true })
    await mkdir(backlog, { recursive: true })
    const quota = { schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] }
    await writeFile(join(bin, "orc-quota"), "#!/bin/sh\ncat <<'J'\n" + JSON.stringify(quota) + "\nJ\n")
    await chmod(join(bin, "orc-quota"), 0o755)
    await writeFile(join(backlog, "dispatch.json"), JSON.stringify({
      machines: [{ name: "mac", slots: 4, start: ["sh", "-c", "echo \"$ORC_TASK_ID\" >> '" + startLog + "'"] }],
      quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: "/secrets/main-token" }], floorPercent: 15 }
    }))
    await writeFile(join(backlog, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: join(dir, "mac-orc") } }] }))
    await writeFile(join(dir, "parent.md"), "# Ship the whole feature\n\nDone when the feature works end to end.\n")
    await writeFile(join(dir, "child.md"), "# Ship one part\n")
    await writeFile(startLog, "")
    await body({ dir, env: { ORC_HOME: join(dir, "home"), PATH: bin + ":" + (process.env.PATH ?? "") }, startLog })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const startsAfter = async (fixture: Fixture, count: number): Promise<ReadonlyArray<string>> => {
  const deadline = Date.now() + startWaitMillis
  let lines: ReadonlyArray<string> = []
  while (lines.length < count && Date.now() < deadline) {
    await Bun.sleep(20)
    lines = (await readFile(fixture.startLog, "utf8")).split("\n").filter((line) => line !== "").sort()
  }
  return lines
}

const listLine = async (fixture: Fixture, id: string): Promise<string> =>
  (await orcOk(fixture, ["backlog"])).split("\n").find((line) => line.includes(id + " parent")) ?? ""

const addChild = (fixture: Fixture, more: ReadonlyArray<string> = []): Promise<string> =>
  orcOk(fixture, ["backlog", "add", "orc", "child.md", "--parent", "orc-1", ...more])

describe("orc backlog add --parent", () => {
  test("independent children start together and the parent waits for all of them instead of starting beside them", async () => {
    await withFixture(async (fixture) => {
      expect(await orcOk(fixture, ["backlog", "add", "orc", "parent.md", "--kind", "parent"])).toBe("added orc-1 for orc as a parent\n")
      expect(await orcOk(fixture, ["beat"])).toContain("waits orc-1: waits for its first child")
      expect(await addChild(fixture)).toBe("added orc-2 for orc as a child of orc-1\n")
      await addChild(fixture)
      await addChild(fixture, ["--depends-on", "orc-2"])
      const first = await orcOk(fixture, ["beat"])
      expect(first).toContain("waits orc-1: waits on its children, 0 of 3 done")
      expect(first).toContain("waits orc-4: waits on orc-2")
      expect(await startsAfter(fixture, 2)).toEqual(["orc-2", "orc-3"])
      expect(await listLine(fixture, "orc-1")).toContain("orc-1 parent orc 0 of 3 done")
      await orcOk(fixture, ["backlog", "close", "orc-2", "done"])
      await orcOk(fixture, ["backlog", "close", "orc-3", "done"])
      expect(await orcOk(fixture, ["beat"])).toContain("waits orc-1: waits on its children, 2 of 3 done")
      expect(await startsAfter(fixture, 3)).toEqual(["orc-2", "orc-3", "orc-4"])
      await orcOk(fixture, ["backlog", "close", "orc-4", "done"])
      await orcOk(fixture, ["beat"])
      expect(await startsAfter(fixture, 4)).toEqual(["orc-1", "orc-2", "orc-3", "orc-4"])
      expect(await listLine(fixture, "orc-1")).toContain("orc-1 parent orc 3 of 3 done")
    })
  }, beatTimeout)

  test("a failed child keeps the parent waiting instead of counting as done", async () => {
    await withFixture(async (fixture) => {
      await orcOk(fixture, ["backlog", "add", "orc", "parent.md", "--kind", "parent"])
      await addChild(fixture)
      await orcOk(fixture, ["beat"])
      await orcOk(fixture, ["backlog", "close", "orc-2", "failed", "the tests broke"])
      expect(await orcOk(fixture, ["beat"])).toContain("waits orc-1: waits on its children, 0 of 1 done")
    })
  }, beatTimeout)

  test("refuses a missing parent, a parent that is not a parent task, a second parent and a parent of a parent instead of linking them", async () => {
    await withFixture(async (fixture) => {
      expect(await refusal(fixture, ["backlog", "add", "orc", "child.md", "--parent", "orc-9"])).toEqual([1, "orc: the backlog holds no task orc-9"])
      await orcOk(fixture, ["backlog", "add", "orc", "child.md"])
      expect(await refusal(fixture, ["backlog", "add", "orc", "child.md", "--parent", "orc-1"])).toEqual([1, "orc: orc-1 is a ship task, and only a parent task takes children"])
      expect((await refusal(fixture, ["backlog", "add", "orc", "child.md", "--parent", "orc-1", "--parent", "orc-2"]))[1]).toBe("orc backlog add takes one --parent")
      expect((await refusal(fixture, ["backlog", "add", "orc", "parent.md", "--kind", "parent", "--parent", "orc-1"]))[1]).toBe("orc backlog add takes --parent only for a child, and a parent task has no parent")
      expect((await refusal(fixture, ["backlog", "add", "orc", "child.md", "--parent", "next"]))[1]).toBe("orc backlog add takes a task id after --parent, got \"next\"")
    })
  }, beatTimeout)

  test("refuses a child that waits on a task waiting on the parent instead of holding both forever", async () => {
    await withFixture(async (fixture) => {
      await orcOk(fixture, ["backlog", "add", "orc", "parent.md", "--kind", "parent"])
      await orcOk(fixture, ["backlog", "add", "orc", "child.md", "--depends-on", "orc-1"])
      expect(await refusal(fixture, ["backlog", "add", "orc", "child.md", "--parent", "orc-1", "--depends-on", "orc-2"]))
        .toEqual([1, "orc: orc-2 waits on orc-1, which waits on its children, so a child of orc-1 cannot wait on it"])
    })
  }, beatTimeout)
})
