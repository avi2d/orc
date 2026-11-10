import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const beatTimeout = 120_000
const startWaitMillis = 10_000
const binPath = new URL("../../../packages/run/src/bin.ts", import.meta.url).pathname

interface Fixture {
  readonly dir: string
  readonly env: Record<string, string>
  readonly startLog: string
  readonly piLog: string
  readonly reply: (text: string, exitCode?: number) => Promise<void>
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

const withFixture = async (planner: boolean, body: (fixture: Fixture) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-intake-split-e2e-"))
  try {
    const bin = join(dir, "bin")
    const home = join(dir, "home")
    const backlog = join(home, "backlog")
    const startLog = join(dir, "starts.log")
    const piLog = join(dir, "pi.log")
    const replyFile = join(dir, "reply.txt")
    const exitFile = join(dir, "exit.txt")
    await mkdir(bin, { recursive: true })
    await mkdir(backlog, { recursive: true })
    const quota = { schema: "orc.quota.v1", accounts: [{ name: "main", remainingPercent: 80 }] }
    await writeFile(join(bin, "orc-quota"), "#!/bin/sh\ncat <<'J'\n" + JSON.stringify(quota) + "\nJ\n")
    await writeFile(
      join(bin, "pi"),
      "#!/bin/sh\nfor arg in \"$@\"; do printf '%s\\n' \"$arg\" >> '" + piLog + "'; done\ncat '" + replyFile + "'\necho 'the planner said so' >&2\nexit \"$(cat '" + exitFile + "')\"\n"
    )
    await chmod(join(bin, "orc-quota"), 0o755)
    await chmod(join(bin, "pi"), 0o755)
    if (planner) {
      await writeFile(join(home, "config.json"), JSON.stringify({ providers: [], models: { planner: "acme/plan-1" } }))
    }
    await writeFile(join(backlog, "dispatch.json"), JSON.stringify({
      machines: [{ name: "mac", slots: 4, start: ["sh", "-c", "echo \"$ORC_TASK_ID\" >> '" + startLog + "'"] }],
      quota: { provider: "acme", command: ["orc-quota"], accounts: [{ name: "main", tokenFile: "/secrets/main-token" }], floorPercent: 15 }
    }))
    await writeFile(join(backlog, "projects.json"), JSON.stringify({ projects: [{ name: "orc", checkouts: { mac: join(dir, "mac-orc") } }] }))
    await writeFile(join(dir, "request.md"), "# Ship task splitting\n\nSplit big requests and show the plan.\n")
    await writeFile(startLog, "")
    await writeFile(piLog, "")
    await writeFile(replyFile, "")
    await writeFile(exitFile, "0")
    const reply = async (text: string, exitCode = 0): Promise<void> => {
      await writeFile(replyFile, text)
      await writeFile(exitFile, String(exitCode))
    }
    await body({ dir, env: { ORC_HOME: home, PATH: bin + ":" + (process.env.PATH ?? "") }, startLog, piLog, reply })
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

const threeSlicePlan = {
  schema: "orc.split.v1",
  plan: "split",
  reason: "it touches the record, the intake and the listing",
  done: ["a big request lands as a parent with children", "the plan shows on the parent"],
  children: [
    { title: "Record the split", body: "Add the split mark to the task record.", after: [] },
    { title: "Show the plan", body: "Print the children of a parent.", after: [] },
    { title: "Plan at intake", body: "Split an over-budget request when it is added.", after: [1, 2] }
  ]
}

const threeSlices = JSON.stringify(threeSlicePlan)

const added = (fixture: Fixture, more: ReadonlyArray<string> = []): Promise<string> =>
  orcOk(fixture, ["backlog", "add", "orc", "request.md", ...more])

describe("orc backlog add with a planner model", () => {
  test("an over-budget request lands as a parent whose independent children start together instead of as one big task", async () => {
    await withFixture(true, async (fixture) => {
      await fixture.reply("Here is the plan.\n" + threeSlices + "\n")
      expect(await added(fixture)).toBe([
        "added orc-1 for orc as a parent, split at intake: it touches the record, the intake and the listing",
        "added orc-2 for orc as a child of orc-1",
        "added orc-3 for orc as a child of orc-1",
        "added orc-4 for orc as a child of orc-1",
        ""
      ].join("\n"))
      const asked = await readFile(fixture.piLog, "utf8")
      expect(asked).toContain("acme/plan-1")
      expect(asked).toContain("about 300 changed lines or one area")
      expect(asked).toContain("Split big requests and show the plan.")
      const first = await orcOk(fixture, ["beat"])
      expect(first).toContain("waits orc-1: waits on its children, 0 of 3 done")
      expect(first).toContain("waits orc-4: waits on orc-2")
      expect(await startsAfter(fixture, 2)).toEqual(["orc-2", "orc-3"])
      expect((await orcOk(fixture, ["backlog"])).split("\n").filter((line) => line.includes(" parent "))).toEqual([
        expect.stringContaining("orc-1 parent orc 0 of 3 done")
      ])
      const parent = await readFile(join(fixture.dir, "home", "backlog", "new", "orc-1.md"), "utf8")
      expect(parent).toContain("- the plan shows on the parent")
      const events = await readdir(join(fixture.dir, "home", "backlog", "events"))
      expect(events).toContain("orc-1.split.json")
    })
  }, beatTimeout)

  test("the plan on the parent lists each child with its state, and a dropped child leaves the count instead of holding the parent", async () => {
    await withFixture(true, async (fixture) => {
      await fixture.reply(threeSlices)
      await added(fixture)
      expect(await orcOk(fixture, ["backlog", "plan", "orc-1"])).toBe([
        "orc-1 parent orc 0 of 3 done Ship task splitting",
        "split at intake: it touches the record, the intake and the listing",
        "orc-2 new Record the split",
        "orc-3 new Show the plan",
        "orc-4 new waits orc-2,orc-3 Plan at intake",
        ""
      ].join("\n"))
      expect(await refusal(fixture, ["backlog", "plan", "orc-1", "--drop", "orc-3"]))
        .toEqual([1, "orc: orc-4 waits on orc-3, so change that with orc backlog depend first"])
      await orcOk(fixture, ["backlog", "depend", "orc-4", "--on", "orc-2"])
      expect(await orcOk(fixture, ["backlog", "plan", "orc-1", "--drop", "orc-3"]))
        .toBe("dropped orc-3 from the plan of orc-1, which now waits on 2 children, 0 of them done\n")
      expect(await orcOk(fixture, ["backlog", "plan", "orc-1"])).toStartWith("orc-1 parent orc 0 of 2 done")
      await orcOk(fixture, ["beat"])
      expect(await startsAfter(fixture, 1)).toEqual(["orc-2"])
      expect((await orcOk(fixture, ["backlog", "plan", "orc-1"])).split("\n").slice(2, 4)).toEqual(["orc-2 started on mac Record the split", "orc-4 new waits orc-2 Plan at intake"])
      expect(await refusal(fixture, ["backlog", "plan", "orc-1", "--drop", "orc-2"])).toEqual([1, "orc: orc-2 is started, and only a new child leaves the plan"])
      expect(await refusal(fixture, ["backlog", "plan", "orc-2"])).toEqual([1, "orc: orc-2 is a ship task, and only a parent task has a plan"])
    })
  }, beatTimeout)

  test("a request that fits the budget stays one task instead of becoming a parent", async () => {
    await withFixture(true, async (fixture) => {
      await fixture.reply(JSON.stringify({ schema: "orc.split.v1", plan: "whole", reason: "one small change in one area" }))
      expect(await added(fixture)).toBe("added orc-1 for orc\nplanned as one task: one small change in one area\n")
    })
  }, beatTimeout)

  test("a planner that fails or prints no plan leaves the request as one task instead of refusing it", async () => {
    await withFixture(true, async (fixture) => {
      await fixture.reply("", 3)
      expect(await added(fixture)).toBe("added orc-1 for orc\nnot planned, so it runs as one task: the planner on acme/plan-1 exited 3: the planner said so\n")
      await fixture.reply("I would split this in two.")
      expect(await added(fixture)).toBe("added orc-2 for orc\nnot planned, so it runs as one task: the planner on acme/plan-1 printed no orc.split.v1 document\n")
      await fixture.reply(JSON.stringify({ ...threeSlicePlan, children: [{ title: "A", body: "a", after: [2] }, { title: "B", body: "b", after: [] }] }))
      expect(await added(fixture)).toBe(
        "added orc-3 for orc\nnot planned, so it runs as one task: the planner on acme/plan-1 printed a split where child 1 waits on child 2, and a child waits only on a child before it\n"
      )
    })
  }, beatTimeout)

  test("a scout, a parent, a child and a request with no planner model skip the planner instead of asking it", async () => {
    await withFixture(true, async (fixture) => {
      await fixture.reply(threeSlices)
      expect(await added(fixture, ["--kind", "scout"])).toBe("added orc-1 for orc as a scout\n")
      expect(await added(fixture, ["--kind", "parent"])).toBe("added orc-2 for orc as a parent\n")
      expect(await added(fixture, ["--parent", "orc-2"])).toBe("added orc-3 for orc as a child of orc-2\n")
      expect(await readFile(fixture.piLog, "utf8")).toBe("")
    })
    await withFixture(false, async (fixture) => {
      await fixture.reply(threeSlices)
      expect(await added(fixture)).toBe("added orc-1 for orc\n")
      expect(await readFile(fixture.piLog, "utf8")).toBe("")
    })
  }, beatTimeout)
})
