import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { git, prUrl, runOrc, withNoSandboxFixture, writeScript } from "./no-sandbox-fixture"
import { exerciseCiOnlyHostPi } from "./ci-only-worker-fixture"

test("--sandbox none Pi never starts checks-test or other recognized runners while permitted checks and non-worker tests still run", exerciseCiOnlyHostPi, 60_000)

test.each([
  { verdict: "checks-passed", exitCode: 0 },
  { verdict: "failed", exitCode: 1 }
].flatMap((ci) => [
  { config: "local checks", localNames: ["prepare", "build", "lint", "typecheck"], skippedNames: ["test", "verify"] },
  { config: "test only", localNames: [], skippedNames: ["test"] },
  { config: "custom check only", localNames: [], skippedNames: ["verify"] },
  { config: "prepare only", localNames: ["prepare"], skippedNames: [] }
].map((checks) => ({ ...ci, ...checks }))))("orc skips local test runners with $config without recording an empty round as passed and exits $exitCode for CI outcome $verdict", async ({ verdict, exitCode, localNames, skippedNames }) => {
  await withNoSandboxFixture(async ({ repo, fakeBin, env }) => {
    const trace = join(fakeBin, "spawn-trace")
    const record = (name: string) => "echo " + name + " >> '" + trace + "'"
    await writeScript(join(fakeBin, "fixture-test-runner"), [record("test-runner")])
    await writeFile(join(repo, ".no-mistakes.yaml"), [
      "commands:",
      ...localNames.map((name) => "  " + name + ": " + record(name)),
      ...skippedNames.map((name) => "  " + name + ": fixture-test-runner"),
      ""
    ].join("\n"))
    git(repo, ["commit", "-qam", "Configure fixture checks"], env)
    await writeScript(join(fakeBin, "no-mistakes"), [
      'if [ "$1" = --version ]; then echo "no-mistakes version 1.111.0"; exit; fi',
      'case "$2" in',
      "  run)",
      "    " + record("review"),
      '    case " $* " in *" --skip test,rebase,ci "*) ;; *) fixture-test-runner ;; esac',
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
    expect((await readFile(trace, "utf8")).trim().split("\n")).toEqual([...localNames, "review", "review-response"])
    expect(result.stdout).toContain(prUrl)
    expect(result.exitCode).toBe(exitCode)
    if (skippedNames.length > 0) {
      expect(result.stderr).toContain("skipped local commands: " + skippedNames.join(", "))
    }
    expect(result.stderr).toContain("GitHub CI decides completion.")
    const noLocalChecks = !localNames.some((name) => name !== "prepare")
    const orcHome = env["ORC_HOME"] ?? ""
    const db = new Database(join(orcHome, "orc.sqlite"), { readonly: true })
    try {
      expect(db.query("SELECT status FROM steps WHERE name = 'checks'").all()).toEqual([{ status: noLocalChecks ? "skipped" : "passed" }])
    } finally {
      db.close()
    }
    if (noLocalChecks) {
      expect(result.stdout).toContain("checks: no local checks run")
      expect(result.stdout).toContain("No local checks ran.")
      expect(result.stdout).not.toContain("checks passed")
      expect(result.stdout).toContain("status: " + (exitCode === 0 ? "completed" : "no-mistakes failed"))
      const runIds = await readdir(join(orcHome, "runs"))
      expect(runIds).toHaveLength(1)
      for (const runId of runIds) {
        const runDir = join(orcHome, "runs", runId)
        expect(await readFile(join(runDir, "report.md"), "utf8")).toContain("checks round 1: skipped, no local checks run")
        expect(await readFile(join(runDir, "session", "checks-1.txt"), "utf8")).toBe("No local checks ran. GitHub CI decides completion.\n")
      }
    }
  })
}, 60_000)
