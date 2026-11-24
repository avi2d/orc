import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { skipReason } from "@avi2dg/checks/scripts/test-skips.ts"
import { fetchPinnedNoMistakes } from "./no-mistakes-release"
import { git, loginProvider, runOrc, writeConfig, writeScript } from "./no-sandbox-fixture"

const inCi = Bun.env.GITHUB_ACTIONS === "true"
const pathBinary = Bun.which("no-mistakes")
const noMistakes = pathBinary ?? (inCi ? await fetchPinnedNoMistakes() : null)

const refused = ["bun test", "bun run test", "bunx vitest", "npm test", "npx jest"]
const permitted = ["bun run build", "bun run lint", "bun run typecheck"]
const fakeTools = ["bun", "bunx", "npm", "npx"]

const quote = (word: string): string => "'" + word.replaceAll("'", "'\\''") + "'"

interface AgentProbe {
  readonly attempts: ReadonlyArray<string>
  readonly refusals: ReadonlyArray<string>
  readonly starts: ReadonlyArray<string>
  readonly agentEnv: string
}

const lines = async (file: string): Promise<ReadonlyArray<string>> =>
  (await readFile(file, "utf8").catch(() => "")).split("\n").filter((line) => line !== "")

// The probe runs on the agent's first start only, so a retry of the failed agent cannot append a second round.
const probeScript = (fakeBin: string): ReadonlyArray<string> => [
  "[ -f " + quote(join(fakeBin, "probed")) + " ] && exit 1",
  ...[...refused, ...permitted].map((command) => [
    command + " > /dev/null 2>> " + quote(join(fakeBin, "refusals")),
    "printf '%s %s\\n' \"$?\" " + quote(command) + " >> " + quote(join(fakeBin, "attempts"))
  ].join("\n")),
  "printf '%s\\n' \"HEAVY_TESTS_CI_ONLY=$HEAVY_TESTS_CI_ONLY\" > " + quote(join(fakeBin, "agent-env")),
  "touch " + quote(join(fakeBin, "probed")),
  "exit 1"
]

const driveReviewAgent = async (binary: string, wrapped: boolean): Promise<AgentProbe> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orc-nm-agent-")))
  const fakeBin = join(root, "bin")
  const repo = join(root, "repo")
  const origin = join(root, "origin.git")
  const nmHome = join(root, "nm")
  const env: Record<string, string> = {
    PATH: fakeBin + ":/usr/bin:/bin",
    HOME: join(root, "home"),
    ORC_HOME: join(root, "orc-home"),
    NM_HOME: nmHome,
    GIT_CONFIG_NOSYSTEM: "1"
  }
  await Promise.all([mkdir(fakeBin), mkdir(repo), mkdir(nmHome), mkdir(env["HOME"] ?? "")])
  for (const tool of fakeTools) {
    await writeScript(join(fakeBin, tool), ["printf '%s\\n' " + quote(tool) + "\" $*\" >> " + quote(join(fakeBin, "starts"))])
  }
  await writeScript(join(fakeBin, "pi"), probeScript(fakeBin))
  await writeConfig(env, { providers: [loginProvider], models: { implementer: "acme-go/coder-1", fixer: "acme-go/coder-1" }, heavy: { through: ["env"], limit: "none" } })
  const heavyPath = await runOrc(["heavy", "path"], root, env)
  expect(heavyPath.exitCode, heavyPath.stderr).toBe(0)
  const agent = wrapped ? join(env["ORC_HOME"] ?? "", "heavy", "agents", "pi") : join(fakeBin, "pi")
  await writeFile(join(nmHome, "config.yaml"), "agent: pi\nagent_path_override:\n  pi: " + JSON.stringify(agent) + "\n")
  git(root, ["init", "-q", "--bare", origin], env)
  git(repo, ["init", "-q", "-b", "main"], env)
  git(repo, ["config", "user.name", "orc test"], env)
  git(repo, ["config", "user.email", "orc@test.invalid"], env)
  await writeFile(join(repo, "greeting.ts"), "export const greeting = \"hello\"\n")
  git(repo, ["add", "greeting.ts"], env)
  git(repo, ["commit", "-qm", "init"], env)
  git(repo, ["remote", "add", "origin", origin], env)
  git(repo, ["push", "-q", "origin", "main"], env)
  const daemon = Bun.spawn([binary, "daemon", "run", "--root", nmHome], { cwd: root, env, stdout: "ignore", stderr: "ignore" })
  try {
    const init = Bun.spawnSync([binary, "init"], { cwd: repo, env })
    expect(init.exitCode, init.stderr.toString() + init.stdout.toString()).toBe(0)
    git(repo, ["checkout", "-q", "-b", "greeting"], env)
    await writeFile(join(repo, "greeting.ts"), "export const greeting = \"hello, reviewer\"\n")
    git(repo, ["commit", "-qam", "Greet the reviewer"], env)
    const run = Bun.spawn([binary, "axi", "run", "--intent", "Greet the reviewer", "--skip", "rebase,test,lint,document", "--wait", "60s"], {
      cwd: repo, env, stdout: "pipe", stderr: "pipe"
    })
    const [runOut, runErr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
    const probed = await Bun.file(join(fakeBin, "probed")).exists()
    expect(probed, "no-mistakes never started the review agent:\n" + runOut + runErr).toBe(true)
    return {
      attempts: await lines(join(fakeBin, "attempts")),
      refusals: await lines(join(fakeBin, "refusals")),
      starts: await lines(join(fakeBin, "starts")),
      agentEnv: (await readFile(join(fakeBin, "agent-env"), "utf8")).trim()
    }
  } finally {
    daemon.kill()
    await daemon.exited
    await rm(root, { recursive: true, force: true })
  }
}

const missingBinary = noMistakes === null

test.skipIf(missingBinary)(skipReason("needs a no-mistakes binary on PATH", "a real no-mistakes daemon's pi agent behind orc's wrapper never starts bun test, bun run test, bunx vitest, npm test or npx jest, yet still runs build, lint and typecheck", "local"), async () => {
  expect(noMistakes, "the e2e tier fetches the pinned no-mistakes in GitHub Actions").not.toBeNull()
  const probe = await driveReviewAgent(noMistakes ?? "", true)
  expect(probe.agentEnv).toBe("HEAVY_TESTS_CI_ONLY=1")
  expect(probe.attempts).toEqual([...refused.map((command) => "1 " + command), ...permitted.map((command) => "0 " + command)])
  expect(probe.refusals).toEqual(refused.map((command) => "orc heavy: " + command + " starts a test run, and with HEAVY_TESTS_CI_ONLY=1 the repository tests run only in GitHub CI"))
  expect(probe.starts).toEqual(permitted)
}, 90_000)

test.skipIf(missingBinary)(skipReason("needs a no-mistakes binary on PATH", "a real no-mistakes daemon's pi agent without orc's wrapper starts every test runner, so the wrapper is what refuses them", "local"), async () => {
  expect(noMistakes, "the e2e tier fetches the pinned no-mistakes in GitHub Actions").not.toBeNull()
  const probe = await driveReviewAgent(noMistakes ?? "", false)
  expect(probe.agentEnv).toBe("HEAVY_TESTS_CI_ONLY=")
  expect(probe.attempts).toEqual([...refused, ...permitted].map((command) => "0 " + command))
  expect(probe.starts).toEqual([...refused, ...permitted])
}, 90_000)
