import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { binPath } from "./dispatch-helpers"

const resetsAt = "2099-01-02T00:00:00.000Z"
const observedAt = "2026-01-01T00:00:00.000Z"
const floorPercent = 50

const freshAccount = (id: string, ...percents: ReadonlyArray<number>) => ({
  id,
  provider: "claude",
  observation: {
    status: "fresh",
    observedAt,
    source: "provider",
    validUntil: resetsAt,
    windows: percents.map((percentLeft, index) => ({ id: "window-" + index, scope: "all", percentLeft, resetsAt }))
  }
})

const main = freshAccount("main", 55, 41)
const second = freshAccount("second", 74)
const snapshot = (accounts: ReadonlyArray<ReturnType<typeof freshAccount>>) => ({ version: "subquo.v1", writtenAt: observedAt, accounts })

const readQuota = async (
  names: ReadonlyArray<string>,
  source: { readonly command: "subquo" | "orc-quota"; readonly document?: object }
): Promise<unknown> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-quota-e2e-"))
  try {
    const bin = join(dir, "bin")
    const backlog = join(dir, "backlog")
    await mkdir(bin)
    await mkdir(backlog)
    const args = source.command === "subquo" ? ["read", "--json"] : ["--json"]
    if (source.document !== undefined) {
      await writeFile(join(bin, source.command), [
        "#!/bin/sh",
        '[ "$*" = "' + args.join(" ") + '" ] || exit 3',
        "printf '%s\\n' '" + JSON.stringify(source.document) + "'",
        ""
      ].join("\n"), { mode: 0o755 })
    }
    await writeFile(join(backlog, "dispatch.json"), JSON.stringify({
      machines: [],
      quota: {
        provider: "anthropic",
        command: [source.document === undefined ? source.command : join(bin, source.command), ...args],
        accounts: names.map((name) => ({ name, tokenFile: "/unused/" + name })),
        floorPercent
      }
    }))
    const run = Bun.spawnSync([process.execPath, binPath, "quota", "--json"], {
      cwd: dir,
      env: { ORC_HOME: dir, HOME: dir, PATH: bin },
      timeout: 10_000
    })
    expect(run.stderr.toString()).toBe("")
    expect(run.exitCode).toBe(0)
    const reading: unknown = JSON.parse(run.stdout.toString())
    return reading
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("quota prints both configured subquo accounts in config order instead of choosing only the first snapshot account", async () => {
  expect(await readQuota(["main", "second"], { command: "subquo", document: snapshot([second, main]) })).toEqual({
    kind: "read",
    floorPercent,
    accounts: [
      { account: "main", kind: "usable", remainingPercent: 41, resetsAt },
      { account: "second", kind: "usable", remainingPercent: 74, resetsAt }
    ],
    pick: "second"
  })
})

test("quota prints one configured subquo account without picking it below the floor", async () => {
  expect(await readQuota(["main"], { command: "subquo", document: snapshot([main]) })).toEqual({
    kind: "read",
    floorPercent,
    accounts: [{ account: "main", kind: "usable", remainingPercent: 41, resetsAt }],
    pick: null
  })
})

test("quota reports account-missing instead of returning a partial subquo reading", async () => {
  expect(await readQuota(["main", "second"], { command: "subquo", document: snapshot([main]) })).toEqual({
    kind: "unread",
    cause: "account-missing",
    reason: "the subquo snapshot names no account second, so its account list and the quota accounts differ"
  })
})

test("quota reports schema instead of treating an unknown subquo version as a reading", async () => {
  expect(await readQuota(["main"], { command: "subquo", document: { ...snapshot([main]), version: "subquo.v2" } })).toEqual({
    kind: "unread",
    cause: "schema",
    reason: 'the quota command printed no subquo.v1 snapshot: Expected "subquo.v1"\n  at ["version"]'
  })
})

test("quota reports command-missing instead of exiting without JSON when orc-quota is not on PATH", async () => {
  expect(await readQuota(["main"], { command: "orc-quota" })).toEqual({
    kind: "unread",
    cause: "command-missing",
    reason: "the quota command orc-quota is not installed on PATH"
  })
})

test("quota runs the subquo installed with Orc instead of reporting command-missing when subquo is not on PATH", async () => {
  expect(await readQuota(["main"], { command: "subquo" })).toEqual({
    kind: "unread",
    cause: "exit",
    reason: "the quota command subquo exited 1"
  })
})

test("quota runs the configured orc-quota command instead of requiring a subquo snapshot", async () => {
  expect(await readQuota(["main", "second"], {
    command: "orc-quota",
    document: { schema: "orc.quota.v1", accounts: [{ name: "main", unusable: "the login expired" }, { name: "second", remainingPercent: 80 }] }
  })).toEqual({
    kind: "read",
    floorPercent,
    accounts: [
      { account: "main", kind: "unusable", reason: "the login expired" },
      { account: "second", kind: "usable", remainingPercent: 80 }
    ],
    pick: "second"
  })
})
