import { describe, expect, test } from "bun:test"
import runManifest from "../../packages/run/package.json" with { type: "json" }

const packageDir = new URL("../../packages/run/", import.meta.url).pathname

const expectedFiles = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "agents/decider-policy.md",
  "agents/fixer.md",
  "agents/implementer.md",
  "package.json",
  "scripts/patch-knip-jiti.ts",
  "src/agent-exec.ts",
  "src/agents.ts",
  "src/answer-wait.ts",
  "src/args.ts",
  "src/bin.ts",
  "src/chat-backlog.ts",
  "src/chat-board-bind.ts",
  "src/chat-board-page.ts",
  "src/chat-board.ts",
  "src/chat-closed.ts",
  "src/chat-command.ts",
  "src/chat-error.ts",
  "src/chat-inputs.ts",
  "src/chat-lavish.ts",
  "src/chat-parked.ts",
  "src/chat-posts.ts",
  "src/chat-tools.ts",
  "src/chat.ts",
  "src/checks.ts",
  "src/checkout.ts",
  "src/context-mark.ts",
  "src/delivery.ts",
  "src/direct-pr.ts",
  "src/dispatch/alert-events.ts",
  "src/dispatch/alert-stream.ts",
  "src/dispatch/args-runner.ts",
  "src/dispatch/args.ts",
  "src/dispatch/attention-view.ts",
  "src/dispatch/attention.ts",
  "src/dispatch/backlog-depend.ts",
  "src/dispatch/backlog-hold.ts",
  "src/dispatch/backlog-write.ts",
  "src/dispatch/backlog.ts",
  "src/dispatch/beat-action.ts",
  "src/dispatch/beat-close.ts",
  "src/dispatch/beat-place.ts",
  "src/dispatch/beat.ts",
  "src/dispatch/board.ts",
  "src/dispatch/chat-event.ts",
  "src/dispatch/cli-stop.ts",
  "src/dispatch/cli.ts",
  "src/dispatch/config.ts",
  "src/dispatch/decider-ask.ts",
  "src/dispatch/decider.ts",
  "src/dispatch/events.ts",
  "src/dispatch/heavy-cli.ts",
  "src/dispatch/heavy-setup.ts",
  "src/dispatch/heavy-standin-decide.ts",
  "src/dispatch/heavy-standin-runtime.ts",
  "src/dispatch/heavy-standin.ts",
  "src/dispatch/heavy-watch-slip.ts",
  "src/dispatch/heavy-watch.ts",
  "src/dispatch/heavy.ts",
  "src/dispatch/held-token.ts",
  "src/dispatch/hold.ts",
  "src/dispatch/load.ts",
  "src/dispatch/machine-reach.ts",
  "src/dispatch/merge-basis.ts",
  "src/dispatch/merge.ts",
  "src/dispatch/parked.ts",
  "src/dispatch/pr-view.ts",
  "src/dispatch/pueue-status.ts",
  "src/dispatch/quota.ts",
  "src/dispatch/refresh.ts",
  "src/dispatch/runner-error.ts",
  "src/dispatch/runner-exec.ts",
  "src/dispatch/runner-instructions.ts",
  "src/dispatch/runner-result.ts",
  "src/dispatch/runner.ts",
  "src/dispatch/stall.ts",
  "src/dispatch/task-events.ts",
  "src/dispatch/task-record-render.ts",
  "src/dispatch/task-record.ts",
  "src/dispatch/token.ts",
  "src/dispatch/upstream.ts",
  "src/gate-refusals.ts",
  "src/git-config.ts",
  "src/git-run.ts",
  "src/history-resume.ts",
  "src/history-write.ts",
  "src/host.ts",
  "src/json-file.ts",
  "src/long-session.ts",
  "src/model-route.ts",
  "src/no-mistakes-drive-log.ts",
  "src/no-mistakes-gate.ts",
  "src/no-mistakes.ts",
  "src/nono-exec.ts",
  "src/nono-profile.ts",
  "src/nono.ts",
  "src/orc-config.ts",
  "src/pi-run.ts",
  "src/pi.ts",
  "src/report-run.ts",
  "src/report.ts",
  "src/run-deliverer.ts",
  "src/run-exec.ts",
  "src/run-folders.ts",
  "src/run-history-view.ts",
  "src/run-history.ts",
  "src/run-id.ts",
  "src/run-loop.ts",
  "src/run-record.ts",
  "src/run-resume.ts",
  "src/run-scores.ts",
  "src/run-session.ts",
  "src/run.ts",
  "src/sandbox-plan.ts",
  "src/show.ts",
  "src/table.ts",
  "src/task-copy.ts",
  "src/task-kind.ts",
  "src/toon.ts",
  "src/worktree-excludes.ts"
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
