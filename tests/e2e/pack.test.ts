import { beforeAll, describe, expect, test } from "bun:test"
import runManifest from "../../packages/run/package.json" with { type: "json" }

const packageDir = new URL("../../packages/run/", import.meta.url).pathname
const repoRoot = new URL("../../", import.meta.url).pathname

beforeAll(() => {
  const result = Bun.spawnSync([process.execPath, "run", "build"], { cwd: repoRoot })
  if (result.exitCode !== 0) {
    throw new Error("bun run build failed: " + result.stdout.toString() + result.stderr.toString())
  }
}, 120_000)

const expectedFiles = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "agents/decider-policy.md",
  "agents/fixer.md",
  "agents/implementer.md",
  "dist/herdr-app/keys.json",
  "dist/herdr-app/layouts/orc.json",
  "dist/herdr-app/layouts/orc.svg",
  "dist/herdr-app/mods/orc-agents/main.js",
  "dist/herdr-app/mods/orc-agents/mod.json",
  "dist/herdr-app/mods/orc-board/main.js",
  "dist/herdr-app/mods/orc-board/mod.json",
  "dist/herdr-app/mods/orc-resources/main.js",
  "dist/herdr-app/mods/orc-resources/mod.json",
  "dist/herdr-app/mods/orc-tabs/main.js",
  "dist/herdr-app/mods/orc-tabs/mod.json",
  "package.json",
  "scripts/patch-knip-jiti.ts",
  "src/shared/sandbox/agent-exec.ts",
  "src/entities/agent/agents.ts",
  "src/entities/review-gate/answer-wait.ts",
  "src/app-install.ts",
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
  "src/features/running-a-task/checks.ts",
  "src/entities/task-copy/checkout.ts",
  "src/features/running-a-task/context-mark.ts",
  "src/shared/config/delivery.ts",
  "src/shared/config/index.ts",
  "src/entities/pull-request/direct-pr.ts",
  "src/entities/events/alert-events.ts",
  "src/features/queueing-a-task/alert-stream.ts",
  "src/dispatch/args-runner.ts",
  "src/dispatch/args.ts",
  "src/dispatch/attention-view.ts",
  "src/entities/attention/attention.ts",
  "src/dispatch/backlog-depend.ts",
  "src/dispatch/backlog-hold.ts",
  "src/dispatch/backlog-plan.ts",
  "src/entities/backlog/backlog-write.ts",
  "src/entities/backlog/backlog.ts",
  "src/entities/backlog/index.ts",
  "src/entities/agent/index.ts",
  "src/entities/events/index.ts",
  "src/entities/token/index.ts",
  "src/entities/task-copy/index.ts",
  "src/entities/attention/beat-action.ts",
  "src/dispatch/beat-attention.ts",
  "src/dispatch/beat-close.ts",
  "src/dispatch/beat-place.ts",
  "src/dispatch/beat.ts",
  "src/dispatch/board.ts",
  "src/entities/events/chat-event.ts",
  "src/dispatch/cli-add.ts",
  "src/features/queueing-a-task/cli-stop.ts",
  "src/dispatch/cli.ts",
  "src/shared/config/dispatch-config.ts",
  "src/dispatch/decider-ask.ts",
  "src/dispatch/decider.ts",
  "src/entities/events/events.ts",
  "src/dispatch/heavy-cli.ts",
  "src/entities/heavy-queue/heavy-setup.ts",
  "src/entities/heavy-queue/heavy-classify.ts",
  "src/entities/heavy-queue/heavy-process-tree.ts",
  "src/entities/heavy-queue/heavy-pueue-task.ts",
  "src/entities/heavy-queue/heavy-standin-exec.ts",
  "src/entities/heavy-queue/heavy-standin-main.ts",
  "src/entities/heavy-queue/heavy-standin-runtime.ts",
  "src/entities/heavy-queue/heavy-standin.ts",
  "src/dispatch/heavy-watch-slip.ts",
  "src/dispatch/heavy-watch.ts",
  "src/entities/heavy-queue/heavy.ts",
  "src/entities/token/held-token.ts",
  "src/features/queueing-a-task/hold.ts",
  "src/dispatch/intake-plan.ts",
  "src/dispatch/load.ts",
  "src/shared/config/machine-reach.ts",
  "src/entities/pull-request/merge-basis.ts",
  "src/dispatch/merge.ts",
  "src/entities/parked-runs/parked.ts",
  "src/entities/pull-request/pr-view.ts",
  "src/shared/process/pueue-status.ts",
  "src/dispatch/quota.ts",
  "src/entities/task-copy/refresh.ts",
  "src/shared/process/runner-error.ts",
  "src/shared/process/runner-exec.ts",
  "src/features/queueing-a-task/runner-instructions.ts",
  "src/entities/backlog/runner-label.ts",
  "src/features/queueing-a-task/runner-result.ts",
  "src/features/queueing-a-task/runner.ts",
  "src/entities/backlog/split.ts",
  "src/dispatch/stall.ts",
  "src/entities/backlog/task-dependency.ts",
  "src/dispatch/task-events.ts",
  "src/entities/backlog/task-record-render.ts",
  "src/entities/backlog/task-record.ts",
  "src/entities/token/token.ts",
  "src/dispatch/upstream.ts",
  "src/entities/run-history/gate-refusals.ts",
  "src/shared/sandbox/git-config.ts",
  "src/shared/process/git-run.ts",
  "src/entities/run-history/history-resume.ts",
  "src/features/running-a-task/history-write.ts",
  "src/features/running-a-task/index.ts",
  "src/shared/sandbox/host.ts",
  "src/shared/config/json-file.ts",
  "src/entities/agent/long-session.ts",
  "src/shared/config/model-route.ts",
  "src/entities/review-gate/no-mistakes-drive-log.ts",
  "src/entities/review-gate/no-mistakes-gate.ts",
  "src/entities/review-gate/no-mistakes.ts",
  "src/shared/sandbox/nono-exec.ts",
  "src/shared/sandbox/nono-profile.ts",
  "src/shared/sandbox/nono.ts",
  "src/shared/config/orc-config.ts",
  "src/entities/agent/pi-run.ts",
  "src/entities/agent/pi.ts",
  "src/features/running-a-task/report-run.ts",
  "src/entities/run-history/report.ts",
  "src/features/running-a-task/run-deliverer.ts",
  "src/features/running-a-task/run-exec.ts",
  "src/features/running-a-task/run-folders.ts",
  "src/run-history-view.ts",
  "src/entities/run-history/run-history.ts",
  "src/shared/lib/run-id.ts",
  "src/features/running-a-task/run-loop.ts",
  "src/features/running-a-task/run-record.ts",
  "src/features/running-a-task/run-resume.ts",
  "src/run-scores.ts",
  "src/shared/lib/run-session.ts",
  "src/features/running-a-task/run.ts",
  "src/shared/sandbox/sandbox-kind.ts",
  "src/features/running-a-task/sandbox-plan.ts",
  "src/show.ts",
  "src/shared/sandbox/standin-dir.ts",
  "src/shared/lib/table.ts",
  "src/entities/task-copy/task-copy.ts",
  "src/entities/backlog/task-kind.ts",
  "src/shared/lib/index.ts",
  "src/shared/process/index.ts",
  "src/shared/sandbox/index.ts",
  "src/shared/lib/toon.ts",
  "src/entities/task-copy/worktree-excludes.ts",
  "src/entities/heavy-queue/index.ts",
  "src/entities/review-gate/index.ts",
  "src/entities/pull-request/index.ts",
  "src/entities/attention/index.ts",
  "src/entities/run-history/index.ts",
  "src/entities/parked-runs/index.ts",
  "src/features/queueing-a-task/index.ts"
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
