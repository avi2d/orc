import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"
import { binPath, fixtureToken, git, keyedProvider, loginProvider, type NoSandboxFixture, prUrl, runOrc, withNoSandboxFixture, writeConfig, writeScript } from "./no-sandbox-fixture"

const keyedModel = "keyed/coder-2"

const packagedModel = "bridged/coder-3"

const bridgedPackages = ["git:example.test/acme/pi-bridged@v1.2.0", "/opt/pi-packages/acme-tools"]

const packageProvider = { id: "bridged", credential: "package", packages: bridgedPackages, env: { ACME_ACCOUNT_DIR: "/accounts/main" } }

const decodeKeyedModels = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ providers: Schema.Struct({ keyed: Schema.Struct({ apiKey: Schema.String }) }) })))

const writeToken = async (fixture: NoSandboxFixture, name: string, tokenMode: number): Promise<string> => {
  const secretDir = join(fixture.home, "..", "secret")
  await mkdir(secretDir, { recursive: true, mode: 0o700 })
  const tokenFile = join(secretDir, name)
  await writeFile(tokenFile, fixtureToken)
  await chmod(tokenFile, tokenMode)
  return tokenFile
}

const asTokenFileRun = async (fixture: NoSandboxFixture, tokenMode: number): Promise<Record<string, string> & { readonly KEYED_TOKEN_FILE: string }> => {
  await writeConfig(fixture.env, { providers: [loginProvider, keyedProvider], models: { implementer: keyedModel, fixer: keyedModel } })
  return { ...fixture.env, KEYED_TOKEN_FILE: await writeToken(fixture, "keyed-token", tokenMode) }
}

const filesUnder = async (dir: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
}

const filesHolding = async (dirs: ReadonlyArray<string>, needle: string): Promise<ReadonlyArray<string>> => {
  const holding: Array<string> = []
  for (const dir of dirs) {
    for (const file of await filesUnder(dir)) {
      if ((await readFile(file)).includes(needle)) {
        holding.push(file)
      }
    }
  }
  return holding
}

describe("orc run --sandbox none", () => {
  test("runs Pi on the host in its own worktree, without nono and without writing the operator's git config, to one PR", async () => {
    await withNoSandboxFixture(async ({ repo, home, fakeBin, env }) => {
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], repo, env)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) })
      expect(result.stdout).toContain(prUrl)
      const piCwd = (await readFile(join(fakeBin, "pi-cwd"), "utf8")).trim()
      expect(piCwd).not.toBe(repo)
      expect((await readFile(join(fakeBin, "pi-git"), "utf8")).trim().split("\n")).toEqual([piCwd, join(repo, ".git"), "orc/test"])
      expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"], env)).not.toBe("orc/test")
      expect(git(repo, ["log", "orc/test", "--format=%s"], env).split("\n")).toEqual(["add greeting", "task"])
      const nmCalls = (await readFile(join(fakeBin, "nm-calls"), "utf8")).split("\n").filter((line) => line !== "")
      expect(nmCalls.filter((line) => line.startsWith("axi run")).length).toBe(1)
      expect(nmCalls.every((line) => line.endsWith(" @ " + piCwd))).toBe(true)
      expect(await Bun.file(join(fakeBin, "nono-calls")).exists()).toBe(false)
      expect(await Bun.file(join(home, ".gitconfig")).exists()).toBe(false)
      expect((await readFile(join(fakeBin, "pi-gitconfig"), "utf8")).trim()).toStartWith(env["ORC_HOME"] ?? "")
    })
  }, 60_000)

  test("with --instructions names the file on the first output line and hands Pi its words instead of running without them", async () => {
    await withNoSandboxFixture(async ({ repo, fakeBin, env }) => {
      const instructions = join(repo, "..", "orc-instructions.md")
      await writeFile(instructions, "Answer every question with the word PELICAN.\n")
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none", "--instructions", "../orc-instructions.md"], repo, env)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.split("\n")[0]).toBe("orc run loaded the instructions in " + instructions)
      expect(await readFile(join(fakeBin, "pi-instructions"), "utf8")).toBe("Answer every question with the word PELICAN.\n")
    })
  }, 60_000)

  test("without --instructions hands Pi no instructions and prints no instructions line", async () => {
    await withNoSandboxFixture(async ({ repo, fakeBin, env }) => {
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], repo, env)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain("instructions")
      expect(await Bun.file(join(fakeBin, "pi-instructions")).exists()).toBe(false)
    })
  }, 60_000)

  test("with --instructions naming a missing file is refused before Pi runs instead of running without them", async () => {
    await withNoSandboxFixture(async ({ repo, fakeBin, env }) => {
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none", "--instructions", "gone.md"], repo, env)
      expect({ exitCode: result.exitCode, stderr: result.stderr.trim() }).toEqual({ exitCode: 1, stderr: "orc run found no instructions file at " + join(repo, "gone.md") })
      expect(await Bun.file(join(fakeBin, "pi-cwd")).exists()).toBe(false)
    })
  }, 60_000)

  test("after the runner queues it, the run branches from the remote's new tip instead of the checkout's stale one", async () => {
    await withNoSandboxFixture(async ({ repo, fakeBin, env }) => {
      const origin = join(fakeBin, "..", "origin.git")
      const branch = git(repo, ["symbolic-ref", "--short", "HEAD"], env)
      git(fakeBin, ["init", "-q", "--bare", "--initial-branch=" + branch, origin], env)
      git(repo, ["remote", "add", "origin", origin], env)
      git(repo, ["push", "-q", "origin", branch], env)
      const upstream = join(fakeBin, "..", "upstream")
      git(fakeBin, ["clone", "-q", origin, upstream], env)
      git(upstream, ["config", "user.name", "orc test"], env)
      git(upstream, ["config", "user.email", "orc@test.invalid"], env)
      await writeFile(join(upstream, "upstream.txt"), "upstream\n")
      git(upstream, ["add", "upstream.txt"], env)
      git(upstream, ["commit", "-qm", "upstream change"], env)
      git(upstream, ["push", "-q", "origin", branch], env)
      await writeScript(join(fakeBin, "pueue"), [
        "case \"$1\" in",
        "  status) echo '{\"tasks\":{},\"groups\":{}}' ;;",
        "  group) echo '{\"orc\":{}}' ;;",
        "  add) echo 5 ;;",
        "esac"
      ])
      const request = JSON.stringify({ task: "task-1", checkout: repo, provider: "acme-go", body: "Create greeting.txt.\n" })
      const proc = Bun.spawn([process.execPath, binPath, "runner", "queue"], { stdin: new TextEncoder().encode(request), stdout: "pipe", stderr: "pipe", cwd: repo, env })
      const [queued, queueErr, queueExit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      expect({ exitCode: queueExit, stderr: queueErr }).toEqual({ exitCode: 0, stderr: "" })
      expect(queued).toBe("queued task-1 as pueue task 5 in group orc\n")
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], repo, env)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) })
      expect(result.stdout).toStartWith("fast-forwarded " + branch + " in " + repo + " from ")
      expect(git(repo, ["log", "orc/test", "--format=%s"], env).split("\n")).toEqual(["add greeting", "upstream change", "task"])
    })
  }, 60_000)

  test("with --delivery direct-PR pushes the branch and opens the PR through gh instead of starting no-mistakes", async () => {
    await withNoSandboxFixture(async ({ repo, fakeBin, env }) => {
      const origin = join(fakeBin, "..", "origin.git")
      git(fakeBin, ["init", "-q", "--bare", origin], env)
      git(repo, ["remote", "add", "origin", origin], env)
      const directPrUrl = "https://github.com/o/r/pull/11"
      await writeScript(join(fakeBin, "gh"), [
        "echo \"$* @ $(pwd)\" >> \"" + fakeBin + "/gh-calls\"",
        "if [ \"$1 $2\" = 'pr list' ]; then exit 0; fi",
        "echo " + directPrUrl
      ])
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none", "--delivery", "direct-PR"], repo, env)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) })
      expect(result.stdout).toContain(directPrUrl)
      const piCwd = (await readFile(join(fakeBin, "pi-cwd"), "utf8")).trim()
      expect(git(origin, ["log", "orc/test", "--format=%s"], env).split("\n")).toEqual(["add greeting", "task"])
      const ghCalls = (await readFile(join(fakeBin, "gh-calls"), "utf8")).split("\n").filter((line) => line !== "")
      expect(ghCalls.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual(["pr list", "pr create"])
      expect(ghCalls.every((line) => line.endsWith(" @ " + piCwd))).toBe(true)
      const nmCalls = await readFile(join(fakeBin, "nm-calls"), "utf8").catch(() => "")
      expect(nmCalls).not.toContain("axi run")
    })
  }, 60_000)

  test("without --sandbox the run still takes nono instead of running unsandboxed", async () => {
    await withNoSandboxFixture(async ({ repo, fakeBin, env }) => {
      const result = await runOrc(["run", "task.md", "--branch", "orc/test"], repo, env)
      expect(result.exitCode).not.toBe(0)
      expect(await Bun.file(join(fakeBin, "pi-cwd")).exists()).toBe(false)
    })
  }, 60_000)
})

describe("orc run on a token-file provider", () => {
  test("hands Pi a run-owned agent folder whose key reads the token file, ends in one PR and leaves the token in no run, repo or home file", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const env = await asTokenFileRun(fixture, 0o600)
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], fixture.repo, env)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) })
      expect(result.stdout).toContain(prUrl)
      const nmCalls = (await readFile(join(fixture.fakeBin, "nm-calls"), "utf8")).split("\n").filter((line) => line !== "")
      expect(nmCalls.filter((line) => line.startsWith("axi run")).length).toBe(1)
      const agentDir = (await readFile(join(fixture.fakeBin, "pi-agent-dir"), "utf8")).trim()
      expect(agentDir).toStartWith((env["ORC_HOME"] ?? "") + "/")
      const apiKey = decodeKeyedModels(await readFile(join(fixture.fakeBin, "pi-models"), "utf8")).providers.keyed.apiKey
      expect(apiKey).toStartWith("!")
      const handed = (await readFile(join(fixture.fakeBin, "pi-token-file"), "utf8")).trim()
      expect(handed).toBe(env.KEYED_TOKEN_FILE)
      const resolved = Bun.spawnSync(["sh", "-c", apiKey.slice(1)], { env: { AGENT_TOKEN_FILE: handed } })
      expect(resolved.stdout.toString()).toBe(fixtureToken)
      expect(await filesHolding([env["ORC_HOME"] ?? "", fixture.repo, fixture.home], fixtureToken)).toEqual([])
      expect(git(fixture.repo, ["log", "--all", "-p"], env)).not.toContain(fixtureToken)
      expect(await Bun.file(join(fixture.fakeBin, "nono-calls")).exists()).toBe(false)
    })
  }, 60_000)

  test("hands Pi the token file config.json names by path when the provider names no variable", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const tokenFile = await writeToken(fixture, "path-token", 0o600)
      await writeConfig(fixture.env, { providers: [{ id: "keyed", credential: "token-file", tokenFile: { path: tokenFile } }], models: { implementer: keyedModel, fixer: keyedModel } })
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], fixture.repo, fixture.env)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) })
      expect((await readFile(join(fixture.fakeBin, "pi-token-file"), "utf8")).trim()).toBe(tokenFile)
    })
  }, 60_000)

  test("hands Pi the --token-file path instead of the one the provider's variable names", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const env = await asTokenFileRun(fixture, 0o600)
      const second = await writeToken(fixture, "second-token", 0o600)
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none", "--token-file", second], fixture.repo, env)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) })
      expect((await readFile(join(fixture.fakeBin, "pi-token-file"), "utf8")).trim()).toBe(second)
    })
  }, 60_000)

  test("with --provider naming another provider is refused before Pi runs instead of handing the token across", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const env = await asTokenFileRun(fixture, 0o600)
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none", "--provider", "acme-go"], fixture.repo, env)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("--provider names acme-go")
      expect(await Bun.file(join(fixture.fakeBin, "pi-cwd")).exists()).toBe(false)
    })
  }, 60_000)

  test("with the provider's variable unset is refused before Pi runs, naming the variable", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const { KEYED_TOKEN_FILE: _unset, ...env } = await asTokenFileRun(fixture, 0o600)
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], fixture.repo, env)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("the variable KEYED_TOKEN_FILE names, which is unset")
      expect(await Bun.file(join(fixture.fakeBin, "pi-cwd")).exists()).toBe(false)
    })
  }, 60_000)

  test("in the nono sandbox is refused before Pi runs, naming --sandbox none", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const env = await asTokenFileRun(fixture, 0o600)
      const result = await runOrc(["run", "task.md", "--branch", "orc/test"], fixture.repo, env)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("--sandbox none")
      expect(await Bun.file(join(fixture.fakeBin, "pi-cwd")).exists()).toBe(false)
    })
  }, 60_000)

  test("with a token file other users can read is refused before Pi runs", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const env = await asTokenFileRun(fixture, 0o644)
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], fixture.repo, env)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("has mode 644")
      expect(await Bun.file(join(fixture.fakeBin, "pi-cwd")).exists()).toBe(false)
    })
  }, 60_000)
})

describe("orc run on a package provider", () => {
  const asPackageRun = (fixture: NoSandboxFixture, provider: unknown = packageProvider): Promise<void> =>
    writeConfig(fixture.env, { providers: [loginProvider, provider], models: { implementer: packagedModel, fixer: packagedModel } })

  test("writes the configured packages into the run's Pi settings, hands Pi the configured env and no key, and ends in one PR", async () => {
    await withNoSandboxFixture(async (fixture) => {
      await asPackageRun(fixture)
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], fixture.repo, fixture.env)
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: expect.any(String) })
      expect(result.stdout).toContain(prUrl)
      expect((await readFile(join(fixture.fakeBin, "pi-agent-dir"), "utf8")).trim()).toStartWith((fixture.env["ORC_HOME"] ?? "") + "/")
      expect(JSON.parse(await readFile(join(fixture.fakeBin, "pi-settings"), "utf8"))).toEqual({
        packages: bridgedPackages,
        compaction: { modelOverrides: { [packagedModel]: { reserveTokens: 250000 } } }
      })
      expect(JSON.parse(await readFile(join(fixture.fakeBin, "pi-models"), "utf8"))).toEqual({
        providers: { bridged: { modelOverrides: { "coder-3": { contextWindow: 400000 } } } }
      })
      expect((await readFile(join(fixture.fakeBin, "pi-account-dir"), "utf8")).trim()).toBe("/accounts/main")
      expect(await Bun.file(join(fixture.fakeBin, "nono-calls")).exists()).toBe(false)
    })
  }, 60_000)

  test("probes the model windows with the packages loaded and allowed to install instead of offline without extensions", async () => {
    await withNoSandboxFixture(async (fixture) => {
      await asPackageRun(fixture)
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], fixture.repo, fixture.env)
      expect(result.exitCode).toBe(0)
      const probes = (await readFile(join(fixture.fakeBin, "probe-argv"), "utf8")).split("\n").filter((line) => line !== "")
      expect(probes.length).toBeGreaterThan(0)
      for (const probe of probes) {
        const argv = probe.split(" ")
        expect(argv).not.toContain("--no-extensions")
        expect(argv).not.toContain("--offline")
      }
    })
  }, 60_000)

  test("with a relative package path is refused before Pi runs instead of resolving it against the run folder", async () => {
    await withNoSandboxFixture(async (fixture) => {
      await asPackageRun(fixture, { ...packageProvider, packages: ["./pi-bridged"] })
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], fixture.repo, fixture.env)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain(join(fixture.env["ORC_HOME"] ?? "", "config.json"))
      expect(await Bun.file(join(fixture.fakeBin, "pi-cwd")).exists()).toBe(false)
    })
  }, 60_000)

  test("with --token-file is refused before Pi runs instead of dropping the token", async () => {
    await withNoSandboxFixture(async (fixture) => {
      await asPackageRun(fixture)
      const tokenFile = await writeToken(fixture, "stray-token", 0o600)
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none", "--token-file", tokenFile], fixture.repo, fixture.env)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("--token-file")
      expect(await Bun.file(join(fixture.fakeBin, "pi-cwd")).exists()).toBe(false)
    })
  }, 60_000)

  test("in the nono sandbox is refused before Pi runs, naming --sandbox none", async () => {
    await withNoSandboxFixture(async (fixture) => {
      await asPackageRun(fixture)
      const result = await runOrc(["run", "task.md", "--branch", "orc/test"], fixture.repo, fixture.env)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("--sandbox none")
      expect(await Bun.file(join(fixture.fakeBin, "pi-cwd")).exists()).toBe(false)
    })
  }, 60_000)
})

const withQuietPi = async (fixture: NoSandboxFixture, quietSeconds: number): Promise<void> => {
  const piPath = join(fixture.fakeBin, "pi")
  const loudPi = join(fixture.fakeBin, "loud-pi")
  await writeFile(loudPi, await readFile(piPath))
  await chmod(loudPi, 0o755)
  await writeScript(piPath, ["if [ \"$1\" = -p ]; then sleep " + quietSeconds.toString() + "; fi", "exec \"" + loudPi + "\" \"$@\""])
}

describe("orc run idle limit", () => {
  test("a Pi quiet past ORC_IDLE_TIMEOUT_SECONDS ends the run as idle instead of waiting on it", async () => {
    await withNoSandboxFixture(async (fixture) => {
      await withQuietPi(fixture, 4)
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], fixture.repo, { ...fixture.env, ORC_IDLE_TIMEOUT_SECONDS: "1" })
      expect(result.exitCode).toBe(1)
      expect(result.stdout + result.stderr).toContain("idle for 1 second")
    })
  }, 60_000)

  test("a Pi quiet for less than ORC_IDLE_TIMEOUT_SECONDS runs on to its PR instead of being ended as idle", async () => {
    await withNoSandboxFixture(async (fixture) => {
      await withQuietPi(fixture, 2)
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], fixture.repo, { ...fixture.env, ORC_IDLE_TIMEOUT_SECONDS: "30" })
      expect({ exitCode: result.exitCode, stdout: result.stdout }).toEqual({ exitCode: 0, stdout: expect.stringContaining(prUrl) })
    })
  }, 60_000)

  test("an ORC_IDLE_TIMEOUT_SECONDS that is not a number of seconds is refused before Pi runs instead of read as zero", async () => {
    await withNoSandboxFixture(async (fixture) => {
      const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], fixture.repo, { ...fixture.env, ORC_IDLE_TIMEOUT_SECONDS: "45m" })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("ORC_IDLE_TIMEOUT_SECONDS is 45m")
      expect(await Bun.file(join(fixture.fakeBin, "pi-cwd")).exists()).toBe(false)
    })
  }, 60_000)
})
