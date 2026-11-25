import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import runPackage from "../../../packages/run/package.json" with { type: "json" }
import { binPath, type Fixture, runOrc, sessionFor, withFixture } from "../chat-helpers"

const peer = "dispatch-peer"
const newest = "99.0.0"
const beatRecord = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({
  schema: Schema.Literal("orc.beat.v1"),
  actions: Schema.Array(Schema.Record(Schema.String, Schema.Unknown))
})))
const attentionRecord = Schema.decodeSync(Schema.fromJsonString(Schema.Struct({
  schema: Schema.Literal("orc.attention.v1"),
  items: Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.String, text: Schema.String, owner: Schema.String }))
})))

const orc = async (fixture: Fixture, ...args: ReadonlyArray<string>): Promise<string> => {
  const result = await runOrc(fixture, args)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout)
  }
  return result.stdout
}

const withDispatch = async (use: (fixture: Fixture, remoteHome: string) => Promise<void>): Promise<void> => {
  const registry = Bun.serve({
    port: 0,
    fetch: (request) => new URL(request.url).pathname === "/@avi2dg/orc/latest"
      ? Response.json({ version: newest })
      : new Response(null, { status: 404 })
  })
  try {
    await withFixture(null, 0, async (fixture) => {
      const remoteHome = join(fixture.dir, "peer")
      await mkdir(remoteHome)
      await writeFile(join(fixture.home, "backlog", "dispatch.json"), JSON.stringify({
        machines: [{
          name: peer, slots: 1,
          start: ["orc", "runner", "start", "--", "env", "ORC_HOME=" + remoteHome, process.execPath, binPath]
        }],
        quota: { provider: "sample", command: ["true"], accounts: [{ name: "sample", kind: "none" }], floorPercent: 15 }
      }))
      await writeFile(join(fixture.home, "backlog", "projects.json"), JSON.stringify({ projects: [] }))
      await use({
        ...fixture,
        env: { ...fixture.env, ORC_BEAT_UPDATE: "on", npm_config_registry: registry.url.href }
      }, remoteHome)
    })
  } finally {
    await registry.stop(true)
  }
}

const installer = (home: string, shell: string): Promise<void> =>
  writeFile(join(home, "config.json"), JSON.stringify({
    providers: [], update: { command: ["sh", "-c", shell, "install", "{version}", join(home, "attempts")] }
  }))

const recordAttempt = 'printf "%s\\n" "$1" >> "$2"'
const refusedAttempt = recordAttempt + '; printf "%s\\n" "permission denied" >&2; exit 7'

const updatesInBeat = async (fixture: Fixture) =>
  beatRecord(await orc(fixture, "beat", "--json")).actions.filter((action) => action.kind === "update")
const attention = async (fixture: Fixture) => attentionRecord(await orc(fixture, "attention", "--json"))
const expireCheck = (fixture: Fixture) => writeFile(join(fixture.home, "beat-update-checked"), "2000-01-01T00:00:00.000Z")
const leaveClaim = (file: string, pid: number, at: number) => writeFile(file, JSON.stringify({ pid, at, token: "left-behind" }))
const exitedPid = async (): Promise<number> => {
  const exited = Bun.spawn(["true"])
  await exited.exited
  return exited.pid
}

test("overlapping beats check each dispatch machine once, post only the moved version, and keep the remote installer error", async () => {
  await withDispatch(async (fixture, remoteHome) => {
    await installer(fixture.home, recordAttempt)
    await installer(remoteHome, refusedAttempt)
    const reports = await Promise.all([updatesInBeat(fixture), updatesInBeat(fixture)])
    const updates = reports.flat()
    expect(updates).toMatchObject([
      { kind: "update", machine: "a dispatch machine", result: { outcome: "installed", running: runPackage.version, found: newest } },
      { kind: "update", machine: peer, result: { outcome: "failed", found: newest, output: "permission denied" } }
    ])
    expect(await updatesInBeat(fixture)).toEqual([])
    expect(await readFile(join(fixture.home, "attempts"), "utf8")).toBe(newest + "\n")
    expect(await readFile(join(remoteHome, "attempts"), "utf8")).toBe(newest + "\n")

    const chat = sessionFor(fixture)
    await chat.postClosed()
    await chat.postClosed()
    expect(chat.posted).toEqual(["orc on a dispatch machine moved from " + runPackage.version + " to " + newest])
    const { items } = await attention(fixture)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: "update-failed", owner: "decider" })
    expect(items[0]?.text).toContain(peer)
    expect(items[0]?.text).toContain("permission denied")
  })
}, 60_000)

test("an hourly retry refreshes one failure without reopening it when an answer wins the race", async () => {
  await withDispatch(async (fixture, remoteHome) => {
    await installer(fixture.home, recordAttempt)
    await installer(remoteHome, refusedAttempt)
    await updatesInBeat(fixture)
    const first = (await attention(fixture)).items.at(0)
    if (first === undefined) {
      throw new Error("the first update failed without an attention item")
    }
    const expire = () => expireCheck(fixture)
    await installer(remoteHome, recordAttempt + '; printf "%s\\n" "disk full" >&2; exit 8')
    await expire()
    await updatesInBeat(fixture)
    const refreshed = (await attention(fixture)).items
    expect(refreshed).toHaveLength(1)
    expect(refreshed[0]).toMatchObject({ id: first.id, text: expect.stringContaining("disk full") })
    await installer(remoteHome, recordAttempt + '; printf "%s\\n" "read-only volume" >&2; exit 9')
    await expire()
    await Promise.all([updatesInBeat(fixture), orc(fixture, "attention", "answer", first.id, "acknowledged")])
    expect((await attention(fixture)).items).toEqual([])
    expect(JSON.parse(await readFile(join(fixture.home, "backlog", "attention", first.id + ".json"), "utf8"))).toMatchObject({
      state: { kind: "closed", answer: { words: "acknowledged" } }
    })
  })
}, 60_000)

test("a successful check ends an answered failure, so the same failure afterwards opens a new item instead of staying silent", async () => {
  await withDispatch(async (fixture, remoteHome) => {
    await installer(fixture.home, recordAttempt)
    await installer(remoteHome, refusedAttempt)
    await updatesInBeat(fixture)
    const first = (await attention(fixture)).items.at(0)
    if (first === undefined) {
      throw new Error("the first update failed without an attention item")
    }
    await orc(fixture, "attention", "answer", first.id, "acknowledged")
    await expireCheck(fixture)
    expect(await updatesInBeat(fixture)).toMatchObject([{ machine: "a dispatch machine" }, { machine: peer, result: { outcome: "failed" } }])
    expect((await attention(fixture)).items).toEqual([])

    await installer(remoteHome, recordAttempt)
    await expireCheck(fixture)
    expect(await updatesInBeat(fixture)).toMatchObject([{ machine: "a dispatch machine" }, { machine: peer, result: { outcome: "installed" } }])
    expect((await attention(fixture)).items).toEqual([])

    await installer(remoteHome, refusedAttempt)
    await expireCheck(fixture)
    await updatesInBeat(fixture)
    const { items } = await attention(fixture)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: "update-failed", owner: "decider", text: expect.stringContaining("permission denied") })
    expect(items[0]?.id).not.toBe(first.id)
    expect(JSON.parse(await readFile(join(fixture.home, "backlog", "attention", first.id + ".json"), "utf8"))).toMatchObject({
      state: { kind: "closed", answer: { words: "acknowledged" } }
    })
  })
}, 60_000)

test("claim files left by an exited or long-gone owner do not stop the hourly check or the item refresh, while a live claim still does", async () => {
  await withDispatch(async (fixture, remoteHome) => {
    await installer(fixture.home, recordAttempt)
    await installer(remoteHome, refusedAttempt)
    const hourClaim = join(fixture.home, "beat-update-checked.lock")
    await leaveClaim(hourClaim, process.pid, Date.now())
    expect(await updatesInBeat(fixture)).toEqual([])

    await leaveClaim(hourClaim, await exitedPid(), Date.now())
    expect(await updatesInBeat(fixture)).toHaveLength(2)
    const first = (await attention(fixture)).items.at(0)
    if (first === undefined) {
      throw new Error("the update failed without an attention item")
    }

    await leaveClaim(join(fixture.home, "backlog", "attention", "." + first.id + ".lock"), process.pid, Date.now() - 2 * 60 * 60 * 1000)
    await installer(remoteHome, recordAttempt + '; printf "%s\\n" "disk full" >&2; exit 8')
    await expireCheck(fixture)
    await updatesInBeat(fixture)
    expect((await attention(fixture)).items).toMatchObject([{ id: first.id, text: expect.stringContaining("disk full") }])
  })
}, 60_000)
