import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { runUpdate } from "../../packages/run/src/features/updating-orc/index"

const root = mkdtempSync(join(tmpdir(), "orc-update-compiled-"))

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("compiled launcher updates", () => {
  const compiledMachine = (name: string) => {
    const home = join(root, name)
    const directory = join(home, ".local/share/orc")
    const running = join(directory, "v1.0.0/orc")
    mkdirSync(join(directory, "v1.0.0"), { recursive: true })
    writeFileSync(running, "")
    writeFileSync(join(directory, "release"), "1.0.0\n")
    const bin = join(home, "bin")
    mkdirSync(bin)
    writeFileSync(join(bin, "bun"), "#!/bin/sh\nexit 97\n")
    chmodSync(join(bin, "bun"), 0o755)
    return { home, directory, running, bin }
  }

  const fakeCommands = {
    orc: '#!/bin/sh\nprintf "orc 99.0.0\\n"\n',
    "orc-dash": '#!/bin/sh\nprintf "orc-dash [options] <command>\\n"\n',
    "orc-dash-capture": '#!/bin/sh\nprintf "usage: orc-dash-capture (pi-call | claude-statusline | x)\\n"\n'
  }

  const writeCommands = (directory: string, overrides: Partial<typeof fakeCommands> = {}): void => {
    for (const [name, command] of Object.entries({ ...fakeCommands, ...overrides })) {
      writeFileSync(join(directory, name), command, { mode: 0o755 })
    }
  }

  const archiveName = "orc-99.0.0-" + process.platform + "-" + process.arch + ".tar.gz"

  type Assets = Map<string, Uint8Array<ArrayBuffer> | string>

  const releaseArchive = (dir: string, overrides: Partial<typeof fakeCommands> = {}): Uint8Array<ArrayBuffer> => {
    const stage = join(dir, "stage")
    mkdirSync(join(stage, "herdr-app"), { recursive: true })
    writeCommands(stage, overrides)
    writeFileSync(join(stage, "heavy-standin"), "")
    const archive = join(dir, archiveName)
    const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", stage, "orc", "orc-dash", "orc-dash-capture", "heavy-standin", "herdr-app"])
    expect(tar.exitCode).toBe(0)
    return readFileSync(archive)
  }

  const checksummedAssets = (archive: Uint8Array<ArrayBuffer>): Assets => {
    const digest = new Bun.CryptoHasher("sha256").update(archive).digest("hex")
    return new Map<string, Uint8Array<ArrayBuffer> | string>([
      ["/releases/v99.0.0/" + archiveName, archive],
      ["/releases/v99.0.0/" + archiveName + ".sha256", digest + "  " + archiveName + "\n"]
    ])
  }

  const updateCompiled = async (machine: ReturnType<typeof compiledMachine>, assets: Assets) => {
    const path = process.env.PATH
    process.env.PATH = machine.bin + ":" + (path ?? "")
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const { pathname } = new URL(request.url)
        const asset = assets.get(pathname)
        if (asset !== undefined) return new Response(asset)
        return pathname.endsWith("/@avi2dg/orc/latest") ? Response.json({ version: "99.0.0" }) : new Response(null, { status: 404 })
      }
    })
    try {
      return await Effect.runPromise(runUpdate({
        home: join(root, "no-config"),
        env: { HOME: machine.home, npm_config_registry: server.url.href },
        running: "1.0.0",
        main: "/$bunfs/root/orc",
        executable: machine.running,
        releases: new URL("releases", server.url).href
      }).pipe(Effect.provide(BunServices.layer)))
    } finally {
      await server.stop(true)
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
    }
  }

  test("a compiled launcher selects a prepared release despite changed dashboard help instead of running bun add -g", async () => {
    const machine = compiledMachine("compiled-prepared")
    mkdirSync(join(machine.directory, "v99.0.0"))
    writeCommands(join(machine.directory, "v99.0.0"))
    const result = await updateCompiled(machine, new Map())
    expect(result.outcome).toBe("installed")
    expect(readFileSync(join(machine.directory, "release"), "utf8")).toBe("99.0.0\n")
  })

  test("a compiled launcher accepts changed dashboard help in its platform archive instead of cloning a source checkout with bun", async () => {
    const machine = compiledMachine("compiled-download")
    const archive = releaseArchive(machine.home)
    const result = await updateCompiled(machine, checksummedAssets(archive))
    expect(result).toMatchObject({ outcome: "installed", running: "1.0.0", found: "99.0.0" })
    expect(readFileSync(join(machine.directory, "release"), "utf8")).toBe("99.0.0\n")
    expect(readFileSync(join(machine.directory, "v99.0.0/orc"), "utf8")).toBe(fakeCommands.orc)
    for (const name of ["orc-dash", "orc-dash-capture"]) {
      expect(Bun.spawnSync([join(machine.directory, "v99.0.0", name), "--help"]).exitCode).toBe(0)
    }
    expect(existsSync(join(machine.directory, "v99.0.0/herdr-app"))).toBe(true)
    expect(existsSync(join(machine.directory, "v99.0.0", archiveName))).toBe(false)
  })

  test.each(["orc-dash", "orc-dash-capture"])("a compiled launcher rejects a checksummed archive when %s exits nonzero", async (command) => {
    const machine = compiledMachine("compiled-failed-startup-" + command)
    const archive = releaseArchive(machine.home, { [command]: "#!/bin/sh\nexit 23\n" })
    const result = await updateCompiled(machine, checksummedAssets(archive))
    expect(result).toMatchObject({ outcome: "failed", detail: expect.stringContaining(command) })
    expect(readFileSync(join(machine.directory, "release"), "utf8")).toBe("1.0.0\n")
    expect(existsSync(join(machine.directory, "v99.0.0"))).toBe(false)
  })

  test.each(["orc-dash", "orc-dash-capture"])("a compiled launcher does not select a prepared release when %s exits nonzero", async (command) => {
    const machine = compiledMachine("compiled-prepared-failed-startup-" + command)
    const release = join(machine.directory, "v99.0.0")
    mkdirSync(release)
    writeCommands(release, { [command]: "#!/bin/sh\nexit 23\n" })
    const result = await updateCompiled(machine, new Map())
    expect(result).toMatchObject({ outcome: "failed", detail: expect.stringContaining(command) })
    expect(readFileSync(join(machine.directory, "release"), "utf8")).toBe("1.0.0\n")
  })

  test("a compiled launcher does not select an existing release that left out orc-dash-capture", async () => {
    const machine = compiledMachine("compiled-prepared-incomplete")
    const release = join(machine.directory, "v99.0.0")
    mkdirSync(release)
    writeCommands(release)
    rmSync(join(release, "orc-dash-capture"))
    const result = await updateCompiled(machine, new Map())
    expect(result).toMatchObject({ outcome: "failed", detail: expect.stringContaining("orc-dash-capture") })
    expect(readFileSync(join(machine.directory, "release"), "utf8")).toBe("1.0.0\n")
  })

  test("a compiled launcher keeps the old release when the archive fails its SHA-256 check", async () => {
    const machine = compiledMachine("compiled-checksum")
    const archive = releaseArchive(machine.home)
    const result = await updateCompiled(machine, new Map<string, Uint8Array<ArrayBuffer> | string>([
      ["/releases/v99.0.0/" + archiveName, archive],
      ["/releases/v99.0.0/" + archiveName + ".sha256", "0".repeat(64) + "  " + archiveName + "\n"]
    ]))
    expect(result.outcome).toBe("failed")
    expect(readFileSync(join(machine.directory, "release"), "utf8")).toBe("1.0.0\n")
    expect(existsSync(join(machine.directory, "v99.0.0"))).toBe(false)
  })

  test("a compiled launcher refuses an existing release folder that holds no orc", async () => {
    const machine = compiledMachine("compiled-source-only")
    mkdirSync(join(machine.directory, "v99.0.0/packages/run/src"), { recursive: true })
    writeFileSync(join(machine.directory, "v99.0.0/packages/run/src/bin.ts"), "")
    const result = await updateCompiled(machine, new Map())
    expect(result.outcome).toBe("failed")
    expect(readFileSync(join(machine.directory, "release"), "utf8")).toBe("1.0.0\n")
  })
})
