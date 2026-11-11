import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { skipReason } from "@avi2dg/checks/scripts/test-skips.ts"
import { NonoProviderError } from "../../packages/run/src/shared/sandbox/host"
import type { NonoExecOptions } from "../../packages/run/src/shared/sandbox/nono-exec"
import { makeNonoFixtureDir } from "../lib/nono-home"
import { nonoOpenError, type NonoShellRun, runNonoShell, withNonoShell } from "../lib/nono-shell"

// Nesting a nono sandbox is forbidden inside an already-sandboxed macOS session, so these run on demand:
//   ORC_NONO_E2E=1 bun run test:live
const liveSandbox = Bun.env.ORC_NONO_E2E === "1"

const sentinelAuthorization = `Basic ${btoa("orc-live:orc-live-sentinel-credential")}`

const credentialEnv = {
  GH_TOKEN: "orc-live-sentinel-gh-token",
  GITHUB_TOKEN: "orc-live-sentinel-github-token",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: ${sentinelAuthorization}`
}

const fixtureHome = await makeNonoFixtureDir("orc-nono-home-")
await writeFile(join(fixtureHome, ".gitconfig"), "")
const fixtureGitEnv = { PATH: Bun.env.PATH ?? "", HOME: fixtureHome, GIT_CONFIG_GLOBAL: join(fixtureHome, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" }

afterAll(async () => {
  await rm(fixtureHome, { recursive: true, force: true })
})

const runGit = async (
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string> = fixtureGitEnv
): Promise<{ exitCode: number; output: string }> => {
  const proc = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  return { exitCode, output: `${stdout}${stderr}` }
}

const gitOrThrow = async (args: ReadonlyArray<string>, cwd: string): Promise<void> => {
  const result = await runGit(args, cwd)
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.output}`)
  }
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const cgiResponse = (output: Uint8Array): Response => {
  const text = new TextDecoder("latin1").decode(output)
  const separator = text.indexOf("\r\n\r\n")
  const headers = new Headers()
  let status = 200
  for (const line of text.slice(0, separator).split("\r\n")) {
    const colon = line.indexOf(":")
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (name.toLowerCase() === "status") {
      status = Number.parseInt(value, 10)
    } else {
      headers.append(name, value)
    }
  }
  return new Response(output.slice(separator + 4), { status, headers })
}

describe("the nono exec", () => {
  let root = ""
  let copy = ""
  let outside = ""
  let session = ""
  let remoteRoot = ""
  let remoteUrl = ""
  let unauthorizedRequests = 0
  let server: ReturnType<typeof Bun.serve> | null = null

  const sandboxAt = (hostEnv: Readonly<Record<string, string>>, piSessionDir = session): NonoExecOptions => ({
    worktree: copy,
    piSessionDir,
    sessionsDir: piSessionDir,
    hostEnv: { ...Bun.env, ...hostEnv },
    env: {}
  })

  const sandbox = (): NonoExecOptions => sandboxAt({ ...credentialEnv, HOME: fixtureHome, NONO_ALLOW: outside })

  const execOrThrow = (command: string, run?: NonoShellRun) => runNonoShell(sandbox(), command, run)

  const serveGitBehindCredential = async (request: Request): Promise<Response> => {
    if (request.headers.get("authorization") !== sentinelAuthorization) {
      unauthorizedRequests += 1
      return new Response("credential required\n", { status: 401, headers: { "WWW-Authenticate": "Basic realm=\"orc-live\"" } })
    }
    const url = new URL(request.url)
    const body = new Uint8Array(await request.arrayBuffer())
    const backend = Bun.spawn(["git", "http-backend"], {
      env: {
        PATH: Bun.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_PROJECT_ROOT: remoteRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "orc-live",
        REQUEST_METHOD: request.method,
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers.get("content-type") ?? "",
        CONTENT_LENGTH: String(body.length),
        HTTP_CONTENT_ENCODING: request.headers.get("content-encoding") ?? ""
      },
      stdin: body,
      stdout: "pipe"
    })
    const output = new Uint8Array(await new Response(backend.stdout).arrayBuffer())
    await backend.exited
    return cgiResponse(output)
  }

  beforeAll(async () => {
    if (!liveSandbox) {
      return
    }
    root = await mkdtemp(join(tmpdir(), "orc-nono-live-"))
    outside = await makeNonoFixtureDir("orc-nono-outside-")
    copy = join(root, "copy")
    session = join(root, "session")
    remoteRoot = join(root, "remote")
    await mkdir(copy, { recursive: true })
    await mkdir(session, { recursive: true })
    await mkdir(remoteRoot, { recursive: true })
    await gitOrThrow(["init", "-q", "--bare", "repo.git"], remoteRoot)
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: serveGitBehindCredential })
    remoteUrl = `http://127.0.0.1:${server.port}/repo.git`
    await gitOrThrow(["init", "-q"], copy)
    await gitOrThrow(["config", "user.email", "orc-live@example.com"], copy)
    await gitOrThrow(["config", "user.name", "orc live"], copy)
    await writeFile(join(copy, "seed.txt"), "seed\n")
    await gitOrThrow(["add", "-A"], copy)
    await gitOrThrow(["commit", "-qm", "seed"], copy)
    await gitOrThrow(["remote", "add", "origin", remoteUrl], copy)
  })

  afterAll(async () => {
    await server?.stop(true)
    for (const dir of [root, outside]) {
      if (dir !== "") {
        await rm(dir, { recursive: true, force: true })
      }
    }
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "writes inside the isolated copy"), async () => {
    const result = await execOrThrow("touch probe-inside && echo wrote-ok")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("wrote-ok\n")
    expect(await exists(join(copy, "probe-inside"))).toBe(true)
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "runs bun, git and the system shell"), async () => {
    const result = await execOrThrow("/bin/sh -c 'echo shell-ok' && git --version && bun --version")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(`shell-ok\ngit version ${(await runGit(["--version"], copy)).output.trim().replace("git version ", "")}\n${Bun.version}\n`)
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "runs the host's node and Pi, whose files live outside the roots"), async () => {
    const host = Bun.spawnSync(["sh", "-c", "node --version && pi --version"], { env: fixtureGitEnv })
    const result = await execOrThrow("node --version && pi --version")
    expect({ exitCode: result.exitCode, stdout: result.stdout }).toEqual({ exitCode: 0, stdout: host.stdout.toString() })
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "runs the system git in /usr/bin"), async () => {
    const result = await execOrThrow("/usr/bin/git --version")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toStartWith("git version ")
    expect(result.stderr).not.toContain("couldn't create cache file")
  }, 15_000)

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "reads none of the user's git configs, by their own path or the Data volume's"), async () => {
    const home = await makeNonoFixtureDir("orc-nono-home-")
    const configs = [join(home, ".gitconfig"), join(home, ".config", "git", "config")]
    await mkdir(join(home, ".config", "git"), { recursive: true })
    for (const config of configs) {
      await writeFile(config, `[http]\n\textraHeader = Authorization: ${sentinelAuthorization}\n`)
    }
    try {
      for (const config of [...configs, ...configs.map((path) => `/System/Volumes/Data${path}`)]) {
        const result = await runNonoShell(sandboxAt({ HOME: home }), `cat -- ${JSON.stringify(config)}`)
        expect({ config, exitCode: result.exitCode, stdout: result.stdout }).toEqual({ config, exitCode: 1, stdout: "" })
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "lets the agent write its own global git config"), async () => {
    for (const command of [
      `git config --global --add safe.directory "${copy}"`,
      `git config --global user.name "orc agent"`,
      `git config --global user.email "orc@example.com"`
    ]) {
      const result = await execOrThrow(command)
      expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 })
    }
    expect((await execOrThrow("git config --global user.name")).stdout).toBe("orc agent\n")
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "streams stdout lines to onLine"), async () => {
    const seen: Array<string> = []
    const result = await execOrThrow("printf 'one\\ntwo\\n'", { onLine: (line) => seen.push(line) })
    expect(result.exitCode).toBe(0)
    expect(seen).toEqual(["one", "two"])
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "returns stdout verbatim"), async () => {
    const result = await execOrThrow("printf 'a\\r\\nb'")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("a\r\nb")
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "writes inside the git data and the Pi session folder"), async () => {
    const committed = await execOrThrow("touch probe-commit && git add probe-commit && git commit -qm live-proof && echo committed")
    expect(committed.exitCode).toBe(0)
    expect(committed.stdout).toBe("committed\n")
    const sessionWrite = await execOrThrow(`touch ${session}/probe && echo session-ok`)
    expect(sessionWrite.exitCode).toBe(0)
    expect(await exists(join(session, "probe"))).toBe(true)
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "gives commands a temp dir inside the session folder"), async () => {
    const result = await execOrThrow("touch \"$TMPDIR/probe\" && printf %s \"$TMPDIR\"")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(join(await realpath(session), "tmp"))
    expect(await exists(join(session, "tmp", "probe"))).toBe(true)
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "pipes stdin to the command verbatim"), async () => {
    const result = await execOrThrow("cat", { stdin: "hello\r\nstdin\n" })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("hello\r\nstdin\n")
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "refuses a write outside the copy, even with NONO_ALLOW in the env"), async () => {
    const target = join(outside, "must-not-exist")
    const result = await execOrThrow(`touch ${target} && echo escaped`)
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).not.toContain("escaped")
    expect(await exists(target)).toBe(false)
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "refuses a write to the system temp directories"), async () => {
    for (const dir of ["/tmp", tmpdir()]) {
      const target = join(dir, `orc-nono-escape-${crypto.randomUUID()}`)
      const result = await execOrThrow(`touch ${target} && echo escaped`)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain("escaped")
      expect(await exists(target)).toBe(false)
    }
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "refuses a connection to a host Unix socket, the way a container daemon is reached"), async () => {
    const socketPath = join(root, "host.sock")
    let connections = 0
    const firstConnection = Promise.withResolvers<void>()
    const listener = Bun.listen({
      unix: socketPath,
      socket: {
        open: () => {
          connections += 1
          firstConnection.resolve()
        },
        data: () => {}
      }
    })
    try {
      const control = await Bun.connect({ unix: socketPath, socket: { data: () => {} } })
      control.end()
      await firstConnection.promise
      const result = await execOrThrow(`bun -e 'console.log("started"); await Bun.connect({ unix: "${socketPath}", socket: { data() {} } }); console.log("connected"); process.exit(0)'`)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe("started\n")
      expect(connections).toBe(1)
    } finally {
      listener.stop(true)
    }
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "still resolves host names through the system resolver"), async () => {
    const result = await execOrThrow(`bun -e 'import { lookup } from "node:dns/promises"; console.log((await lookup("example.com")).family)'`)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^[46]\n$/)
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "no host credential reaches the command"), async () => {
    const result = await execOrThrow("env; git config --list")
    expect(result.exitCode).toBe(0)
    const sentinels = [...Object.values(credentialEnv).filter((value) => value !== "1"), sentinelAuthorization]
    for (const sentinel of sentinels) {
      expect(result.stdout).not.toContain(sentinel)
    }
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "refuses git push for want of the credential a host push uses"), async () => {
    const control = await runGit(["push", "-q", remoteUrl, "HEAD:refs/heads/host-control"], copy, {
      ...fixtureGitEnv,
      ...credentialEnv
    })
    expect(control).toEqual({ exitCode: 0, output: "" })
    const unauthorizedBefore = unauthorizedRequests
    const result = await execOrThrow("git push origin HEAD:refs/heads/orc-live-probe")
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/could not read Username|Authentication failed/)
    expect(unauthorizedRequests).toBeGreaterThan(unauthorizedBefore)
    const refs = await runGit(["for-each-ref", "--format=%(refname)"], join(remoteRoot, "repo.git"))
    expect(refs.output).toBe("refs/heads/host-control\n")
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "a user default profile that grants another write path does not widen the sandbox"), async () => {
    const home = await makeNonoFixtureDir("orc-nono-home-")
    await mkdir(join(home, ".config", "nono", "profiles"), { recursive: true })
    await writeFile(
      join(home, ".config", "nono", "profiles", "default.json"),
      JSON.stringify({ meta: { name: "default", description: "widens" }, filesystem: { allow: [outside] } })
    )
    try {
      const target = join(outside, "widened-probe")
      const result = await runNonoShell(sandboxAt({ HOME: home }), `touch ${target} && echo escaped`)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain("escaped")
      expect(await exists(target)).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "swapping the git data for a symlink to outside retargets no grant"), async () => {
    try {
      const target = join(outside, "retargeted-probe")
      const [swapped, result] = await withNonoShell(sandbox(), async (shell) => [
        await shell(`mv .git .git-moved && ln -s ${outside} .git && echo swapped`),
        await shell("touch .git/retargeted-probe && echo escaped")
      ])
      expect(swapped.stdout).toBe("swapped\n")
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain("escaped")
      expect(await exists(target)).toBe(false)
    } finally {
      await rm(join(copy, ".git"), { force: true })
      if (await exists(join(copy, ".git-moved"))) {
        await rename(join(copy, ".git-moved"), join(copy, ".git"))
      }
    }
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "a nono planted on the caller's PATH is never run on the host"), async () => {
    const plantedDir = join(copy, "planted-bin")
    const marker = join(outside, "planted-ran")
    await mkdir(plantedDir, { recursive: true })
    await writeFile(join(plantedDir, "nono"), `#!/bin/sh\ntouch ${marker}\necho planted\n`)
    await chmod(join(plantedDir, "nono"), 0o755)
    try {
      const result = await runNonoShell(sandboxAt({ HOME: fixtureHome, PATH: `${plantedDir}:${Bun.env.PATH ?? ""}` }), "echo sandboxed")
      expect(result.stdout).toBe("sandboxed\n")
      expect(await exists(marker)).toBe(false)
    } finally {
      await rm(plantedDir, { recursive: true, force: true })
    }
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "a linked task copy commits into the main checkout's git data but cannot write the main checkout's files"), async () => {
    const main = join(root, "main")
    const linked = join(root, "linked")
    await mkdir(main)
    await gitOrThrow(["init", "-q", "-b", "main"], main)
    await writeFile(join(main, "kept.txt"), "kept\n")
    await gitOrThrow(["add", "-A"], main)
    await gitOrThrow(["-c", "user.name=orc live", "-c", "user.email=orc-live@example.com", "commit", "-qm", "seed"], main)
    await gitOrThrow(["worktree", "add", "-q", "-b", "orc/live", linked], main)
    const result = await runNonoShell({ ...sandbox(), worktree: linked }, [
      "echo work > work.txt",
      "git add work.txt && git -c user.name=a -c user.email=a@example.com commit -qm work && echo committed",
      `echo overwritten > "${join(main, "kept.txt")}" 2>/dev/null || echo refused`
    ].join("; "))
    expect(result.stdout).toBe("committed\nrefused\n")
    expect((await runGit(["log", "-1", "--format=%s", "orc/live"], main)).output).toBe("work\n")
    expect(await Bun.file(join(main, "kept.txt")).text()).toBe("kept\n")
  }, 15_000)

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "refuses a session folder that would hold its own profile"), async () => {
    const error = await nonoOpenError(sandboxAt({ HOME: fixtureHome }, tmpdir()))
    expect(error).toBeInstanceOf(NonoProviderError)
    if (error instanceof NonoProviderError) {
      expect(error.message).toContain("the sandbox could write")
    }
  })

  test.skipIf(!liveSandbox)(skipReason("needs a real nono sandbox outside any sandbox (ORC_NONO_E2E=1)", "an interrupted command stops with its background children instead of finishing later"), async () => {
    const lateMarkers = [join(copy, "late-foreground"), join(copy, "late-background")]
    const stop = new AbortController()
    const started = Promise.withResolvers<void>()
    const outcome = execOrThrow(`(trap '' TERM; sleep 2; touch "${lateMarkers[1]}") & trap '' TERM; echo started; sleep 2; touch "${lateMarkers[0]}"`, { signal: stop.signal, onLine: () => started.resolve() })
      .then(() => "resolved", () => "rejected")
    await started.promise
    stop.abort()
    expect(await outcome).toBe("rejected")
    await Bun.sleep(2500)
    expect(await Promise.all(lateMarkers.map(exists))).toEqual([false, false])
  })
})
