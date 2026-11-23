import { expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { git, prUrl, runOrc, withNoSandboxFixture, writeScript } from "./no-sandbox-fixture"

test.each([
  { verdict: "checks-passed", exitCode: 0 },
  { verdict: "failed", exitCode: 1 }
])("orc skips local test runners in both check and review steps and exits $exitCode for CI outcome $verdict", async ({ verdict, exitCode }) => {
  await withNoSandboxFixture(async ({ repo, fakeBin, env }) => {
    const trace = join(fakeBin, "spawn-trace")
    const record = (name: string) => "echo " + name + " >> '" + trace + "'"
    await writeScript(join(fakeBin, "fixture-test-runner"), [record("test-runner")])
    await writeFile(join(repo, ".no-mistakes.yaml"), [
      "commands:",
      ...["prepare", "build", "lint", "typecheck"].map((name) => "  " + name + ": " + record(name)),
      "  test: fixture-test-runner",
      "  verify: fixture-test-runner",
      ""
    ].join("\n"))
    git(repo, ["commit", "-qam", "Configure fixture checks"], env)
    await writeScript(join(fakeBin, "no-mistakes"), [
      'if [ "$1" = --version ]; then echo "no-mistakes version 1.111.0"; exit; fi',
      'case "$2" in',
      "  run)",
      "    " + record("review"),
      '    case " $* " in *" --skip test "*) ;; *) fixture-test-runner ;; esac',
      '    printf "%s\\n" "gate: review" "findings[1]{id,severity,file,line,action,description}:" "  R1,warning,greeting.txt,1,auto-fix,revise greeting"',
      "    ;;",
      "  respond)",
      "    " + record("review-response"),
      '    printf "%s\\n" "pr: ' + prUrl + '" "outcome: ' + verdict + '"',
      "    ;;",
      "  *) exit 2 ;;",
      "esac"
    ])
    const result = await runOrc(["run", "task.md", "--branch", "orc/test", "--sandbox", "none"], repo, env)
    expect((await readFile(trace, "utf8")).trim().split("\n")).toEqual(["prepare", "build", "lint", "typecheck", "review", "review-response"])
    expect(result.stdout).toContain(prUrl)
    expect(result.exitCode).toBe(exitCode)
  })
}, 60_000)
