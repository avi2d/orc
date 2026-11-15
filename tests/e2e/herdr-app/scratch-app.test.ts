import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const launcher = join(import.meta.dir, "..", "..", "..", "packages", "herdr-app", "scripts", "with-scratch-app.sh")

const openStub = `#!/bin/bash
printf '%s\\n' "$@" > "$STUB_OPEN_ARGS"
pairs=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -a) bundle=$2; shift 2 ;;
    --env) pairs+=("$2"); shift 2 ;;
    --stdout | --stderr) shift 2 ;;
    *) shift ;;
  esac
done
nohup env -i "\${pairs[@]}" "$bundle/Contents/MacOS/Herdr" >/dev/null 2>&1 &
`

const lsofStub = `#!/bin/bash
if [ "$1" = -t ] && [ "$2" = "$HERDR_APP_HOME/herdr-app.sock" ]; then cat "$STUB_APP_PID" 2>/dev/null; exit 0; fi
if [ "$1" = -t ] && [ "$2" = "$HC_SOCKET" ]; then exit 1; fi
exit 1
`

const appStub = `#!/bin/bash
echo $$ > "$STUB_APP_PID"
for tick in $(seq 1 120); do sleep 0.5; done
`

interface Stage {
  readonly root: string
  readonly env: Record<string, string>
  readonly appPidFile: string
  readonly openArgsFile: string
}

const executable = async (path: string, body: string): Promise<void> => {
  await writeFile(path, body)
  await chmod(path, 0o755)
}

const stage = async (coreInstalled: boolean): Promise<Stage> => {
  const root = await mkdtemp(join(tmpdir(), "orc-scratch-app-"))
  const bin = join(root, "bin")
  const macos = join(root, "Herdr.app", "Contents", "MacOS")
  const coreDir = join(root, "core")
  await mkdir(bin)
  await mkdir(macos, { recursive: true })
  await mkdir(coreDir)
  await mkdir(join(root, "home"))
  await executable(join(bin, "open"), openStub)
  await executable(join(bin, "lsof"), lsofStub)
  await executable(join(macos, "Herdr"), appStub)
  if (coreInstalled) await executable(join(coreDir, "herdr-core"), "#!/bin/bash\nexit 0\n")
  const appPidFile = join(root, "app.pid")
  const openArgsFile = join(root, "open.args")
  return {
    root,
    appPidFile,
    openArgsFile,
    env: {
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      HOME: join(root, "home"),
      HC_SOCKET: join(root, "c.sock"),
      HERDR_APP_BUNDLE: join(root, "Herdr.app"),
      HERDR_CORE_DIRS: coreDir,
      STUB_APP_PID: appPidFile,
      STUB_OPEN_ARGS: openArgsFile
    }
  }
}

const launch = async (env: Record<string, string>): Promise<{ readonly code: number; readonly stderr: string; readonly seconds: number }> => {
  const started = Date.now()
  const child = Bun.spawn([launcher, "true"], { env, stdout: "ignore", stderr: "pipe" })
  const stderr = await new Response(child.stderr).text()
  const code = await child.exited
  return { code, stderr, seconds: (Date.now() - started) / 1000 }
}

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("does not start the App when HERDR_CORE_DIRS holds no herdr-core", async () => {
  const staged = await stage(false)
  try {
    const result = await launch(staged.env)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("herdr-core not found in HERDR_CORE_DIRS")
    expect(await Bun.file(staged.openArgsFile).exists()).toBe(false)
  } finally {
    await rm(staged.root, { recursive: true, force: true })
  }
}, 30000)

test("times out after 35 seconds when the herdr-core socket never appears", async () => {
  const staged = await stage(true)
  try {
    const result = await launch(staged.env)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("timed out waiting 35 seconds for the herdr-core socket")
    expect(result.stderr).toContain(staged.env["HC_SOCKET"])
    expect(result.stderr).toContain("HERDR_CORE_DIRS=")
    expect(result.seconds).toBeLessThan(70)
    const appPid = Number((await readFile(staged.appPidFile, "utf8")).trim())
    await Bun.sleep(500)
    expect(isRunning(appPid)).toBe(false)
  } finally {
    await rm(staged.root, { recursive: true, force: true })
  }
}, 120000)

test("does not start the App in the foreground", async () => {
  const staged = await stage(true)
  try {
    await launch(staged.env)
    const args = (await readFile(staged.openArgsFile, "utf8")).split("\n")
    expect(args).toContain("-g")
  } finally {
    await rm(staged.root, { recursive: true, force: true })
  }
}, 120000)
