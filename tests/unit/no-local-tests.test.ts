import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path, Result, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { askSetupFor, type AgentFile } from "../../packages/run/src/entities/agent/index"
import { subprocessNoMistakesRunner } from "../../packages/run/src/entities/review-gate/no-mistakes"
import { installCopy } from "../../packages/run/src/features/running-a-task/run-exec"
import { runFull } from "../../packages/run/src/features/running-a-task/run-loop"
import type { RunCheckpoints, SandboxOps } from "../../packages/run/src/features/running-a-task/run-ops"
import type { HistoryRun } from "../../packages/run/src/features/running-a-task/run-record"
import { hostExec, streamShellInAgent, type AgentExec } from "../../packages/run/src/shared/sandbox/agent-exec"

const agent = (kind: "implementer" | "fixer"): AgentFile => ({
  kind, model: "opencode-go/muse-spark", thinking: "high", tools: ["read"], body: "Do the task.", path: "bundled/" + kind + ".md", source: "bundled"
})

const passedReview = [
  "run:",
  "  id: \"01STUB\"",
  "  branch: orc/test",
  "  status: completed",
  "  head: abc1234",
  "  pr: \"https://github.com/o/r/pull/7\"",
  "  findings: none",
  "outcome: checks-passed",
  "steps[2]{step,status,findings,duration_ms}:",
  "  review,completed,0,10",
  "  ci,completed,0,10"
].join("\n")

const reviewGate = [
  "gate: review",
  "findings[1]{id,severity,file,line,action,description}:",
  "  R1,warning,README.md,1,auto-fix,Fix a typo"
].join("\n")

const recordingSpawner = (spawned: Array<ReadonlyArray<string>>) =>
  ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected piped command")
    spawned.push([command.command, ...command.args])
    const reply = command.command !== "no-mistakes"
      ? ""
      : (command.args[1] === "run" ? reviewGate : passedReview)
    const output = Stream.make(new TextEncoder().encode(reply))
    return Effect.succeed(ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: output,
      stderr: Stream.empty,
      all: output,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void)
    }))
  })

const noCheckpoints: RunCheckpoints = {
  implementStart: () => Effect.void,
  implementSession: () => Effect.void,
  implementDone: () => Effect.void,
  checksRoundStart: () => Effect.void,
  checksRoundDone: () => Effect.void,
  fixStart: () => Effect.void,
  fixSession: () => Effect.void,
  fixDone: () => Effect.void,
  noMistakesStart: () => Effect.void,
  noMistakesDone: () => Effect.void,
  pullRequestStart: () => Effect.void,
  pullRequestDone: () => Effect.void,
  questionAsked: () => Effect.void
}

const freshPlan = { implementSessionId: null, implementSessionFile: null, inheritedImplement: null, skipImplement: false, skipChecks: false, allow: [], answers: [], inheritedRounds: [], inheritedFixes: [], fixSessionId: null, fixSessionFile: null, fixRunning: false, handover: null, priorDir: null }

const runPipeline = (project: string, home: string, sandbox: AgentExec["kind"]) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawned: Array<ReadonlyArray<string>> = []
    const spawner = recordingSpawner(spawned)
    const runDir = path.join(home, "runs", "guard-1")
    const sessionsDir = path.join(runDir, "sessions")
    const run: HistoryRun = {
      fs, path, spawner, git: "/usr/bin/git", projectDir: project, runId: "guard-1", runDir,
      piSessionDir: path.join(runDir, "session"), hostSessionsDir: sessionsDir, taskPath: path.join(runDir, "task.md"),
      instructions: null, agent: agent("implementer"), fixer: agent("fixer"), branch: "orc/test", sandbox, started: "2026-11-21T10:00:00.000Z",
      asks: askSetupFor(runDir, path.join(runDir, "session"), 0, [], []),
      worktreeDir: project, machine: null,
      delivery: { kind: "no-mistakes", runner: subprocessNoMistakesRunner({ spawner, binary: "no-mistakes", pathEnv: "", git: "/usr/bin/git", worktreeDir: project }) }
    }
    yield* fs.makeDirectory(sessionsDir, { recursive: true }).pipe(Effect.orDie)
    yield* fs.writeFileString(run.taskPath, "Do the task.\n").pipe(Effect.orDie)
    const host = hostExec(project, process.env, {})
    const exec: AgentExec = sandbox === "none"
      ? host
      : { ...host, kind: "nono", nonoBinary: "nono", profilePath: join(home, "profile.json") }
    const agentRuns: Array<string> = []
    const ops: SandboxOps = {
      runAgent: (request) => {
        agentRuns.push(request.agent.kind)
        return fs.writeFileString(path.join(sessionsDir, "2026-11-21T10-01-00-000Z_s1.jsonl"), JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done\nORC_COMPLETE" }] } }) + "\n").pipe(
          Effect.orDie,
          Effect.as({ sessionId: "s1", sessionFile: path.join(sessionsDir, "2026-11-21T10-01-00-000Z_s1.jsonl"), end: { kind: "exited", exitCode: 0 } as const, commits: [{ sha: "c1" }] })
        )
      },
      execCheck: (command, onOutput) => streamShellInAgent(spawner, exec, command, onOutput)
    }
    const result = yield* Effect.gen(function*() {
      yield* installCopy(spawner, fs, path, exec, join(runDir, "prepare.log"))
      return yield* runFull(run, ops, freshPlan, noCheckpoints)
    }).pipe(Effect.result)
    return { result, spawned, agentRuns, taskPath: run.taskPath }
  }).pipe(Effect.provide(BunServices.layer))

const fixtureCases = [
  { forbidden: "bunx checks-test --changed --parallel", invocation: "bunx checks-test --changed --parallel", allowed: "bunx oxlint tests/e2e" },
  { forbidden: "bun run checks-test --changed --parallel", invocation: "bun run checks-test --changed --parallel", allowed: "bun run lint" },
  { forbidden: "bun run ./node_modules/.bin/checks-test", invocation: "bun run ./node_modules/.bin/checks-test", allowed: "bun run lint" },
  { forbidden: "./node_modules/.bin/checks-test --tier=e2e", invocation: "./node_modules/.bin/checks-test --tier=e2e", allowed: "bunx oxlint ./tests/widget.e2e.ts" },
  { forbidden: "bun test", invocation: "bun test", allowed: "bun run --cwd packages/e2e lint" },
  { forbidden: "./scripts/e2e", invocation: "./scripts/e2e", allowed: "bun run tools/e2e/build.ts" },
  { forbidden: "bun run e2e", invocation: "bun run e2e", allowed: "bunx ./tools/e2e/oxlint" },
  { forbidden: 'bun run "test:e2e"', invocation: "bun run test:e2e", allowed: "bun run build" },
  { forbidden: "bun run verify:e2e", invocation: "bun test", allowed: "bun run lint:e2e" },
  { forbidden: "pnpm -C packages/web run ci-verify", invocation: "bun test", allowed: "pnpm -C packages/web run verify-build" },
  { forbidden: "env -C packages/web bun run ci-verify", invocation: "bun test", allowed: "env -C packages/web bun run verify-build" },
  { forbidden: "bash -lc 'bun test'", invocation: "bun test", allowed: "bash -lc 'printf OK'" },
  { forbidden: "bun run verify-all", invocation: "bun test", allowed: "bun run typecheck" },
  { forbidden: "bun --filter web test", invocation: "bun --filter web test", allowed: "test -f README.md" },
  { forbidden: "bun run --cwd packages/web ci-verify", invocation: "bun test", allowed: "bun run --cwd packages/web verify-build" },
  { forbidden: "cd packages/web && bun run ci-verify", invocation: "bun test", allowed: "cd packages/web && bun run verify-build" },
  { forbidden: "bun --cwd packages/web/src run ci-verify", invocation: "bun test", allowed: "bun --cwd=packages/web/src run verify-build" },
  { forbidden: "bun run stage", invocation: "bun test", allowed: "printf 'bun test' > README.md" },
  { forbidden: "bun run poststage", invocation: "bun test", allowed: "bun run lint" },
  { forbidden: "bun install --frozen-lockfile && CI=1 bun test", invocation: "bun test", allowed: "bun install --frozen-lockfile" },
  { forbidden: "bun run lint && bun test", invocation: "bun test", allowed: "bun run lint" },
  ...[
    "bunx vitest run", "npm t", "bun run tests", "bun run tst", "bun run tests:unit",
    "npm run e2e:smoke", "pnpm run coverage", "yarn mutation", "npx jest",
    "npm exec pytest", "pnpm exec playwright test", "bun x vitest",
    "vitest run", "jest", "pytest", "go test ./...", "cargo t", "xcrun xcodebuild test",
    "bun --cwd=packages/web test", "sh -c 'bun test'", "env CI=1 bun test",
    "command bun test", "exec bun test"
  ].map((forbidden) => ({ forbidden, invocation: forbidden.includes("bun test") ? "bun test" : forbidden, allowed: "bun run lint" })),
  ...[
    "cd packages/web || exit 1; bun run ci-verify",
    "cd packages/web || bun run ci-verify",
    "if true; then cd packages/web; bun run ci-verify; fi",
    "if false; then true; else cd packages/web; bun run ci-verify; fi",
    "if true; then cd packages/web; fi; bun run ci-verify",
    "if false; then true; else cd packages/web; fi; bun run ci-verify",
    "while true; do cd packages/web; bun run ci-verify; break; done",
    "until false; do cd packages/web; bun run ci-verify; break; done",
    "for x in once; do cd packages/web; bun run ci-verify; done",
    "case web in web) cd packages/web; bun run ci-verify;; esac",
    "case web in web) cd packages/web;; esac; bun run ci-verify",
    "{ cd packages/web; bun run ci-verify; }",
    "(cd packages/web; bun run ci-verify)",
    'printf "%s" "$(cd packages/web; bun run ci-verify)"'
  ].map((forbidden) => ({
    forbidden,
    invocation: "bun test",
    allowed: forbidden.endsWith("; bun run ci-verify") || forbidden === "cd packages/web || bun run ci-verify"
      ? "cd packages/web || exit 1; bun run verify-build"
      : forbidden.replaceAll("ci-verify", "verify-build")
  }))
]

const localCommands = {
  prepare: "bun install --frozen-lockfile",
  build: "bun run build",
  lint: "bun run lint",
  typecheck: "bun run typecheck"
}

const seedProject = async (project: string, commands: Readonly<Record<string, string>>): Promise<void> => {
  await mkdir(join(project, "packages/web/src"), { recursive: true })
  await mkdir(join(project, "packages/e2e"), { recursive: true })
  await writeFile(join(project, ".no-mistakes.yaml"), Bun.YAML.stringify({ commands }))
  await writeFile(join(project, "package.json"), JSON.stringify({
    scripts: {
      "verify-all": "bun run verify-tests",
      "verify-tests": "bun test",
      "test:e2e": "checks-test --tier=e2e",
      "lint:e2e": "bunx oxlint tests/e2e",
      "verify:e2e": "bun run verify-tests",
      "verify-build": "bun test",
      stage: "bun run build",
      prestage: "bun test",
      poststage: "bun test",
      build: "bun build src/index.ts",
      lint: "bunx oxlint tests/e2e",
      typecheck: "tsc --noEmit"
    }
  }))
  await writeFile(join(project, "packages/web/package.json"), JSON.stringify({
    scripts: { "ci-verify": "bun run test-child", "test-child": "bun test", "verify-build": "bun run build.ts" }
  }))
}

const shellPrefix = (sandbox: AgentExec["kind"], home: string): ReadonlyArray<string> =>
  sandbox === "none"
    ? ["sh", "-c"]
    : ["nono", "run", "--silent", "--profile", join(home, "profile.json"), "--", "sh", "-c"]

for (const sandbox of ["none", "nono"] as const) {
  describe("the steps of a " + sandbox + " run and its review handoff", () => {
    for (const name of ["prepare", "build", "lint", "typecheck"] as const) {
      test.each(fixtureCases)("rejects a pipeline that spawns $forbidden in " + name + " instead of silently skipping it", async (fixture) => {
        const home = await mkdtemp(join(tmpdir(), "orc-spawn-"))
        try {
          const project = join(home, "project")
          await seedProject(project, { ...localCommands, [name]: fixture.forbidden })
          const { result, spawned, agentRuns } = await Effect.runPromise(runPipeline(project, home, sandbox))
          if (Result.isSuccess(result)) throw new Error("Test-containing command was accepted")
          expect(String(result.failure)).toContain("refusing " + name + " command")
          expect(String(result.failure)).toContain(JSON.stringify(fixture.forbidden))
          expect(String(result.failure)).toContain(fixture.invocation)
          expect(spawned).toEqual(name === "prepare" ? [] : [
            [...shellPrefix(sandbox, home), localCommands.prepare],
            ["/usr/bin/git", "log", "-1", "--format=%s", "c1"]
          ])
          expect(agentRuns).toEqual(name === "prepare" ? [] : ["implementer"])
        } finally {
          await rm(home, { recursive: true, force: true })
        }
      })
    }

    test.each(fixtureCases)("keeps permitted $allowed checks and preparation reachable through review instead of dropping them", async (fixture) => {
      const home = await mkdtemp(join(tmpdir(), "orc-spawn-"))
      try {
        const project = join(home, "project")
        await seedProject(project, {
          ...localCommands,
          build: fixture.allowed,
          test: fixture.forbidden,
          e2e: fixture.forbidden,
          verify: fixture.forbidden
        })
        const { result, spawned, agentRuns, taskPath } = await Effect.runPromise(runPipeline(project, home, sandbox))
        if (Result.isFailure(result)) throw new Error(String(result.failure))
        expect(spawned).toEqual([
          [...shellPrefix(sandbox, home), localCommands.prepare],
          ["/usr/bin/git", "log", "-1", "--format=%s", "c1"],
          [...shellPrefix(sandbox, home), fixture.allowed],
          [...shellPrefix(sandbox, home), localCommands.lint],
          [...shellPrefix(sandbox, home), localCommands.typecheck],
          ["no-mistakes", "axi", "run", "--intent-file", taskPath, "--skip", "test"],
          [
            "no-mistakes", "axi", "respond", "--action", "fix", "--findings", "R1",
            "--instructions", "Leave repository tests to GitHub CI. Do not run them locally. You may run build, lint, or typecheck."
          ],
          ["no-mistakes", "axi", "status", "--run", "01STUB"]
        ])
        expect(agentRuns).toEqual(["implementer"])
        expect(result.success.completed).toBe(true)
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    })

    test.each(["(cd packages/web)", 'printf "%s" "$(cd packages/web)"'])("does not leak a directory change from %s into following checks", async (prefix) => {
      const home = await mkdtemp(join(tmpdir(), "orc-spawn-"))
      try {
        const project = join(home, "project")
        await seedProject(project, { ...localCommands, build: prefix + "; bun run verify-all" })
        await writeFile(join(project, "package.json"), JSON.stringify({ scripts: { "verify-all": "bun run build.ts" } }))
        await writeFile(join(project, "packages/web/package.json"), JSON.stringify({ scripts: { "verify-all": "bun test" } }))
        const { result, spawned } = await Effect.runPromise(runPipeline(project, home, sandbox))
        if (Result.isFailure(result)) throw new Error(String(result.failure))
        expect(spawned).toContainEqual([...shellPrefix(sandbox, home), prefix + "; bun run verify-all"])
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    })
  })
}
