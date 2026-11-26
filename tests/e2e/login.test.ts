import { bundlePath, ensureBundle } from "./bundle"
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

ensureBundle()
const binPath = bundlePath

const token = "sk-ant-oat01-" + "Q7f".repeat(30)
const codexToken = "sk-proj-" + "Z4k".repeat(30)
const tokenShaped = /sk-(ant|proj)-[A-Za-z0-9_-]{8,}/
const apiKey = "sk-or-v1-" + "k3P".repeat(20)
const signInLink = "https://claude.ai/oauth/authorize?code=true"

interface Fixture {
  readonly dir: string
  readonly home: string
  readonly bin: string
  readonly claudeLog: string
  readonly browserLog: string
  readonly codexLog: string
  readonly opencodeLog: string
}

// The fake keeps the token in a regular file and makes the credential file a FIFO, so any read of it by orc blocks until the test kills orc.
const fakeClaude = (log: string): string =>
  [
    "#!/bin/sh",
    "printf 'args=%s\\n' \"$*\" >> '" + log + "'",
    "env >> '" + log + "'",
    "printf '{\"token\":\"" + token + "\"}' > \"$CLAUDE_CONFIG_DIR/.claude.json\"",
    "mkfifo \"$CLAUDE_CONFIG_DIR/.credentials.json\"",
    "printf '%s' \"$FAKE_ACCOUNT\" > \"$CLAUDE_CONFIG_DIR/account\"",
    "if [ -n \"$BROWSER\" ]; then \"$BROWSER\" '" + signInLink + "'; fi",
    "echo 'Login successful.'",
    ""
  ].join("\n")

const fakeTools = (browserLog: string): Record<string, string> => ({
  "xdg-settings": "#!/bin/sh\necho \"$FAKE_LINUX_BROWSER\"\n",
  plutil: "#!/bin/sh\nprintf '{\"LSHandlers\":[{\"LSHandlerURLScheme\":\"https\",\"LSHandlerRoleAll\":\"%s\"}]}' \"$FAKE_MAC_BROWSER\"\n",
  firefox: "#!/bin/sh\nprintf 'firefox %s\\n' \"$*\" >> '" + browserLog + "'\n",
  open: "#!/bin/sh\nprintf 'open %s\\n' \"$*\" >> '" + browserLog + "'\n"
})

const fakeCodex = (log: string): string =>
  [
    "#!/bin/sh",
    "printf 'args=%s\\n' \"$*\" >> '" + log + "'",
    "env >> '" + log + "'",
    "printf '{\"token\":\"" + codexToken + "\"}' > \"$CODEX_HOME/session.json\"",
    "mkfifo \"$CODEX_HOME/auth.json\"",
    "echo 'Successfully logged in'",
    ""
  ].join("\n")

// The fake takes the key from the stdin orc passes through and stores it only in OpenCode's data folder.
const fakeOpencode = (log: string): string =>
  [
    "#!/bin/sh",
    "printf 'args=%s\\n' \"$*\" >> '" + log + "'",
    "env >> '" + log + "'",
    "read -r key",
    "mkdir -p \"$XDG_DATA_HOME/opencode\"",
    "printf '{\"key\":\"%s\"}' \"$key\" > \"$XDG_DATA_HOME/opencode/auth.json\"",
    "echo 'Login successful.'",
    ""
  ].join("\n")

const filesUnder = async (dir: string): Promise<readonly string[]> =>
  (await readdir(dir, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))

const withFixture = async (body: (fixture: Fixture) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "orc-login-e2e-"))
  try {
    const bin = join(dir, "bin")
    const claudeLog = join(dir, "claude.log")
    const browserLog = join(dir, "browser.log")
    const codexLog = join(dir, "codex.log")
    const opencodeLog = join(dir, "opencode.log")
    await mkdir(bin, { recursive: true })
    for (const [name, script] of Object.entries({ claude: fakeClaude(claudeLog), codex: fakeCodex(codexLog), opencode: fakeOpencode(opencodeLog), ...fakeTools(browserLog) })) {
      await writeFile(join(bin, name), script)
      await chmod(join(bin, name), 0o755)
    }
    await body({ dir, home: join(dir, "home"), bin, claudeLog, browserLog, codexLog, opencodeLog })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const login = async (fixture: Fixture, account: string, env: Record<string, string>, typed?: string) => {
  const proc = Bun.spawn([process.execPath, binPath, "login", account], {
    stdin: typed === undefined ? "ignore" : new Blob([typed]),
    stdout: "pipe",
    stderr: "pipe",
    cwd: fixture.dir,
    env: { ...process.env, ORC_HOME: fixture.home, PATH: fixture.bin + ":" + (process.env.PATH ?? ""), SSH_CONNECTION: "", SSH_TTY: "", DISPLAY: ":0", WAYLAND_DISPLAY: "", BROWSER: "", FAKE_ACCOUNT: account, ...env }
  })
  let killed = false
  const deadline = setTimeout(() => {
    killed = true
    proc.kill()
  }, 15_000)
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(deadline)
  return { exitCode, stdout, stderr, killed }
}

const takeLog = async (fixture: Fixture): Promise<string> => {
  const log = await readFile(fixture.claudeLog, "utf8")
  await rm(fixture.claudeLog)
  return log
}

const desktop = { DISPLAY: ":0", WAYLAND_DISPLAY: "" }

describe("orc login", () => {
  test("signs claude-main and claude-second in side by side, each only in its own folder", async () => {
    await withFixture(async (fixture) => {
      const main = join(fixture.home, "accounts", "claude-main")
      const second = join(fixture.home, "accounts", "claude-second")
      for (const [account, own, other] of [["claude-main", main, second], ["claude-second", second, main]] as const) {
        const ran = await login(fixture, account, { CLAUDE_CONFIG_DIR: other })
        expect(ran.stderr).toBe("")
        expect(ran.exitCode).toBe(0)
        const log = await takeLog(fixture)
        expect(log).toContain("args=auth login\n")
        expect(log.split("\n").filter((line) => line.includes(join(fixture.home, "accounts")))).toEqual(["CLAUDE_CONFIG_DIR=" + own])
        expect(ran.stdout).toContain("Login successful.")
        expect(ran.stdout).toContain("signed in with CLAUDE_CONFIG_DIR=" + own)
      }
      expect((await readdir(join(fixture.home, "accounts"))).toSorted()).toEqual(["claude-main", "claude-second"])
      expect((await readdir(main)).toSorted()).toEqual([".claude.json", ".credentials.json", "account"])
      expect((await readdir(second)).toSorted()).toEqual([".claude.json", ".credentials.json", "account"])
      expect(await readFile(join(main, "account"), "utf8")).toBe("claude-main")
      expect(await readFile(join(second, "account"), "utf8")).toBe("claude-second")
    })
  }, 60_000)

  test("runs the Claude sign-in with only the claude-main folder and leaves every other account folder alone", async () => {
    await withFixture(async (fixture) => {
      const main = join(fixture.home, "accounts", "claude-main")
      const second = join(fixture.home, "accounts", "claude-second")
      await mkdir(second, { recursive: true })
      await writeFile(join(second, "kept"), "second account")
      const ran = await login(fixture, "claude-main", { CLAUDE_CONFIG_DIR: second })
      expect(ran.stderr).toBe("")
      expect(ran.exitCode).toBe(0)
      const log = await readFile(fixture.claudeLog, "utf8")
      expect(log).toContain("args=auth login\n")
      expect(log).toContain("CLAUDE_CONFIG_DIR=" + main + "\n")
      expect(log.split("\n").filter((line) => line.includes(join(fixture.home, "accounts")))).toEqual(["CLAUDE_CONFIG_DIR=" + main])
      expect((await readdir(join(fixture.home, "accounts"))).toSorted()).toEqual(["claude-main", "claude-second"])
      expect(await readdir(second)).toEqual(["kept"])
      expect(await readFile(join(second, "kept"), "utf8")).toBe("second account")
      expect(ran.stdout).toContain("Login successful.")
      expect(ran.stdout).toContain("signed in with CLAUDE_CONFIG_DIR=" + main)
    })
  }, 30_000)

  for (const account of ["claude-main", "claude-second"]) {
    test(account + " prints no token-shaped value and opens no credential file", async () => {
      await withFixture(async (fixture) => {
        const ran = await login(fixture, account, { ...desktop, FAKE_LINUX_BROWSER: "firefox.desktop", FAKE_MAC_BROWSER: "org.mozilla.firefox" })
        expect(ran.killed).toBe(false)
        expect(ran.exitCode).toBe(0)
        expect(await readFile(join(fixture.home, "accounts", account, ".claude.json"), "utf8")).toContain(token)
        expect(ran.stdout).not.toMatch(tokenShaped)
        expect(ran.stderr).not.toMatch(tokenShaped)
      })
    }, 30_000)
  }

  test("opens the claude-second sign-in link in a private window of the default browser", async () => {
    await withFixture(async (fixture) => {
      const ran = await login(fixture, "claude-second", { ...desktop, FAKE_LINUX_BROWSER: "firefox.desktop", FAKE_MAC_BROWSER: "org.mozilla.firefox" })
      expect(ran.exitCode).toBe(0)
      expect(ran.stdout).toContain("opens the sign-in link in a private window of")
      expect(await readFile(fixture.browserLog, "utf8")).toBe(process.platform === "darwin"
        ? "open -na Firefox --args --private-window " + signInLink + "\n"
        : "firefox --private-window " + signInLink + "\n")
    })
  }, 30_000)

  test("opens no browser window for claude-second when the default browser has no known private window", async () => {
    await withFixture(async (fixture) => {
      const ran = await login(fixture, "claude-second", { ...desktop, FAKE_LINUX_BROWSER: "org.gnome.Epiphany.desktop", FAKE_MAC_BROWSER: "com.apple.Safari" })
      expect(ran.exitCode).toBe(0)
      expect(ran.stdout).toContain("orc knows no private window for the default browser")
      expect(existsSync(fixture.browserLog)).toBe(false)
    })
  }, 30_000)

  test("leaves the claude-main sign-in to the normal browser window", async () => {
    await withFixture(async (fixture) => {
      const ran = await login(fixture, "claude-main", { ...desktop, FAKE_LINUX_BROWSER: "firefox.desktop", FAKE_MAC_BROWSER: "org.mozilla.firefox" })
      expect(ran.exitCode).toBe(0)
      expect(await takeLog(fixture)).toContain("\nBROWSER=\n")
      expect(existsSync(fixture.browserLog)).toBe(false)
    })
  }, 30_000)

  for (const account of ["claude-main", "claude-second"]) {
    test("tells the person to open the " + account + " link elsewhere on a machine reached over SSH", async () => {
      await withFixture(async (fixture) => {
        const ran = await login(fixture, account, { SSH_CONNECTION: "10.0.0.2 52000 10.0.0.1 22", BROWSER: join(fixture.bin, "firefox") })
        expect(ran.exitCode).toBe(0)
        expect(ran.stdout).toContain("This machine has no browser, so Claude prints a link")
        if (account === "claude-second") {
          expect(existsSync(fixture.browserLog)).toBe(false)
        }
      })
    }, 30_000)
  }

  test("runs the Codex sign-in with only the openai folder and leaves every other account folder alone", async () => {
    await withFixture(async (fixture) => {
      const openai = join(fixture.home, "accounts", "openai")
      const main = join(fixture.home, "accounts", "claude-main")
      await mkdir(main, { recursive: true })
      await writeFile(join(main, "kept"), "claude account")
      const ran = await login(fixture, "openai", { CODEX_HOME: main })
      expect(ran.stderr).toBe("")
      expect(ran.exitCode).toBe(0)
      const log = await readFile(fixture.codexLog, "utf8")
      expect(log).toContain("args=login\n")
      expect(log).toContain("CODEX_HOME=" + openai + "\n")
      expect(log.split("\n").filter((line) => line.includes(join(fixture.home, "accounts")))).toEqual(["CODEX_HOME=" + openai])
      expect((await readdir(join(fixture.home, "accounts"))).toSorted()).toEqual(["claude-main", "openai"])
      expect(await readdir(main)).toEqual(["kept"])
      expect(existsSync(fixture.claudeLog)).toBe(false)
      expect(ran.stdout).toContain("Successfully logged in")
      expect(ran.stdout).toContain("signed in with CODEX_HOME=" + openai)
    })
  }, 30_000)

  test("prints no token-shaped value and opens no credential file for openai", async () => {
    await withFixture(async (fixture) => {
      const ran = await login(fixture, "openai", {})
      expect(ran.killed).toBe(false)
      expect(ran.exitCode).toBe(0)
      expect(await readFile(join(fixture.home, "accounts", "openai", "session.json"), "utf8")).toContain(codexToken)
      expect(ran.stdout).not.toMatch(tokenShaped)
      expect(ran.stderr).not.toMatch(tokenShaped)
    })
  }, 30_000)

  test("runs the Codex device-code sign-in on a machine reached over SSH", async () => {
    await withFixture(async (fixture) => {
      const ran = await login(fixture, "openai", { SSH_TTY: "/dev/ttys001" })
      expect(ran.exitCode).toBe(0)
      expect(await readFile(fixture.codexLog, "utf8")).toContain("args=login --device-auth\n")
      expect(ran.stdout).toContain("This machine has no browser, so Codex signs in with a device code")
    })
  }, 30_000)

  test("runs the OpenCode sign-in with only the opencode data folder and leaves every other account folder alone", async () => {
    await withFixture(async (fixture) => {
      const opencode = join(fixture.home, "accounts", "opencode")
      const main = join(fixture.home, "accounts", "claude-main")
      await mkdir(main, { recursive: true })
      await writeFile(join(main, "kept"), "main account")
      const ran = await login(fixture, "opencode", { XDG_DATA_HOME: main, SSH_CONNECTION: "10.0.0.2 52000 10.0.0.1 22" }, apiKey + "\n")
      expect(ran.stderr).toBe("")
      expect(ran.exitCode).toBe(0)
      const log = await readFile(fixture.opencodeLog, "utf8")
      expect(log).toContain("args=auth login\n")
      expect(log.split("\n").filter((line) => line.includes(join(fixture.home, "accounts")))).toEqual(["XDG_DATA_HOME=" + opencode])
      expect((await readdir(join(fixture.home, "accounts"))).toSorted()).toEqual(["claude-main", "opencode"])
      expect(await readdir(main)).toEqual(["kept"])
      expect(ran.stdout).toContain("signed in with XDG_DATA_HOME=" + opencode)
      expect(ran.stdout).not.toContain("no browser")
    })
  }, 30_000)

  test("keeps the pasted OpenCode key out of orc's output and out of every file outside the opencode folder", async () => {
    await withFixture(async (fixture) => {
      const opencode = join(fixture.home, "accounts", "opencode")
      const ran = await login(fixture, "opencode", {}, apiKey + "\n")
      expect(ran.killed).toBe(false)
      expect(ran.exitCode).toBe(0)
      expect(await readFile(join(opencode, "opencode", "auth.json"), "utf8")).toContain(apiKey)
      expect(ran.stdout).not.toContain(apiKey)
      expect(ran.stderr).not.toContain(apiKey)
      const outside = (await filesUnder(fixture.dir)).filter((file) => !file.startsWith(opencode + "/"))
      expect(outside.length).toBeGreaterThan(0)
      for (const file of outside) {
        let content: string
        try {
          content = await readFile(file, "utf8")
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
            continue
          }
          throw error
        }
        expect({ file, holdsKey: content.includes(apiKey) }).toEqual({ file, holdsKey: false })
      }
    })
  }, 30_000)

  test("refuses an unknown account and makes no folder for it", async () => {
    await withFixture(async (fixture) => {
      const ran = await login(fixture, "gemini", {})
      expect(ran.exitCode).not.toBe(0)
      expect(ran.stderr).toContain("orc login takes one account")
      expect(existsSync(fixture.claudeLog)).toBe(false)
      expect(existsSync(fixture.codexLog)).toBe(false)
      expect(existsSync(fixture.opencodeLog)).toBe(false)
      expect(existsSync(join(fixture.home, "accounts", "gemini"))).toBe(false)
    })
  }, 30_000)
})
