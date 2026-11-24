import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { git, loginProvider, prUrl, runOrc, withNoSandboxFixture, writeConfig, writeScript } from "./no-sandbox-fixture"

const forbidden = [
  "bun test", "bun test --watch", "bun run test", "bun run test:unit", "bun --cwd . run test",
  "bunx checks-test --changed", "bun x checks-test --tier=unit", "bun checks-test",
  "npx --yes checks-test", "npm exec -- checks-test", "pnpm exec checks-test",
  "pnpm dlx checks-test", "yarn exec checks-test", "xcrun checks-test",
  "bunx vitest run", "bun x jest", "npm test", "npm t", "npm run test:e2e",
  "npm --prefix . run test", "npm exec -- vitest run", "npx --yes jest",
  "pnpm test", "pnpm run test:unit", "pnpm exec pytest", "yarn test",
  "vitest run", "vitest --watch", "jest", "pytest", "playwright test", "go test ./...", "cargo test",
  "xcodebuild test", "xcodebuild -scheme Example test"
]
const permitted = [
  "bun run build", "npm run lint", "pnpm run typecheck", "playwright install",
  "bunx checks-lint", "bun x checks-lint", "bun checks-lint", "npx checks-lint",
  "npm exec -- checks-lint", "pnpm exec checks-lint", "pnpm dlx checks-lint",
  "yarn exec checks-lint", "xcrun checks-lint"
]
const tools = ["bun", "bunx", "npm", "npx", "pnpm", "yarn", "vitest", "jest", "pytest", "playwright", "go", "cargo", "xcodebuild", "xcrun"]

const quote = (word: string): string => "'" + word.replaceAll("'", "'\\''") + "'"

export const exerciseCiOnlyHostPi = async (): Promise<void> => {
  await withNoSandboxFixture(async ({ repo, fakeBin, env }) => {
    const starts = join(fakeBin, "process-starts")
    const attempts = join(fakeBin, "attempts")
    const errors = join(fakeBin, "refusals")
    const roundFile = join(fakeBin, "lint-round")
    const probe = [
      ...forbidden.map((command) => [
        command + " > /dev/null 2> " + quote(join(fakeBin, "last-error")),
        "printf '%s %s\\n' \"$?\" " + quote(command) + " >> " + quote(attempts),
        "cat " + quote(join(fakeBin, "last-error")) + " >> " + quote(errors)
      ].join("\n")),
      ...permitted.map((command) => command + " > /dev/null")
    ].join("\n")
    for (const tool of tools) {
      await writeScript(join(fakeBin, tool), ["printf '%s\\n' " + quote(tool) + '" $*" >> ' + quote(starts)])
    }
    await writeConfig(env, {
      providers: [loginProvider],
      models: { implementer: "acme-go/coder-1", fixer: "acme-go/coder-1" },
      heavy: { through: ["env"], limit: "none" }
    })
    await writeFile(join(repo, ".no-mistakes.yaml"), [
      "commands:",
      "  lint: sh " + join(fakeBin, "lint-check"),
      "  test: bun test",
      ""
    ].join("\n"))
    await writeScript(join(fakeBin, "lint-check"), [
      "n=$(cat " + quote(roundFile) + " 2>/dev/null || printf 0)",
      "n=$((n + 1)); echo \"$n\" > " + quote(roundFile),
      '[ "$n" -ge 3 ]'
    ])
    git(repo, ["commit", "-qam", "Configure worker probes"], env)
    const piFile = join(fakeBin, "pi")
    const pi = await readFile(piFile, "utf8")
    await writeFile(piFile, pi.replace("echo hello > greeting.txt", probe + "\necho hello >> greeting.txt"))
    await writeScript(join(fakeBin, "no-mistakes"), [
      'if [ "$1" = --version ]; then echo "no-mistakes version 1.111.0"; exit; fi',
      'case "$2" in',
      'run) printf "%s\\n" "gate: review" "findings[1]{id,severity,file,line,action,description}:" "  R1,warning,greeting.txt,1,auto-fix,revise greeting" ;;',
      'respond) printf "%s\\n" "pr: ' + prUrl + '" "outcome: checks-passed" ;;',
      "*) exit 2 ;;",
      "esac"
    ])
    const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], repo, env)
    assert.equal(result.exitCode, 0, result.stdout + result.stderr)
    assert.equal(result.stdout.includes(prUrl), true)
    const statuses = (await readFile(attempts, "utf8")).trim().split("\n")
    assert.deepEqual(statuses, Array.from({ length: 3 }, () => forbidden.map((command) => "127 " + command)).flat())
    const refusals = (await readFile(errors, "utf8")).trim().split("\n")
    assert.equal(refusals.length, statuses.length)
    assert.equal(refusals.every((line) => line.includes("tests run in GitHub CI")), true)
    assert.deepEqual((await readFile(starts, "utf8")).trim().split("\n"), Array.from({ length: 3 }, () => permitted).flat())
    assert.equal((result.stderr.match(/skipped local commands:/g) ?? []).length, 1)
    const outside = Bun.spawn([join(env["ORC_HOME"] ?? "", "heavy", "bin", "bun"), "test"], {
      cwd: repo, env, stdout: "pipe", stderr: "pipe"
    })
    const outsideError = await new Response(outside.stderr).text()
    assert.equal(await outside.exited, 0, outsideError)
    assert.equal((await readFile(starts, "utf8")).trim().split("\n").at(-1), "bun test")
  })
}

if (import.meta.main) {
  await exerciseCiOnlyHostPi()
  console.log("Pi probes passed (--sandbox none): implementer, two fixers; permitted checks and non-worker tests preserved")
}
