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

  const fakeOrc = '#!/bin/sh\nprintf "orc 99.0.0\\n"\n'

  const archiveName = "orc-99.0.0-" + process.platform + "-" + process.arch + ".tar.gz"

  type Assets = Map<string, Uint8Array<ArrayBuffer> | string>

  const releaseArchive = (dir: string): Uint8Array<ArrayBuffer> => {
    const stage = join(dir, "stage")
    mkdirSync(join(stage, "herdr-app"), { recursive: true })
    writeFileSync(join(stage, "orc"), fakeOrc)
    chmodSync(join(stage, "orc"), 0o755)
    writeFileSync(join(stage, "heavy-standin"), "")
    const archive = join(dir, archiveName)
    const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", stage, "orc", "heavy-standin", "herdr-app"])
    expect(tar.exitCode).toBe(0)
    return readFileSync(archive)
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

  test("a compiled launcher selects a prepared release instead of running bun add -g", async () => {
    const machine = compiledMachine("compiled-prepared")
    mkdirSync(join(machine.directory, "v99.0.0"))
    writeFileSync(join(machine.directory, "v99.0.0/orc"), fakeOrc)
    chmodSync(join(machine.directory, "v99.0.0/orc"), 0o755)
    const result = await updateCompiled(machine, new Map())
    expect(result.outcome).toBe("installed")
    expect(readFileSync(join(machine.directory, "release"), "utf8")).toBe("99.0.0\n")
  })

  test("a compiled launcher downloads its platform archive instead of cloning a source checkout with bun", async () => {
    const machine = compiledMachine("compiled-download")
    const archive = releaseArchive(machine.home)
    const digest = new Bun.CryptoHasher("sha256").update(archive).digest("hex")
    const result = await updateCompiled(machine, new Map<string, Uint8Array<ArrayBuffer> | string>([
      ["/releases/v99.0.0/" + archiveName, archive],
      ["/releases/v99.0.0/" + archiveName + ".sha256", digest + "  " + archiveName + "\n"]
    ]))
    expect(result).toMatchObject({ outcome: "installed", running: "1.0.0", found: "99.0.0" })
    expect(readFileSync(join(machine.directory, "release"), "utf8")).toBe("99.0.0\n")
    expect(readFileSync(join(machine.directory, "v99.0.0/orc"), "utf8")).toBe(fakeOrc)
    expect(existsSync(join(machine.directory, "v99.0.0/herdr-app"))).toBe(true)
    expect(existsSync(join(machine.directory, "v99.0.0", archiveName))).toBe(false)
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
