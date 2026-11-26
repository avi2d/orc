import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import * as fc from "fast-check"
import { ciOnlyBashScript, quoteSingle } from "../../../packages/run/src/entities/heavy-queue/heavy-standin"
import { setup, type Harness } from "./heavy-standin-harness"

type Words = ReadonlyArray<string>

const pullRequestSeed = 20261125
const seed = Bun.env.GITHUB_EVENT_NAME === "pull_request" ? pullRequestSeed : Math.floor(Math.random() * 2 ** 31)

const standinTools: Words = [
  "bun", "bunx", "npm", "npx", "pnpm", "yarn", "vitest", "jest", "pytest", "playwright", "checks-test",
  "go", "cargo", "node", "python", "python3", "uv", "make", "deno"
]
const projectBins: Words = ["vitest", "jest", "pytest", "playwright", "checks-test", "bunx", "npx", "npm", "pnpm", "yarn"]
const projectBinFolders: Words = ["node_modules/.bin", "packages/web/node_modules/.bin"]

const runnerArgs = fc.array(
  fc.constantFrom("run", "-t", "login", "src/login.test.ts", "tests/unit", "--coverage", "--reporter=dot", "--watch", "-x", "--"),
  { maxLength: 3 }
)

const runner: fc.Arbitrary<Words> = fc.oneof(
  fc.tuple(fc.constantFrom("vitest", "jest", "checks-test", "pytest"), runnerArgs).map(([name, args]) => [name, ...args]),
  runnerArgs.map((args) => ["playwright", "test", ...args])
)

const versioned = (call: Words, version: string): Words => [(call[0] ?? "") + version, ...call.slice(1)]

const launched: fc.Arbitrary<Words> = fc.tuple(
  runner,
  fc.constantFrom("", "@latest", "@3.2.4"),
  fc.constantFrom<Words>(
    ["bunx"], ["bunx", "--bun"], ["bunx", "--package", "pkg"], ["npx"], ["npx", "-y"], ["npx", "--yes", "-p", "pkg"],
    ["bun", "x"], ["npm", "exec", "--"], ["npm", "--prefix", "pkg", "exec"], ["pnpm", "exec"], ["pnpm", "dlx"],
    ["pnpm", "--filter", "web", "exec"], ["yarn", "dlx"], ["yarn", "exec"]
  )
).map(([call, version, launcher]) => [...launcher, ...versioned(call, version)])

const managerOptions = {
  bun: [[], ["--cwd", "pkg"], ["--filter", "web"]],
  npm: [[], ["--prefix", "pkg"], ["-w", "web"]],
  pnpm: [[], ["-C", "pkg"], ["--filter", "web"], ["-r"]],
  yarn: [[], ["--cwd", "pkg"], ["workspace", "web"]]
} satisfies Record<"bun" | "npm" | "pnpm" | "yarn", ReadonlyArray<Words>>

const scriptCall: fc.Arbitrary<Words> = fc.constantFrom("bun", "npm", "pnpm", "yarn").chain((manager) =>
  fc.tuple(
    fc.constantFrom<Words>(...managerOptions[manager]),
    fc.constantFrom("test", "tests", "test:unit", "test:e2e", "e2e", "e2e:ci", "vitest", "jest", "pytest", ...(manager === "npm" ? ["t"] : [])),
    fc.constantFrom<Words>([], ["run"], ...(manager === "npm" ? [["run-script"]] : [])),
    runnerArgs
  ).map(([options, script, form, args]) => [manager, ...options, ...form, script, ...args])
)

const otherRunner: fc.Arbitrary<Words> = fc.oneof(
  runnerArgs.map((args) => ["go", "test", ...args]),
  fc.tuple(fc.constantFrom("test", "t"), runnerArgs).map(([sub, args]) => ["cargo", sub, ...args]),
  fc.tuple(fc.constantFrom("python", "python3"), fc.constantFrom<Words>([], ["-B"], ["-W", "ignore"]), runnerArgs)
    .map(([python, flags, args]) => [python, ...flags, "-m", "pytest", ...args]),
  fc.tuple(fc.constantFrom<Words>([], ["--with", "pytest-cov"], ["--project", "sub"]), fc.constantFrom<Words>(["pytest"], ["python", "-m", "pytest"]), runnerArgs)
    .map(([options, call, args]) => ["uv", "run", ...options, ...call, ...args]),
  runnerArgs.map((args) => ["node", "--test", ...args]),
  runnerArgs.map((args) => ["deno", "test", ...args]),
  fc.tuple(fc.constantFrom<Words>([], ["-C", "sub"], ["-j4"]), fc.constantFrom("test", "check")).map(([options, target]) => ["make", ...options, target])
)

const programWrappers: ReadonlyArray<Words> = [
  ["env"], ["env", "CI=1"], ["env", "FORCE_COLOR=0", "NODE_ENV=test"], ["/usr/bin/env"], ["nice"], ["nohup"], ["timeout", "600"],
  ["sh", "-c"], ["bash", "-c"]
]

const shellPrefixes: Words = ["", "CI=1 ", "exec ", "command ", "true && ", "FORCE_COLOR=0 exec "]

const wrap = (words: Words, wrappers: ReadonlyArray<Words>): string =>
  wrappers.reduce(
    (line, wrapper) => wrapper[1] === "-c" ? wrapper.join(" ") + " " + quoteSingle(line) : wrapper.join(" ") + " " + line,
    words.join(" ")
  )

const rootWord = "@ROOT@"

const pathCall: fc.Arbitrary<Words> = fc.tuple(
  fc.oneof(runner, launched, scriptCall).filter((call) => projectBins.includes(call[0] ?? "")),
  fc.constantFrom("", "./", rootWord + "/"),
  fc.constantFrom(...projectBinFolders),
  fc.constantFrom("", "\"", "'")
).map(([call, start, folder, quote]) => [quote + start + folder + "/" + (call[0] ?? "") + quote, ...call.slice(1)])

const commandLine: fc.Arbitrary<string> = fc.tuple(
  fc.oneof(runner, launched, scriptCall, otherRunner, pathCall),
  fc.array(fc.constantFrom(...programWrappers), { maxLength: 3 }),
  fc.constantFrom(...shellPrefixes),
  fc.boolean()
).map(([call, wrappers, prefix, nested]) => {
  const line = prefix + wrap(call, wrappers)
  return nested ? "bash -c " + quoteSingle(line) : line
})

describe("CI-only refusal of generated test command lines", () => {
  let harness: Harness

  beforeAll(async () => {
    harness = await setup(standinTools)
    await writeFile(join(harness.root, "ci-only.bash"), ciOnlyBashScript())
    for (const folder of projectBinFolders) {
      await mkdir(join(harness.root, folder), { recursive: true })
      for (const tool of projectBins) {
        await writeFile(join(harness.root, folder, tool), "#!/bin/sh\necho \"real $0 $*\" >> \"$FAKE_TOOL_LOG\"\n", { mode: 0o755 })
      }
    }
  })

  afterAll(async () => {
    await rm(harness.root, { recursive: true, force: true })
  })

  test("every generated line that reaches a test runner exits 1 with an orc heavy refusal and starts no runner, seed " + seed, () => {
    const toolLog = harness.env.FAKE_TOOL_LOG
    fc.assert(
      fc.property(commandLine, (line) => {
        rmSync(toolLog, { force: true })
        const child = Bun.spawnSync(["/bin/bash", "-c", line.replaceAll(rootWord, harness.root)], {
          cwd: harness.root,
          env: { ...harness.env, PWD: harness.root, BASH_ENV: join(harness.root, "ci-only.bash"), HEAVY_TESTS_CI_ONLY: "1", HEAVY_QUEUE_UNREACHABLE: "1" },
          stdout: "pipe",
          stderr: "pipe"
        })
        const started = (() => {
          try {
            return readFileSync(toolLog, "utf8")
          } catch {
            return ""
          }
        })()
        expect({ line, code: child.exitCode, started }).toEqual({ line, code: 1, started: "" })
        expect(child.stderr.toString()).toContain("orc heavy: ")
      }),
      { seed, numRuns: 60 }
    )
  }, 180_000)
})
