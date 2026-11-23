import { expect, test } from "bun:test"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

const source = join(import.meta.dir, "../../trials/bb/try-bb.sh")

const withTrial = async (use: (dir: string, run: (portBusy?: "0" | "1") => ReturnType<typeof Bun.spawnSync>) => Promise<void>) => {
  const dir = await mkdtemp(join(process.cwd(), "trials/bb/.test-"))
  try {
    const bin = join(dir, "bin")
    await mkdir(bin)
    await copyFile(source, join(dir, "try-bb.sh"))
    for (const tool of ["id", "curl", "hdiutil", "ditto", "shasum", "jq", "lsof", "sqlite3", "orc", "screencapture", "pgrep"]) {
      const body = tool === "id" ? "printf '\\n'" :
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
  test("bb trial refuses an existing preferences " + kind + " before setup", async () => {
    await withTrial(async (dir, run) => {
      const prefs = join(dir, "Library/Preferences/dev.bb.desktop.plist")
      await mkdir(join(dir, "Library/Preferences"), { recursive: true })
      if (kind === "file") await writeFile(prefs, "personal preferences")
      else await symlink(join(dir, "missing-preferences"), prefs)
      const result = run()
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain(prefs)
      expect(await Bun.file(join(dir, "ports")).exists()).toBe(false)
      if (kind === "file") expect(await readFile(prefs, "utf8")).toBe("personal preferences")
    })
  })
}

test("bb trial ignores the port override when checking both fixed ports", async () => {
  await withTrial(async (dir, run) => {
    const result = run()
    expect(result.exitCode).toBe(1)
    expect(await readFile(join(dir, "ports"), "utf8")).toBe("-nP\n-iTCP:38986\n-iTCP:38987\n-sTCP:LISTEN\n")
    expect(result.stderr.toString()).not.toContain("BB_TRIAL_PORT")
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
