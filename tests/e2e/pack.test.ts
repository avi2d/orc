import { describe, expect, test } from "bun:test"
import runManifest from "../../packages/run/package.json" with { type: "json" }

const packageDir = new URL("../../packages/run/", import.meta.url).pathname

const expectedFiles = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "agents/fixer.md",
  "agents/implementer.md",
  "package.json",
  "scripts/patch-knip-jiti.ts",
  "src/agents.ts",
  "src/args.ts",
  "src/bin.ts",
  "src/checks.ts",
  "src/context-mark.ts",
  "src/dispatch/args.ts",
  "src/dispatch/backlog.ts",
  "src/dispatch/beat.ts",
  "src/dispatch/board.ts",
  "src/dispatch/cli.ts",
  "src/dispatch/config.ts",
  "src/dispatch/held-token.ts",
  "src/dispatch/hold.ts",
  "src/dispatch/pueue-status.ts",
  "src/dispatch/quota.ts",
  "src/dispatch/runner-result.ts",
  "src/dispatch/runner.ts",
  "src/dispatch/task-record.ts",
  "src/dispatch/token.ts",
  "src/git-config.ts",
  "src/git-run.ts",
  "src/history-resume.ts",
  "src/history-write.ts",
  "src/host.ts",
  "src/json-file.ts",
  "src/long-session.ts",
  "src/model-route.ts",
  "src/no-mistakes-gate.ts",
  "src/no-mistakes.ts",
  "src/no-sandbox.ts",
  "src/nono-profile.ts",
  "src/nono.ts",
  "src/orc-config.ts",
  "src/pi.ts",
  "src/report.ts",
  "src/run-history.ts",
  "src/run-loop.ts",
  "src/run-record.ts",
  "src/run-resume.ts",
  "src/run-scores.ts",
  "src/run-session.ts",
  "src/run.ts",
  "src/sandbox-plan.ts",
  "src/show.ts",
  "src/toon.ts"
]

const packedTarball = (): { readonly files: ReadonlyArray<string>; readonly tarball: string } => {
  const result = Bun.spawnSync([process.execPath, "pm", "pack", "--dry-run"], { cwd: packageDir })
  const text = result.stdout.toString() + result.stderr.toString()
  if (result.exitCode !== 0) {
    throw new Error("bun pm pack --dry-run failed: " + text)
  }
  const files = text
    .split("\n")
    .filter((line) => line.startsWith("packed "))
    .map((line) => line.split(/\s+/).at(-1) ?? "")
    .filter((file) => file !== "")
  const tarball = text.split("\n").map((line) => line.trim()).find((line) => /^[A-Za-z0-9][^/]*[.]tgz$/.test(line)) ?? ""
  return { files, tarball }
}

describe("the trial pack", () => {
  test("the scoped tarball keeps every file the orc tarball held instead of dropping the copied changelog", () => {
    expect([...packedTarball().files].sort()).toEqual([...expectedFiles].sort())
  })

  test("the tarball takes the scoped name instead of the taken orc name", () => {
    expect(packedTarball().tarball).toBe(`avi2dg-orc-${runManifest.version}.tgz`)
  })
})
