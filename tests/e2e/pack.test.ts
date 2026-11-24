import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Schema } from "effect"
import runManifest from "../../packages/run/package.json" with { type: "json" }

const packageDir = new URL("../../packages/run/", import.meta.url).pathname
const repoRoot = new URL("../../", import.meta.url).pathname

const PackReport = Schema.Tuple([Schema.Struct({
  filename: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String }))
})])

const packedTarball = (): { readonly files: ReadonlyArray<string>; readonly tarball: string } => {
  const result = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], { cwd: packageDir, timeout: 60_000 })
  if (result.exitCode !== 0) {
    throw new Error("npm pack --dry-run failed: " + result.stdout.toString() + result.stderr.toString())
  }
  const [report] = Schema.decodeSync(Schema.fromJsonString(PackReport))(result.stdout.toString())
  return { files: report.files.map((file) => file.path), tarball: report.filename }
}

let packedFiles: ReadonlyArray<string> = []
let packedTarballName = ""

beforeAll(() => {
  const result = Bun.spawnSync([process.execPath, "run", "build"], { cwd: repoRoot })
  if (result.exitCode !== 0) {
    throw new Error("bun run build failed: " + result.stdout.toString() + result.stderr.toString())
  }
  const packed = packedTarball()
  packedFiles = packed.files
  packedTarballName = packed.tarball
}, 120_000)

const expectedFiles = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "agents/decider-policy.md",
  "agents/fixer.md",
  "agents/implementer.md",
  "agents/reviewer.md",
  "dist/herdr-app/keys.json",
  "dist/herdr-app/layouts/orc.json",
  "dist/herdr-app/layouts/orc.svg",
  "dist/herdr-app/mods/orc-agents/main.js",
  "dist/herdr-app/mods/orc-agents/mod.json",
  "dist/herdr-app/mods/orc-board/main.js",
  "dist/herdr-app/mods/orc-board/mod.json",
  "dist/herdr-app/mods/orc-changes/main.js",
  "dist/herdr-app/mods/orc-changes/mod.json",
  "dist/herdr-app/mods/orc-drawer/main.js",
  "dist/herdr-app/mods/orc-drawer/mod.json",
  "dist/herdr-app/mods/orc-inbox/main.js",
  "dist/herdr-app/mods/orc-inbox/mod.json",
  "dist/herdr-app/mods/orc-resources/main.js",
  "dist/herdr-app/mods/orc-resources/mod.json",
  "dist/herdr-app/mods/orc-tabs/main.js",
  "dist/herdr-app/mods/orc-tabs/mod.json",
  "dist/herdr-app/mods/orc-task/main.js",
  "dist/herdr-app/mods/orc-task/mod.json",
  "package.json",
  "scripts/patch-knip-jiti.ts",
  "src/shared/sandbox/agent-exec.ts",
  "src/entities/agent/agents.ts",
  "src/entities/agent/failure-streak.ts",
  "src/entities/review-gate/answer-wait.ts",
  "src/features/installing-the-app/app-install.ts",
  "src/app/args.ts",
  "src/app/help-entries-backlog.ts",
  "src/app/help-entries-run.ts",
  "src/app/help-entries-runner.ts",
  "src/app/help-format.ts",
  "src/app/help.ts",
  "src/app/login-args.ts",
  "src/app/quota-cli.ts",
  "src/bin.ts",
  "src/features/chat/chat-backlog.ts",
  "src/features/chat/chat-board-bind.ts",
  "src/features/chat/chat-board-page.ts",
  "src/features/chat/chat-board.ts",
  "src/features/chat/chat-closed.ts",
  "src/features/chat/chat-command.ts",
  "src/features/chat/chat-error.ts",
  "src/features/chat/chat-inputs.ts",
  "src/features/chat/chat-lavish.ts",
  "src/features/chat/chat-parked.ts",
  "src/features/chat/chat-posts.ts",
  "src/features/chat/chat-run.ts",
  "src/features/chat/chat-task-tools.ts",
  "src/features/chat/chat-tools.ts",
  "src/features/chat/chat.ts",
  "src/features/running-a-task/checks.ts",
  "src/entities/task-copy/checkout.ts",
  "src/features/running-a-task/context-mark.ts",
  "src/shared/config/delivery.ts",
  "src/shared/config/index.ts",
  "src/entities/pull-request/ci-verdict.ts",
  "src/entities/pull-request/direct-pr.ts",
  "src/entities/events/alert-events.ts",
  "src/features/queueing-a-task/alert-stream.ts",
  "src/app/dispatch-args-answer.ts",
  "src/app/dispatch-args-heavy.ts",
  "src/app/dispatch-args-priority.ts",
  "src/app/dispatch-args-runner.ts",
  "src/app/dispatch-args.ts",
  "src/features/attention-list/attention-view.ts",
  "src/entities/attention/attention.ts",
  "src/entities/attention/attention-overdue.ts",
  "src/features/backlog-planning/backlog-depend.ts",
  "src/features/backlog-planning/backlog-drop.ts",
  "src/features/backlog-planning/backlog-edit.ts",
  "src/features/backlog-planning/backlog-hold.ts",
  "src/features/backlog-planning/backlog-plan.ts",
  "src/features/backlog-planning/backlog-priority.ts",
  "src/entities/backlog/backlog-write.ts",
  "src/entities/backlog/decision.ts",
  "src/entities/backlog/hold-history.ts",
  "src/entities/backlog/backlog.ts",
  "src/entities/backlog/index.ts",
  "src/entities/agent/index.ts",
  "src/entities/events/index.ts",
  "src/entities/token/index.ts",
  "src/entities/task-copy/index.ts",
  "src/entities/attention/beat-action.ts",
  "src/entities/attention/beat-items.ts",
  "src/widgets/beat/beat-attention.ts",
  "src/widgets/beat/beat-close.ts",
  "src/widgets/beat/beat-origin.ts",
  "src/widgets/beat/beat-place.ts",
  "src/widgets/beat/beat-resume.ts",
  "src/widgets/beat/beat-token.ts",
  "src/widgets/beat/beat-waits.ts",
  "src/widgets/beat/beat.ts",
  "src/widgets/beat/board.ts",
  "src/entities/events/chat-event.ts",
  "src/features/backlog-planning/cli-add.ts",
  "src/features/queueing-a-task/cli-stop.ts",
  "src/app/dispatch-cli.ts",
  "src/shared/config/dispatch-config.ts",
  "src/features/decider/decider-ask.ts",
  "src/features/decider/decider.ts",
  "src/features/decider/decider-guard.ts",
  "src/features/decider/recommended.ts",
  "src/features/decider/quoted-source.ts",
  "src/entities/attention/attention-item.ts",
  "src/entities/attention/failing-command.ts",
  "src/entities/backlog/task-record-answer.ts",
  "src/features/queueing-a-task/runner-answer.ts",
  "src/entities/orc-rules/orc-rules.ts",
  "src/entities/events/events.ts",
  "src/entities/events/pr-state.ts",
  "src/features/heavy-commands/heavy-cli.ts",
  "src/entities/heavy-queue/heavy-setup.ts",
  "src/entities/heavy-queue/heavy-classify.ts",
  "src/entities/heavy-queue/heavy-process-tree.ts",
  "src/entities/heavy-queue/heavy-pueue-task.ts",
  "src/entities/heavy-queue/heavy-standin-exec.ts",
  "src/entities/heavy-queue/heavy-standin-main.ts",
  "src/entities/heavy-queue/heavy-standin-runtime.ts",
  "src/entities/heavy-queue/heavy-standin.ts",
  "src/features/heavy-commands/heavy-watch-slip.ts",
  "src/features/heavy-commands/heavy-watch.ts",
  "src/entities/heavy-queue/heavy.ts",
  "src/entities/token/held-token.ts",
  "src/features/queueing-a-task/hold.ts",
  "src/features/backlog-planning/intake-plan.ts",
  "src/widgets/beat/load.ts",
  "src/shared/config/machine-reach.ts",
  "src/entities/pull-request/merge-basis.ts",
  "src/features/merging-a-pr/main-ci.ts",
  "src/features/merging-a-pr/merge.ts",
  "src/entities/parked-runs/parked.ts",
  "src/entities/parked-runs/repeat-hold.ts",
  "src/entities/parked-runs/send-back.ts",
  "src/entities/pull-request/pr-view.ts",
  "src/shared/process/pueue-status.ts",
  "src/widgets/beat/quota-command.ts",
  "src/widgets/beat/quota.ts",
  "src/entities/task-copy/refresh.ts",
  "src/shared/process/runner-error.ts",
  "src/shared/process/runner-exec.ts",
  "src/features/queueing-a-task/runner-instructions.ts",
  "src/features/queueing-a-task/runner-request.ts",
  "src/entities/backlog/runner-label.ts",
  "src/entities/backlog/notes.ts",
  "src/features/queueing-a-task/runner-result.ts",
  "src/features/queueing-a-task/runner.ts",
  "src/features/queueing-a-task/send-back.ts",
  "src/entities/backlog/split.ts",
  "src/widgets/beat/stall.ts",
  "src/widgets/beat/subquo.ts",
  "src/entities/backlog/task-dependency.ts",
  "src/entities/backlog/task-wait.ts",
  "src/widgets/beat/task-events.ts",
  "src/entities/backlog/task-record-render.ts",
  "src/entities/backlog/task-record.ts",
  "src/entities/token/token.ts",
  "src/widgets/beat/index.ts",
  "src/widgets/beat/upstream.ts",
  "src/entities/run-history/gate-refusals.ts",
  "src/shared/sandbox/git-config.ts",
  "src/shared/process/git-run.ts",
  "src/entities/run-history/history-resume.ts",
  "src/features/running-a-task/fix-guidance.ts",
  "src/features/running-a-task/history-write.ts",
  "src/features/running-a-task/index.ts",
  "src/features/running-a-task/loop-pause.ts",
  "src/features/running-a-task/worker-question.ts",
  "src/shared/sandbox/host.ts",
  "src/shared/config/json-file.ts",
  "src/entities/agent/long-session.ts",
  "src/entities/agent/orc-ask-extension.ts",
  "src/entities/agent/worker-ask.ts",
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
  "src/features/running-a-task/review-turn.ts",
  "src/features/running-a-task/run-args.ts",
  "src/entities/run-history/report.ts",
  "src/features/running-a-task/run-deliverer.ts",
  "src/features/running-a-task/run-exec.ts",
  "src/features/running-a-task/run-finish.ts",
  "src/features/running-a-task/run-folders.ts",
  "src/features/seeing-runs/run-facts.ts",
  "src/features/seeing-runs/run-history-view.ts",
  "src/entities/run-history/run-history-read.ts",
  "src/entities/run-history/run-history.ts",
  "src/shared/lib/run-id.ts",
  "src/features/running-a-task/run-loop.ts",
  "src/features/running-a-task/run-ops.ts",
  "src/features/running-a-task/run-place.ts",
  "src/features/running-a-task/run-prepare.ts",
  "src/features/running-a-task/run-record.ts",
  "src/features/running-a-task/run-resume.ts",
  "src/features/seeing-runs/run-scores.ts",
  "src/shared/lib/run-session.ts",
  "src/features/running-a-task/run.ts",
  "src/shared/sandbox/sandbox-kind.ts",
  "src/features/running-a-task/sandbox-plan.ts",
  "src/features/seeing-runs/show.ts",
  "src/features/seeing-runs/step-log.ts",
  "src/shared/sandbox/standin-dir.ts",
  "src/shared/lib/table.ts",
  "src/entities/task-copy/task-copy.ts",
  "src/entities/backlog/task-kind.ts",
  "src/entities/backlog/task-record-decision.ts",
  "src/entities/backlog/task-record-question.ts",
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
  "src/entities/orc-rules/index.ts",
  "src/features/queueing-a-task/index.ts",
  "src/features/chat/index.ts",
  "src/features/backlog-planning/index.ts",
  "src/features/heavy-commands/index.ts",
  "src/features/installing-the-app/index.ts",
  "src/features/attention-list/index.ts",
  "src/features/decider/index.ts",
  "src/features/merging-a-pr/index.ts",
  "src/features/seeing-runs/index.ts",
  "src/features/seeing-runs/machine-versions.ts",
  "src/features/seeing-runs/other-machines.ts",
  "src/features/signing-in/index.ts",
  "src/features/signing-in/private-window.ts",
  "src/features/signing-in/sign-in.ts",
  "src/features/task-thread/index.ts",
  "src/features/task-thread/note.ts",
  "src/features/task-thread/thread.ts",
  "src/features/updating-orc/index.ts",
  "src/features/updating-orc/update.ts"
]

describe("the npm pack dry run", () => {
  test("the scoped tarball keeps every file the orc tarball held instead of dropping the copied changelog", () => {
    expect([...packedFiles].sort()).toEqual([...expectedFiles].sort())
  }, 60_000)

  test("the tarball takes the scoped name instead of the taken orc name", () => {
    expect(packedTarballName).toBe(`avi2dg-orc-${runManifest.version}.tgz`)
  }, 60_000)

  test("the tarball holds the file the orc bin entry names", () => {
    expect(packedFiles).toContain(runManifest.bin.orc)
  }, 60_000)
})

describe("the run manifest", () => {
  test("names the repository in the form npm's trusted publish matches against the workflow's repository", () => {
    expect(runManifest.repository).toEqual({ type: "git", url: "git+https://github.com/avi2d/orc.git" })
  })
})

const spawnPassing = (command: ReadonlyArray<string>, cwd: string, env: Record<string, string | undefined> = Bun.env): string => {
  const result = Bun.spawnSync([...command], { cwd, env, stdin: "ignore", timeout: 60_000 })
  if (result.exitCode !== 0) {
    throw new Error(command.join(" ") + " failed: " + result.stdout.toString() + result.stderr.toString())
  }
  return result.stdout.toString()
}

describe("the packed tarball installed into an empty project without orc's lockfile", () => {
  let project = ""

  beforeAll(async () => {
    project = await mkdtemp(join(tmpdir(), "orc-clean-install-"))
    const report = spawnPassing(["npm", "pack", "--json", "--pack-destination", project], packageDir)
    const [packed] = Schema.decodeSync(Schema.fromJsonString(PackReport))(report)
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "orc-clean-install", private: true }))
    spawnPassing([process.execPath, "add", join(project, packed.filename)], project)
  }, 180_000)

  afterAll(async () => {
    await rm(project, { recursive: true, force: true })
  })

  test("orc --help prints its usage instead of failing on an effect module a newer resolved dependency asks for", () => {
    const path = dirname(process.execPath) + ":" + (Bun.env["PATH"] ?? "")
    const stdout = spawnPassing([join(project, "node_modules", ".bin", "orc"), "--help"], project, { PATH: path, HOME: project })
    expect(stdout).toContain("Usage: orc <command>")
  }, 90_000)
})
