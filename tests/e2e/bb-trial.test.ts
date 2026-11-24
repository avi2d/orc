import { expect, test } from "bun:test"
import { chmod, copyFile, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

const source = join(import.meta.dir, "../../trials/bb/try-bb.sh")
const preferencesSha256 = "bd80d346c237d7987808c26a5a6ece6a4aa70f6cde64cb324c1c1b0ecb9859c3"

const withTrial = async (use: (dir: string, run: (portBusy?: "0" | "1") => ReturnType<typeof Bun.spawnSync>) => Promise<void>) => {
  const dir = await mkdtemp(join(process.cwd(), "trials/bb/.test-"))
  try {
    const bin = join(dir, "bin")
    await mkdir(bin)
    await copyFile(source, join(dir, "try-bb.sh"))
    for (const tool of ["id", "curl", "hdiutil", "ditto", "jq", "lsof", "sqlite3", "orc", "screencapture", "codesign", "defaults", "pgrep"]) {
      const body = tool === "id" ? "printf '\\n'" :
        tool === "curl" ? 'printf "%s\\n" "$@" > "$HOME/download-attempt"; exit 1' :
        tool === "lsof" ? 'printf "%s\\n" "$@" > "$HOME/ports"; exit "${TRIAL_PORT_BUSY:-0}"' :
        "exit 1"
      const path = join(bin, tool)
      await writeFile(path, "#!/bin/bash\n" + body + "\n")
      await chmod(path, 0o755)
    }
    const run = (portBusy: "0" | "1" = "0") => Bun.spawnSync(["bash", join(dir, "try-bb.sh")], {
      cwd: dir,
      env: {
        PATH: bin + ":" + (process.env["PATH"] ?? ""),
        HOME: dir,
        BB_TRIAL_HOME: join(dir, "override-home"),
        BB_TRIAL_PORT: "49990",
        TRIAL_PORT_BUSY: portBusy
      },
      stdout: "pipe",
      stderr: "pipe"
    })
    await use(dir, run)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

for (const kind of ["file", "symlink"] as const) {
  test("bb trial goes on past an existing preferences " + kind + " instead of refusing, and leaves it as it was", async () => {
    await withTrial(async (dir, run) => {
      const prefs = join(dir, "Library/Preferences/dev.bb.desktop.plist")
      await mkdir(join(dir, "Library/Preferences"), { recursive: true })
      const target = join(dir, "personal-preferences")
      await writeFile(target, "personal preferences")
      if (kind === "file") await copyFile(target, prefs)
      else await symlink(target, prefs)
      const result = run("1")
      expect(result.exitCode).toBe(1)
      expect((result.stderr?.toString() ?? "")).not.toContain(prefs)
      expect(await Bun.file(join(dir, "ports")).exists()).toBe(true)
      expect(await readFile(prefs, "utf8")).toBe("personal preferences")
      if (kind === "symlink") expect(await readlink(prefs)).toBe(target)
      expect(await readFile(join(dir, ".scratch/proof/real-before"), "utf8")).toContain(`${preferencesSha256}  ${prefs}\n`)
      expect(await readFile(join(dir, "download-attempt"), "utf8")).toContain("https://github.com/get-bb/bb/releases/download/desktop-v0.50.1/bb-0.50.1-arm64.dmg")
    })
  })
}

for (const root of [".bb", "Library/Application Support/bb"]) {
  test("bb trial hashes a symlinked " + root + " root without following nested links or loops", async () => {
    await withTrial(async (dir, run) => {
      const data = join(dir, "personal-data")
      const external = join(dir, "external-data")
      await mkdir(data)
      await mkdir(external)
      await writeFile(join(data, "settings"), "personal preferences")
      await writeFile(join(external, "unrelated"), "not bb data")
      await symlink(external, join(data, "nested-directory"))
      await symlink(join(external, "unrelated"), join(data, "nested-file"))
      await symlink(data, join(data, "loop"))
      const path = join(dir, root)
      await mkdir(join(path, ".."), { recursive: true })
      await symlink(data, path)
      const result = run("1")
      expect(result.exitCode).toBe(1)
      const snapshot = await readFile(join(dir, ".scratch/proof/real-before"), "utf8")
      expect(snapshot).toContain(`${preferencesSha256}  ${join(path, "settings")}\n`)
      expect(snapshot).not.toContain("nested-directory")
      expect(snapshot).not.toContain("nested-file")
      expect(snapshot).not.toContain("loop")
      expect(await Bun.file(join(dir, "download-attempt")).exists()).toBe(true)
    })
  })
}

test("bb trial ignores the port override when checking both fixed ports", async () => {
  await withTrial(async (dir, run) => {
    const result = run()
    expect(result.exitCode).toBe(1)
    expect(await readFile(join(dir, "ports"), "utf8")).toBe("-nP\n-iTCP:38986\n-iTCP:38987\n-sTCP:LISTEN\n")
    expect((result.stderr?.toString() ?? "")).not.toContain("BB_TRIAL_PORT")
  })
})

test("bb trial ignores the home override when creating scratch proof", async () => {
  await withTrial(async (dir, run) => {
    const result = run("1")
    expect(result.exitCode).toBe(1)
    expect(await Bun.file(join(dir, ".scratch/proof/real-before")).exists()).toBe(true)
    expect(await Bun.file(join(dir, "override-home/proof/real-before")).exists()).toBe(false)
  })
})
